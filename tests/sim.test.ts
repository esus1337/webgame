import { beforeEach, describe, expect, it } from 'vitest';
import * as C from '../src/game/config';
import {
  cancelOrder,
  garrisonStrength,
  orderMove,
  recruit,
  step,
  type StepOptions,
} from '../src/game/sim';
import { createGame, deserializeGame, serializeGame } from '../src/game/state';
import type { GameState, ProvinceId } from '../src/game/types';

const QUIET = { runAi: false } as const;

function newGame(seed = 'sim-fixture'): GameState {
  const state = createGame({ seed, playerNation: 0 });
  state.armies.clear();
  return state;
}

/** A province owned by `nation` that borders a province owned by someone else. */
function findFrontier(state: GameState, nation: number): [ProvinceId, ProvinceId] {
  for (let i = 0; i < state.owner.length; i++) {
    if (state.owner[i] !== nation) continue;
    for (const neighbor of state.map.provinces[i].neighbors) {
      if (state.owner[neighbor] !== nation) return [i, neighbor];
    }
  }
  throw new Error(`nation ${nation} has no frontier`);
}

function runDays(state: GameState, days: number, options: StepOptions = QUIET): void {
  for (let i = 0; i < days; i++) step(state, options);
}

describe('economy', () => {
  it('accrues manpower and industry from owned provinces', () => {
    const state = newGame();
    const nation = state.nations[0];
    const before = { manpower: nation.manpower, industry: nation.industry };

    step(state, QUIET);

    expect(nation.manpower).toBeGreaterThan(before.manpower);
    expect(nation.industry).toBeGreaterThan(before.industry);
  });

  it('pays only a fraction on occupied territory', () => {
    const state = newGame();
    const [, enemy] = findFrontier(state, 0);
    const province = state.map.provinces[enemy];
    const pool = state.nations[0];

    const dailyGain = (): number => {
      const before = pool.manpower;
      step(state, QUIET);
      return pool.manpower - before;
    };

    const baseline = dailyGain();

    // Hand the province to nation 0, for whom it is occupied territory.
    state.owner[enemy] = 0;
    const contribution = dailyGain() - baseline;

    expect(province.initialOwner).not.toBe(0);
    expect(contribution).toBeCloseTo(province.manpower * C.OCCUPIED_YIELD, 6);
    expect(contribution).toBeLessThan(province.manpower);
  });

  it('pays full value on home territory', () => {
    const state = newGame();
    const home = state.map.provinces.find(
      (p) => p.initialOwner === 0 && p.id !== state.map.nations[0].capital,
    )!;
    const pool = state.nations[0];

    const dailyGain = (): number => {
      const before = pool.manpower;
      step(state, QUIET);
      return pool.manpower - before;
    };

    // Losing the province, then taking it back, isolates its contribution.
    state.owner[home.id] = 1;
    const without = dailyGain();
    state.owner[home.id] = 0;
    const contribution = dailyGain() - without;

    expect(contribution).toBeCloseTo(home.manpower, 6);
  });
});

describe('recruitment', () => {
  it('spends from the pools and raises a stack', () => {
    const state = newGame();
    const nation = state.nations[0];
    const [home] = findFrontier(state, 0);
    const manpower = nation.manpower;
    const industry = nation.industry;

    expect(recruit(state, home)).toBe(true);

    expect(state.armies.get(home)?.strength).toBe(C.RECRUIT_BATCH);
    expect(nation.manpower).toBeCloseTo(manpower - C.RECRUIT_MANPOWER_COST);
    expect(nation.industry).toBeCloseTo(industry - C.RECRUIT_INDUSTRY_COST);
  });

  it('reinforces an existing stack rather than creating a second one', () => {
    const state = newGame();
    const [home] = findFrontier(state, 0);
    recruit(state, home);
    recruit(state, home);
    expect(state.armies.get(home)?.strength).toBe(C.RECRUIT_BATCH * 2);
  });

  it('refuses when the pools are empty', () => {
    const state = newGame();
    const [home] = findFrontier(state, 0);
    state.nations[0].manpower = 0;
    state.nations[0].industry = 0;
    expect(recruit(state, home)).toBe(false);
    expect(state.armies.has(home)).toBe(false);
  });
});

