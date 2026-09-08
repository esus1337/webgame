import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/game/mapgen';
import * as C from '../src/game/config';
import { hexToRgb } from '../src/core/color';
import type { WorldMap } from '../src/game/types';

const SEEDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', '12345', 'a'];

function worlds(): WorldMap[] {
  return SEEDS.map((seed) => generateWorld({ seed }));
}

describe('generateWorld', () => {
  it('is deterministic for a given seed', () => {
    const a = generateWorld({ seed: 'repeatable' });
    const b = generateWorld({ seed: 'repeatable' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different worlds for different seeds', () => {
    const a = generateWorld({ seed: 'one' });
    const b = generateWorld({ seed: 'two' });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('generates enough provinces on every seed', () => {
    for (const world of worlds()) {
      expect(world.provinces.length).toBeGreaterThanOrEqual(C.MIN_LAND_PROVINCES);
    }
  });

  it('keeps adjacency symmetric and self-free', () => {
    for (const world of worlds()) {
      for (const province of world.provinces) {
        expect(province.neighbors).not.toContain(province.id);
        expect(new Set(province.neighbors).size).toBe(province.neighbors.length);
        for (const neighbor of province.neighbors) {
          expect(world.provinces[neighbor].neighbors).toContain(province.id);
        }
      }
    }
  });

  it('yields a single connected landmass, so every nation is reachable overland', () => {
    for (const world of worlds()) {
      const seen = new Set<number>([0]);
      const queue = [0];
      while (queue.length > 0) {
        const id = queue.pop()!;
        for (const neighbor of world.provinces[id].neighbors) {
          if (!seen.has(neighbor)) {
            seen.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      expect(seen.size).toBe(world.provinces.length);
    }
  });

  it('gives every province a valid owner and every nation territory', () => {
    for (const world of worlds()) {
      const sizes = new Array<number>(world.nationCount).fill(0);
      for (const province of world.provinces) {
        expect(province.initialOwner).toBeGreaterThanOrEqual(0);
        expect(province.initialOwner).toBeLessThan(world.nationCount);
        sizes[province.initialOwner]++;
      }
      expect(world.nations).toHaveLength(world.nationCount);
      for (const size of sizes) {
        expect(size).toBeGreaterThan(0);
      }
    }
  });

  it('places each capital inside its own nation', () => {
    for (const world of worlds()) {
      for (const nation of world.nations) {
        expect(world.provinces[nation.capital].initialOwner).toBe(nation.id);
      }
    }
  });

  it('gives neighbouring nations visually distinct colors', () => {
    for (const world of worlds()) {
      for (const province of world.provinces) {
        const a = province.initialOwner;
        for (const neighbor of province.neighbors) {
          const b = world.provinces[neighbor].initialOwner;
          if (a === b) continue;
          const [r1, g1, b1] = hexToRgb(world.nations[a].color);
          const [r2, g2, b2] = hexToRgb(world.nations[b].color);
          const separation = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
          expect(separation).toBeGreaterThan(40);
        }
      }
    }
  });

  it('gives every province geometry and positive yields', () => {
    for (const world of worlds()) {
      for (const province of world.provinces) {
        expect(province.polygon.length).toBeGreaterThanOrEqual(6);
        expect(province.polygon.length % 2).toBe(0);
        expect(Number.isFinite(province.cx)).toBe(true);
        expect(Number.isFinite(province.cy)).toBe(true);
        expect(province.manpower).toBeGreaterThan(0);
        expect(province.industry).toBeGreaterThan(0);
      }
    }
  });

  it('respects a requested nation count where the landmass allows', () => {
    const world = generateWorld({ seed: 'counted', nationCount: 8 });
    expect(world.nationCount).toBeLessThanOrEqual(8);
    expect(world.nationCount).toBeGreaterThanOrEqual(4);
  });
});
