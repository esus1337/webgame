import { Delaunay } from 'd3-delaunay';
import { distance, polygonArea, polygonBounds, polygonCentroid } from '../core/geometry';
import { hslToHex, hueDistance, shadeHex } from '../core/color';
import { createNoise2D, createRng, type Rng } from '../core/rng';
import * as C from './config';
import type { Terrain } from './config';
import { createNameGenerator, generateName, generateNationName } from './names';
import type { Nation, NationId, Province, ProvinceId, WorldMap } from './types';

export interface MapGenOptions {
  seed: string;
  nationCount?: number;
  cellCount?: number;
}

/** Binary min-heap for the border-growth flood fill. */
class MinHeap<T> {
  private readonly items: { cost: number; value: T }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(cost: number, value: T): void {
    const items = this.items;
    items.push({ cost, value });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].cost <= items[i].cost) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): { cost: number; value: T } | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left].cost < items[smallest].cost) smallest = left;
        if (right < items.length && items[right].cost < items[smallest].cost) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * A jittered grid rather than uniform random points: it gives Lloyd relaxation
 * a head start, so two passes are enough to produce evenly sized cells.
 */
function jitteredGrid(rng: Rng, count: number, width: number, height: number): Float64Array {
  const cols = Math.max(2, Math.round(Math.sqrt((count * width) / height)));
  const rows = Math.max(2, Math.round(count / cols));
  const cellWidth = width / cols;
  const cellHeight = height / rows;
  const coords = new Float64Array(cols * rows * 2);

  let i = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      coords[i++] = (col + 0.5 + rng.range(-0.35, 0.35)) * cellWidth;
      coords[i++] = (row + 0.5 + rng.range(-0.35, 0.35)) * cellHeight;
    }
  }
  return coords;
}

function flattenRing(ring: readonly (readonly number[])[]): number[] {
  // cellPolygon returns a closed ring; drop the repeated final vertex.
  const n = ring.length > 1 ? ring.length - 1 : ring.length;
  const flat: number[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    flat[i * 2] = ring[i][0];
    flat[i * 2 + 1] = ring[i][1];
  }
  return flat;
}

