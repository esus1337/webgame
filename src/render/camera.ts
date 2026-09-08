import { clamp, type Bounds } from '../core/geometry';

export const MAX_ZOOM = 6;

export interface Viewport {
  width: number;
  height: number;
}

/**
 * A pan/zoom transform over a region of the world. `x`/`y` are the world point
 * shown at the centre of the viewport.
 *
 * The camera is bounded by the *land*, not the full world rectangle: most of
 * the rectangle is open sea, and framing on it would leave the continent as a
 * small blob adrift in empty water.
 */
export class Camera {
  x: number;
  y: number;
  zoom = 1;
  /** Bumped on every change so the renderer knows to redraw its base layer. */
  version = 0;

  readonly worldWidth: number;
  readonly worldHeight: number;
  private readonly centerX: number;
  private readonly centerY: number;

  constructor(private readonly bounds: Bounds) {
    this.worldWidth = bounds.maxX - bounds.minX;
    this.worldHeight = bounds.maxY - bounds.minY;
    this.centerX = (bounds.minX + bounds.maxX) / 2;
    this.centerY = (bounds.minY + bounds.maxY) / 2;
    this.x = this.centerX;
    this.y = this.centerY;
  }

  /** The zoom at which the whole region just fits inside the viewport. */
  fitZoom(view: Viewport, padding = 0.96): number {
    return Math.min(view.width / this.worldWidth, view.height / this.worldHeight) * padding;
  }

  fit(view: Viewport): void {
    this.zoom = this.fitZoom(view);
    this.x = this.centerX;
    this.y = this.centerY;
    this.version++;
  }

  worldToScreenX(wx: number, view: Viewport): number {
    return (wx - this.x) * this.zoom + view.width / 2;
  }

  worldToScreenY(wy: number, view: Viewport): number {
    return (wy - this.y) * this.zoom + view.height / 2;
  }

  screenToWorldX(sx: number, view: Viewport): number {
    return (sx - view.width / 2) / this.zoom + this.x;
  }

  screenToWorldY(sy: number, view: Viewport): number {
    return (sy - view.height / 2) / this.zoom + this.y;
  }

  panBy(dxScreen: number, dyScreen: number, view: Viewport): void {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.clampToWorld(view);
  }

  /** Zooms about a fixed screen point, so the world under the cursor stays put. */
  zoomAt(factor: number, screenX: number, screenY: number, view: Viewport): void {
    const worldX = this.screenToWorldX(screenX, view);
    const worldY = this.screenToWorldY(screenY, view);
    // Never let the player zoom out past the point where the land fills the
    // view; beyond that there is nothing to see.
    const minZoom = this.fitZoom(view);
    this.zoom = clamp(this.zoom * factor, minZoom, MAX_ZOOM);
    this.x = worldX - (screenX - view.width / 2) / this.zoom;
    this.y = worldY - (screenY - view.height / 2) / this.zoom;
    this.clampToWorld(view);
  }

  centerOn(wx: number, wy: number, view: Viewport): void {
    this.x = wx;
    this.y = wy;
    this.clampToWorld(view);
  }

  /**
   * Keeps the world from sliding away entirely. When an axis is smaller than
   * the viewport it is pinned to the centre instead of clamped, otherwise the
   * map would jitter against an edge while zoomed out.
   */
  clampToWorld(view: Viewport): void {
    const halfW = view.width / 2 / this.zoom;
    const halfH = view.height / 2 / this.zoom;

    if (halfW * 2 >= this.worldWidth) {
      this.x = this.centerX;
    } else {
      this.x = clamp(this.x, this.bounds.minX + halfW, this.bounds.maxX - halfW);
    }

    if (halfH * 2 >= this.worldHeight) {
      this.y = this.centerY;
    } else {
      this.y = clamp(this.y, this.bounds.minY + halfH, this.bounds.maxY - halfH);
    }

    this.version++;
  }

  /** World-space rectangle currently visible, for culling. */
  visibleBounds(view: Viewport): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfW = view.width / 2 / this.zoom;
    const halfH = view.height / 2 / this.zoom;
    return {
      minX: this.x - halfW,
      minY: this.y - halfH,
      maxX: this.x + halfW,
      maxY: this.y + halfH,
    };
  }
}