describe('orders', () => {
  it('accepts adjacent targets and rejects everything else', () => {
    const state = newGame();
    const [home, enemy] = findFrontier(state, 0);
    state.armies.set(home, { province: home, owner: 0, strength: 20, order: null });

    expect(orderMove(state, home, enemy)).toBe(true);

    const distant = state.map.provinces.find(
      (p) => p.id !== home && !state.map.provinces[home].neighbors.includes(p.id),
    )!;
    expect(orderMove(state, home, distant.id)).toBe(false);
  });

  it('cancels a standing order', () => {
    const state = newGame();
    const [home, enemy] = findFrontier(state, 0);
    state.armies.set(home, { province: home, owner: 0, strength: 20, order: null });
    orderMove(state, home, enemy);
    expect(cancelOrder(state, home)).toBe(true);
    expect(state.armies.get(home)?.order).toBeNull();
  });
});

describe('movement and capture', () => {
  it('takes an undefended enemy province and moves the stack in', () => {
    const state = newGame();
    const [home, enemy] = findFrontier(state, 0);
    const defender = state.owner[enemy];
    state.armies.set(home, { province: home, owner: 0, strength: 20, order: null });
    orderMove(state, home, enemy);

    runDays(state, 40);

    expect(defender).not.toBe(0);
    expect(state.owner[enemy]).toBe(0);
    expect(state.armies.get(enemy)?.owner).toBe(0);
    expect(state.armies.has(home)).toBe(false);
  });

  it('merges into a friendly stack instead of stacking two armies', () => {
    const state = newGame();
    const home = 0;
    const nation = state.owner[home];
    const friend = state.map.provinces[home].neighbors.find(
      (n) => state.owner[n] === nation,
    )!;

    state.armies.set(home, { province: home, owner: nation, strength: 20, order: null });
    state.armies.set(friend, { province: friend, owner: nation, strength: 5, order: null });
    orderMove(state, home, friend);

    runDays(state, 40);

    expect(state.armies.get(friend)?.strength).toBe(25);
    expect(state.armies.has(home)).toBe(false);
    expect(state.armies.size).toBe(1);
  });
});

describe('province garrisons', () => {
  it('turns back an attacker weaker than the local militia', () => {
    const state = newGame();
    const [home, enemy] = findFrontier(state, 0);
    const defender = state.owner[enemy];
    const militia = garrisonStrength(state, enemy);

    state.armies.set(home, {
      province: home,
      owner: 0,
      strength: militia - 1,
      order: null,
    });
    orderMove(state, home, enemy);

    runDays(state, 40);

    expect(state.owner[enemy]).toBe(defender);
    expect(state.armies.get(home)?.order).toBeNull();
  });

  it('charges the militia against the strength of a successful attacker', () => {
    const state = newGame();
    const [home, enemy] = findFrontier(state, 0);
    const militia = garrisonStrength(state, enemy);
    const strength = 60;

    state.armies.set(home, { province: home, owner: 0, strength, order: null });
    orderMove(state, home, enemy);

    // Measure on the day it lands: from then on it is sitting on occupied
    // ground, and attrition would confuse the reading.
    let days = 0;
    while (state.owner[enemy] !== 0 && days < 40) {
      step(state, QUIET);
      days++;
    }

    expect(state.owner[enemy]).toBe(0);
    const survivor = state.armies.get(enemy)!;
    // A day of attrition also applies the moment it lands, so allow a little slack.
    expect(survivor.strength).toBeLessThanOrEqual(strength - militia);
    expect(survivor.strength).toBeGreaterThan(strength - militia - 1);
  });

  it('resists an occupier less than its original owner', () => {
    const state = newGame();
    const [, enemy] = findFrontier(state, 0);
    const held = garrisonStrength(state, enemy);

    state.owner[enemy] = 0; // now occupied rather than owned
    const occupied = garrisonStrength(state, enemy);

    expect(occupied).toBeCloseTo(held * C.OCCUPIED_GARRISON_SCALE);
    expect(occupied).toBeLessThan(held);
  });
});