function quantile(sorted: Float64Array, q: number): number {
  const index = Math.floor(q * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

/** Cells of the largest connected land component, given a land predicate. */
function largestComponent(isLand: Uint8Array, neighbors: number[][]): number[] {
  const seen = new Uint8Array(isLand.length);
  let best: number[] = [];

  for (let start = 0; start < isLand.length; start++) {
    if (!isLand[start] || seen[start]) continue;
    const component: number[] = [];
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const cell = queue.pop()!;
      component.push(cell);
      for (const next of neighbors[cell]) {
        if (isLand[next] && !seen[next]) {
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    if (component.length > best.length) best = component;
  }

  return best;
}

function pickTerrain(rugged: number, moisture: number): Terrain {
  if (rugged > 0.68) return 'mountains';
  if (rugged > 0.57) return 'hills';
  return moisture > 0.54 ? 'forest' : 'plains';
}

/**
 * Picks well-separated starting provinces by farthest-point sampling, so
 * nations do not all begin crowded into one corner of the continent.
 */
function pickNationSeeds(provinces: Province[], count: number, rng: Rng): ProvinceId[] {
  const seeds: ProvinceId[] = [rng.int(provinces.length)];
  const best = new Float64Array(provinces.length).fill(Infinity);

  while (seeds.length < count) {
    const last = provinces[seeds[seeds.length - 1]];
    let farthest = -1;
    let farthestDistance = -1;

    for (let i = 0; i < provinces.length; i++) {
      const p = provinces[i];
      const d = distance(p.cx, p.cy, last.cx, last.cy);
      if (d < best[i]) best[i] = d;
      if (best[i] > farthestDistance) {
        farthestDistance = best[i];
        farthest = i;
      }
    }

    if (farthest < 0) break;
    seeds.push(farthest);
  }

  return seeds;
}

/**
 * Grows nation borders outward from the seeds, one province at a time, cycling
 * through the nations in round-robin.
 *
 * A plain multi-source Dijkstra lets whichever nation starts in open country
 * run away with half the continent, which leaves several others too small to
 * play. Round-robin expansion keeps sizes comparable; the per-nation `appetite`
 * reintroduces some variety (great powers and minor states) without letting any
 * nation be strangled at birth, and the jitter on each edge cost is what makes
 * the borders look organic rather than like a Voronoi diagram of the capitals.
 */
function growNations(provinces: Province[], seeds: ProvinceId[], rng: Rng): Int16Array {
  const owner = new Int16Array(provinces.length).fill(-1);
  const frontiers = seeds.map(() => new MinHeap<ProvinceId>());
  const appetite = seeds.map(() => rng.range(0.75, 1.45));
  const credit = new Float64Array(seeds.length);
  let remaining = provinces.length;

  const enqueueNeighbors = (nation: NationId, province: ProvinceId, cost: number): void => {
    const from = provinces[province];
    for (const next of from.neighbors) {
      if (owner[next] !== -1) continue;
      const to = provinces[next];
      const edge = distance(from.cx, from.cy, to.cx, to.cy) * rng.range(0.6, 1.6);
      frontiers[nation].push(cost + edge, next);
    }
  };

  seeds.forEach((province, nation) => {
    owner[province] = nation;
    remaining--;
    enqueueNeighbors(nation, province, 0);
  });

  /** Claims the cheapest province still available to this nation. */
  const claimOne = (nation: NationId): boolean => {
    const frontier = frontiers[nation];
    for (;;) {
      const entry = frontier.pop();
      if (!entry) return false;
      if (owner[entry.value] !== -1) continue;
      owner[entry.value] = nation;
      remaining--;
      enqueueNeighbors(nation, entry.value, entry.cost);
      return true;
    }
  };

  while (remaining > 0) {
    let progressed = false;
    for (let nation = 0; nation < seeds.length && remaining > 0; nation++) {
      credit[nation] += appetite[nation];
      while (credit[nation] >= 1 && remaining > 0) {
        if (!claimOne(nation)) {
          credit[nation] = 0;
          break;
        }
        credit[nation] -= 1;
        progressed = true;
      }
    }
    // Every frontier is exhausted; whatever is left is unreachable from a seed.
    if (!progressed) break;
  }

  // Anything the fill could not reach joins an already-assigned neighbour.
  for (let pass = 0; pass < 4 && remaining > 0; pass++) {
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] !== -1) continue;
      const neighbor = provinces[i].neighbors.find((n) => owner[n] !== -1);
      if (neighbor !== undefined) {
        owner[i] = owner[neighbor];
        remaining--;
      }
    }
  }
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === -1) owner[i] = 0;
  }

  return owner;
}

/** Folds undersized nations into their most-connected neighbour. */
function absorbSmallNations(provinces: Province[], owner: Int16Array, nationCount: number): number {
  for (let pass = 0; pass < 8; pass++) {
    const sizes = new Int32Array(nationCount);
    for (let i = 0; i < owner.length; i++) sizes[owner[i]]++;

    const alive = sizes.reduce((total, size) => total + (size > 0 ? 1 : 0), 0);
    if (alive <= 2) break;

    let smallest = -1;
    for (let nation = 0; nation < nationCount; nation++) {
      if (sizes[nation] === 0 || sizes[nation] >= C.MIN_NATION_SIZE) continue;
      if (smallest === -1 || sizes[nation] < sizes[smallest]) smallest = nation;
    }
    if (smallest === -1) break;

    // Absorb into whichever neighbouring nation shares the longest border.
    const contact = new Int32Array(nationCount);
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] !== smallest) continue;
      for (const next of provinces[i].neighbors) {
        if (owner[next] !== smallest) contact[owner[next]]++;
      }
    }

    let target = -1;
    for (let nation = 0; nation < nationCount; nation++) {
      if (nation === smallest || sizes[nation] === 0) continue;
      if (target === -1 || contact[nation] > contact[target]) target = nation;
    }
    if (target === -1) break;

    for (let i = 0; i < owner.length; i++) {
      if (owner[i] === smallest) owner[i] = target;
    }
  }

  // Renumber so nation ids stay dense.
  const remap = new Int16Array(nationCount).fill(-1);
  let nextId = 0;
  for (let i = 0; i < owner.length; i++) {
    if (remap[owner[i]] === -1) remap[owner[i]] = nextId++;
  }
  for (let i = 0; i < owner.length; i++) owner[i] = remap[owner[i]];

  return nextId;
}

/**
 * Golden-angle hues give an even spread; the fixup pass then pushes apart any
 * pair of *neighbouring* nations that still landed on similar colors, which is
 * the only place similarity actually hurts readability.
 */
