/** Color maths. Kept DOM-free so map generation can pick palettes headlessly. */

export type Rgb = [number, number, number];

function hueToChannel(p: number, q: number, t: number): number {
  let h = t;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h < 1 / 6) return p + (q - p) * 6 * h;
  if (h < 1 / 2) return q;
  if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
  return p;
}

/** h in [0, 360), s and l in [0, 100]. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hn = (((h % 360) + 360) % 360) / 360;
  const sn = s / 100;
  const ln = l / 100;

  if (sn === 0) {
    const v = Math.round(ln * 255);
    return [v, v, v];
  }

  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;

  return [
    Math.round(hueToChannel(p, q, hn + 1 / 3) * 255),
    Math.round(hueToChannel(p, q, hn) * 255),
    Math.round(hueToChannel(p, q, hn - 1 / 3) * 255),
  ];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function hexToRgb(hex: string): Rgb {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function hslToHex(h: number, s: number, l: number): string {
  return rgbToHex(hslToRgb(h, s, l));
}

/** Positive amount lightens toward white, negative darkens toward black. */
export function shadeHex(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  return rgbToHex([
    Math.round(r + (target - r) * t),
    Math.round(g + (target - g) * t),
    Math.round(b + (target - b) * t),
  ]);
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Shortest angular distance between two hues, in degrees (0..180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Perceived brightness in [0, 255]; used to pick readable label colors. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