describe('combat', () => {
  it('lets an overwhelming attacker take the province', () => {
    const state = newGame();
    const [home, enemy] = findFrontier(state, 0);
    const defenderNation = state.owner[enemy];

    state.armies.set(home, { province: home, owner: 0, strength: 120, order: null });
    state.armies.set(enemy, {
      province: enemy,
      owner: defenderNation,
      strength: 8,
      order: null,
    });
    orderMove(state, home, enemy);

    runDays(state, 120);

    expect(state.owner[enemy]).toBe(0);
    expect(state.armies.get(enemy)?.owner).toBe(0);
  });

  it('holds the line when the defender is far stronger', () => {
    const state = newGame();
    const [home, enemy] = findFrontier(state, 0);
    const defenderNation = state.owner[enemy];

    state.armies.set(home, { province: home, owner: 0, strength: 10, order: null });
    state.armies.set(enemy, {
      province: enemy,
      owner: defenderNation,
      strength: 200,
      order: null,
    });
    orderMove(state, home, enemy);

    runDays(state, 60);

    expect(state.owner[enemy]).toBe(defenderNation);
  });

  it('records the provinces that saw fighting', () => {
    const state = newGame();
    const [home, enemy] = findFrontier(state, 0);
    state.armies.set(home, { province: home, owner: 0, strength: 40, order: null });
    state.armies.set(enemy, {
      province: enemy,
      owner: state.owner[enemy],
      strength: 40,
      order: null,
    });
    orderMove(state, home, enemy);

    let sawBattle = false;
    for (let i = 0; i < 40 && !sawBattle; i++) {
      step(state, QUIET);
      if (state.battles.size > 0) sawBattle = true;
    }
    expect(sawBattle).toBe(true);
  });

  it('resolves identically for identical setups', () => {
    const build = (): GameState => {
      const state = newGame();
      const [home, enemy] = findFrontier(state, 0);
      state.armies.set(home, { province: home, owner: 0, strength: 45, order: null });
      state.armies.set(enemy, {
        province: enemy,
        owner: state.owner[enemy],
        strength: 40,
        order: null,
      });
      orderMove(state, home, enemy);
      runDays(state, 60);
      return state;
    };
    expect(Array.from(build().owner)).toEqual(Array.from(build().owner));
  });
});

describe('outcomes', () => {
  it('eliminates a nation that loses its last province and ends the game', () => {
    const state = newGame();
    const victim = 1;
    for (let i = 0; i < state.owner.length; i++) {
      if (state.owner[i] === victim) state.owner[i] = 0;
    }
    step(state, QUIET);
    expect(state.nations[victim].alive).toBe(false);
    expect(state.nations[victim].provinceCount).toBe(0);
  });

  it('declares a loss when the player is wiped out', () => {
    const state = newGame();
    for (let i = 0; i < state.owner.length; i++) {
      if (state.owner[i] === 0) state.owner[i] = 1;
    }
    step(state, QUIET);
    expect(state.outcome).toBe('lost');
  });

  it('declares a win once the player holds the victory share', () => {
    const state = newGame();
    const needed = Math.ceil(state.owner.length * C.VICTORY_LAND_SHARE);
    for (let i = 0; i < needed; i++) state.owner[i] = 0;
    step(state, QUIET);
    expect(state.outcome).toBe('won');
  });

  it('stops simulating once the game is decided', () => {
    const state = newGame();
    state.outcome = 'won';
    const day = state.day;
    step(state, QUIET);
    expect(state.day).toBe(day);
  });
});

describe('saving', () => {
  let state: GameState;

  beforeEach(() => {
    state = createGame({ seed: 'save-fixture', playerNation: 2 });
    runDays(state, 30, { runAi: true });
  });

  it('round-trips through serialisation', () => {
    const restored = deserializeGame(JSON.parse(JSON.stringify(serializeGame(state))))!;

    expect(restored).not.toBeNull();
    expect(restored.day).toBe(state.day);
    expect(restored.playerNation).toBe(state.playerNation);
    expect(Array.from(restored.owner)).toEqual(Array.from(state.owner));
    expect(restored.armies.size).toBe(state.armies.size);
    expect(restored.map.provinces.length).toBe(state.map.provinces.length);
    for (const [province, army] of state.armies) {
      expect(restored.armies.get(province)?.strength).toBeCloseTo(army.strength);
    }
  });

  it('continues deterministically from a restored save', () => {
    const restored = deserializeGame(serializeGame(state))!;
    runDays(state, 40, { runAi: true });
    runDays(restored, 40, { runAi: true });
    expect(Array.from(restored.owner)).toEqual(Array.from(state.owner));
  });

  it('rejects a save from a different version', () => {
    const data = serializeGame(state);
    expect(deserializeGame({ ...data, version: 99 })).toBeNull();
  });
});