function assignColors(
  provinces: Province[],
  owner: Int16Array,
  nationCount: number,
  rng: Rng,
): string[] {
  const hues: number[] = [];
  const saturations: number[] = [];
  const lightnesses: number[] = [];
  const start = rng.range(0, 360);

  for (let i = 0; i < nationCount; i++) {
    hues.push((start + i * 137.508 + rng.range(-8, 8)) % 360);
    saturations.push(rng.range(45, 68));
    lightnesses.push(rng.range(45, 63));
  }

  const adjacency = new Set<string>();
  for (let i = 0; i < provinces.length; i++) {
    for (const next of provinces[i].neighbors) {
      const a = owner[i];
      const b = owner[next];
      if (a !== b) adjacency.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
  }

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const pair of adjacency) {
      const [a, b] = pair.split(':').map(Number);
      if (hueDistance(hues[a], hues[b]) < 30 && Math.abs(lightnesses[a] - lightnesses[b]) < 12) {
        hues[b] = (hues[b] + 47) % 360;
        lightnesses[b] = lightnesses[b] > 54 ? lightnesses[b] - 9 : lightnesses[b] + 9;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return hues.map((hue, i) => hslToHex(hue, saturations[i], lightnesses[i]));
}

export function generateWorld(options: MapGenOptions): WorldMap {
  const { seed } = options;
  const cellCount = options.cellCount ?? C.CELL_COUNT;
  const requestedNations = Math.min(
    C.MAX_NATION_COUNT,
    Math.max(C.MIN_NATION_COUNT, options.nationCount ?? C.DEFAULT_NATION_COUNT),
  );

  const width = C.WORLD_WIDTH;
  const height = C.WORLD_HEIGHT;
  const rng = createRng(`${seed}:world`);

  // 1. Points, relaxed into evenly sized cells.
  const coords = jitteredGrid(rng, cellCount, width, height);
  let delaunay = new Delaunay(coords);
  let voronoi = delaunay.voronoi([0, 0, width, height]);
  const cells = coords.length / 2;

  for (let pass = 0; pass < C.RELAXATION_PASSES; pass++) {
    for (let i = 0; i < cells; i++) {
      const ring = voronoi.cellPolygon(i);
      if (!ring) continue;
      const [cx, cy] = polygonCentroid(flattenRing(ring));
      coords[i * 2] = cx;
      coords[i * 2 + 1] = cy;
    }
    delaunay = new Delaunay(coords);
    voronoi = delaunay.voronoi([0, 0, width, height]);
  }

  const polygons: (number[] | null)[] = [];
  const neighbors: number[][] = [];
  for (let i = 0; i < cells; i++) {
    const ring = voronoi.cellPolygon(i);
    polygons.push(ring ? flattenRing(ring) : null);
    neighbors.push([...voronoi.neighbors(i)]);
  }

  // 2. Elevation: fractal noise pulled down toward the map edges, which shapes
  //    a single central continent with an irregular coast.
  const elevationNoise = createNoise2D(`${seed}:elevation`, { octaves: 5, frequency: 2.4 });
  const scores = new Float64Array(cells);
  for (let i = 0; i < cells; i++) {
    const x = coords[i * 2];
    const y = coords[i * 2 + 1];
    const nx = x / height;
    const ny = y / height;
    const dx = (x - width / 2) / (width / 2);
    const dy = (y - height / 2) / (height / 2);
    const falloff = 0.78 * Math.pow(Math.hypot(dx, dy), 2.1);
    scores[i] = elevationNoise(nx, ny) - falloff;
  }

  const sorted = Float64Array.from(scores).sort();

  // 3. Choose a sea level, then keep only the largest landmass — guaranteeing
  //    every nation is reachable overland, which is what lets us skip navies.
  let landCells: number[] = [];
  let seaLevel = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const fraction = Math.min(0.85, C.LAND_FRACTION + attempt * 0.06);
    seaLevel = quantile(sorted, 1 - fraction);
    const isLand = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) {
      isLand[i] = scores[i] > seaLevel && polygons[i] !== null ? 1 : 0;
    }
    landCells = largestComponent(isLand, neighbors);
    if (landCells.length >= C.MIN_LAND_PROVINCES) break;
  }

  landCells.sort((a, b) => a - b);
  const cellToProvince = new Int32Array(cells).fill(-1);
  landCells.forEach((cell, index) => {
    cellToProvince[cell] = index;
  });

  // 4. Terrain and yields.
  const ruggedNoise = createNoise2D(`${seed}:rugged`, { octaves: 4, frequency: 5.5 });
  const moistureNoise = createNoise2D(`${seed}:moisture`, { octaves: 3, frequency: 4 });
  const provinceName = createNameGenerator(rng, generateName);

  const areas = landCells.map((cell) => Math.abs(polygonArea(polygons[cell]!)));
  const medianArea = [...areas].sort((a, b) => a - b)[Math.floor(areas.length / 2)] || 1;

  const provinces: Province[] = landCells.map((cell, index) => {
    const polygon = polygons[cell]!;
    const x = coords[cell * 2];
    const y = coords[cell * 2 + 1];
    const nx = x / height;
    const ny = y / height;
    const terrain = pickTerrain(ruggedNoise(nx, ny), moistureNoise(nx, ny));
    const profile = C.TERRAIN[terrain];
    const areaFactor = Math.min(1.6, Math.max(0.6, areas[index] / medianArea));

    const landNeighbors: ProvinceId[] = [];
    let coastal = false;
    for (const next of neighbors[cell]) {
      const mapped = cellToProvince[next];
      if (mapped === -1) coastal = true;
      else landNeighbors.push(mapped);
    }
    const bounds = polygonBounds(polygon);
    if (bounds.minX <= 1 || bounds.minY <= 1 || bounds.maxX >= width - 1 || bounds.maxY >= height - 1) {
      coastal = true;
    }

    return {
      id: index,
      name: provinceName(),
      polygon,
      cx: x,
      cy: y,
      bounds,
      terrain,
      neighbors: landNeighbors,
      coastal,
      manpower: C.BASE_MANPOWER * profile.manpower * areaFactor,
      industry: C.BASE_INDUSTRY * profile.industry * areaFactor,
      garrison: C.BASE_GARRISON * profile.defense,
      initialOwner: 0,
    };
  });

  // 5. Nations: seed, grow, absorb the runts, then name and color them.
  const nationTarget = Math.max(
    C.MIN_NATION_COUNT,
    Math.min(requestedNations, Math.floor(provinces.length / C.MIN_NATION_SIZE)),
  );
  const seeds = pickNationSeeds(provinces, nationTarget, rng);
  const owner = growNations(provinces, seeds, rng);
  const nationCount = absorbSmallNations(provinces, owner, seeds.length);

  for (let i = 0; i < provinces.length; i++) {
    provinces[i].initialOwner = owner[i];
  }

  const colors = assignColors(provinces, owner, nationCount, rng);
  const nationName = createNameGenerator(rng, generateNationName);
  const nations: Nation[] = [];
  const FORM_SUFFIX = ' of ';

  for (let nation = 0; nation < nationCount; nation++) {
    const held = provinces.filter((p) => owner[p.id] === nation);
    let sumX = 0;
    let sumY = 0;
    for (const p of held) {
      sumX += p.cx;
      sumY += p.cy;
    }
    const centerX = sumX / held.length;
    const centerY = sumY / held.length;

    // The capital is the province nearest the nation's centre of mass, which
    // keeps it defensible rather than stranded on a border.
    let capital = held[0];
    let bestDistance = Infinity;
    for (const p of held) {
      const d = distance(p.cx, p.cy, centerX, centerY);
      if (d < bestDistance) {
        bestDistance = d;
        capital = p;
      }
    }

    const name = nationName();
    const formIndex = name.indexOf(FORM_SUFFIX);
    nations.push({
      id: nation,
      name,
      // "Commonwealth of Slysteiaria" is too wide to label a country with, so
      // the map uses the bare place name.
      shortName: formIndex === -1 ? name : name.slice(formIndex + FORM_SUFFIX.length),
      color: colors[nation],
      borderColor: shadeHex(colors[nation], -0.45),
      capital: capital.id,
    });
  }

  // Frame on the land, with a margin so the coast is not flush to the edge.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const province of provinces) {
    if (province.bounds.minX < minX) minX = province.bounds.minX;
    if (province.bounds.minY < minY) minY = province.bounds.minY;
    if (province.bounds.maxX > maxX) maxX = province.bounds.maxX;
    if (province.bounds.maxY > maxY) maxY = province.bounds.maxY;
  }
  const margin = Math.max(maxX - minX, maxY - minY) * 0.04;
  const landBounds = {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
  };

  return {
    generation: { seed, nationCount: requestedNations, cellCount },
    seed,
    nationCount,
    width,
    height,
    landBounds,
    provinces,
    nations,
  };
}
