/**
 * Deterministic pseudo-randomness. Every world is a pure function of its seed
 * string, so the same seed always rebuilds the same map — which is what lets a
 * save file be nothing more than `seed + mutable state`.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform choice from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** True with the given probability. */
  chance(probability: number): boolean;
}

/** Hashes a seed string down to a 32-bit integer (xmur3). */
export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export function createRng(seed: string | number): Rng {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);

  // mulberry32
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    range: (min, max) => min + next() * (max - min),
    pick: (items) => {
      if (items.length === 0) throw new Error('cannot pick from an empty list');
      return items[Math.floor(next() * items.length)] as never;
    },
    chance: (probability) => next() < probability,
  };
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Hash of an integer lattice point to a value in [0, 1). */
function lattice(ix: number, iy: number, seed: number): number {
  let h = seed ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);

  const v00 = lattice(x0, y0, seed);
  const v10 = lattice(x0 + 1, y0, seed);
  const v01 = lattice(x0, y0 + 1, seed);
  const v11 = lattice(x0 + 1, y0 + 1, seed);

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

export interface NoiseOptions {
  octaves?: number;
  frequency?: number;
  lacunarity?: number;
  gain?: number;
}

/**
 * Fractal (multi-octave) value noise. Returns values in [0, 1]. Stateless and
 * seeded by position, so it never consumes draws from an `Rng`.
 */
export function createNoise2D(
  seed: string | number,
  options: NoiseOptions = {},
): (x: number, y: number) => number {
  const { octaves = 4, frequency = 1, lacunarity = 2, gain = 0.5 } = options;
  const base = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);

  return (x, y) => {
    let sum = 0;
    let amplitude = 1;
    let total = 0;
    let f = frequency;

    for (let octave = 0; octave < octaves; octave++) {
      sum += amplitude * valueNoise(x * f, y * f, (base + octave * 0x9e3779b9) | 0);
      total += amplitude;
      amplitude *= gain;
      f *= lacunarity;
    }

    return sum / total;
  };
}
