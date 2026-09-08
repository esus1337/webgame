import type { ProvinceId, WorldMap } from '../game/types';

/**
 * Province hit testing by color index.
 *
 * Each province is drawn once into an offscreen canvas in a color that encodes
 * its id, so a hit test is a single pixel read rather than a point-in-polygon
 * scan over hundreds of shapes. Province geometry never changes and ownership
 * does not affect it, so this is built once per world and never redrawn.
 */
export class PickingMap {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly scale: number;

  constructor(
    private readonly map: WorldMap,
    resolution = 1400,
  ) {
    this.scale = resolution / map.width;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.ceil(map.width * this.scale);
    this.canvas.height = Math.ceil(map.height * this.scale);

    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas is unavailable');
    this.context = context;
    this.draw();
  }

  private draw(): void {
    const { context, scale } = this;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);

    for (const province of this.map.provinces) {
      // Offset by one so id 0 is distinguishable from the black background.
      const code = province.id + 1;
      const r = (code >> 16) & 255;
      const g = (code >> 8) & 255;
      const b = code & 255;
      context.fillStyle = `rgb(${r},${g},${b})`;

      const { polygon } = province;
      context.beginPath();
      context.moveTo(polygon[0] * scale, polygon[1] * scale);
      for (let i = 2; i < polygon.length; i += 2) {
        context.lineTo(polygon[i] * scale, polygon[i + 1] * scale);
      }
      context.closePath();
      context.fill();
      // Stroke as well as fill: hairline gaps between neighbouring polygons
      // would otherwise read as ocean and swallow taps near a border.
      context.strokeStyle = `rgb(${r},${g},${b})`;
      context.lineWidth = 1;
      context.stroke();
    }
  }

  /** The province at a world coordinate, or null for open sea. */
  at(worldX: number, worldY: number): ProvinceId | null {
    const x = Math.round(worldX * this.scale);
    const y = Math.round(worldY * this.scale);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return null;

    const [r, g, b] = this.context.getImageData(x, y, 1, 1).data;
    const code = ((r << 16) | (g << 8) | b) - 1;
    return code >= 0 && code < this.map.provinces.length ? code : null;
  }
}
