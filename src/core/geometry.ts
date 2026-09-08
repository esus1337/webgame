/**
 * Small polygon helpers. Polygons are stored as flat `[x0, y0, x1, y1, ...]`
 * arrays — half the object churn of point tuples, and directly consumable by
 * canvas path building.
 */

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Signed area; positive for counter-clockwise winding. */
export function polygonArea(polygon: readonly number[]): number {
  const n = polygon.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += polygon[i * 2] * polygon[j * 2 + 1] - polygon[j * 2] * polygon[i * 2 + 1];
  }
  return sum / 2;
}

/**
 * Area-weighted centroid, with a vertex-average fallback for degenerate
 * (zero-area) polygons, which Voronoi clipping can occasionally produce.
 */
export function polygonCentroid(polygon: readonly number[]): [number, number] {
  const n = polygon.length / 2;
  if (n === 0) return [0, 0];

  let cx = 0;
  let cy = 0;
  let doubleArea = 0;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = polygon[i * 2];
    const yi = polygon[i * 2 + 1];
    const xj = polygon[j * 2];
    const yj = polygon[j * 2 + 1];
    const cross = xi * yj - xj * yi;
    doubleArea += cross;
    cx += (xi + xj) * cross;
    cy += (yi + yj) * cross;
  }

  if (Math.abs(doubleArea) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += polygon[i * 2];
      sy += polygon[i * 2 + 1];
    }
    return [sx / n, sy / n];
  }

  const scale = 1 / (3 * doubleArea);
  return [cx * scale, cy * scale];
}

export function polygonBounds(polygon: readonly number[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < polygon.length; i += 2) {
    const x = polygon[i];
    const y = polygon[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return { minX, minY, maxX, maxY };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
