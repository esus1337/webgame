import { boundsIntersect, clamp } from '../core/geometry';
import { shadeHex, withAlpha } from '../core/color';
import { TERRAIN } from '../game/config';
import type { GameState, ProvinceId, WorldMap } from '../game/types';
import { Camera, type Viewport } from './camera';
import { LABEL_ZOOM_LIMIT, THEME } from './palette';

/** One border segment, shared by `left` and `right` (-1 for the coastline). */
interface BorderEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  left: ProvinceId;
  right: ProvinceId;
}

export interface RenderInput {
  state: GameState;
  camera: Camera;
  selected: ProvinceId | null;
  hovered: ProvinceId | null;
  /** Provinces the selected stack could be ordered into. */
  moveTargets: ReadonlySet<ProvinceId>;
  /** Milliseconds since start, for animation. */
  time: number;
}

/**
 * Draws the map in two layers.
 *
 * The base layer — sea, province fills, borders — is expensive but changes
 * rarely, so it is cached in an offscreen canvas and redrawn only when the
 * camera moves or a province changes hands. Everything that animates is drawn
 * over the top each frame. Because the base is re-rendered from vectors at the
 * current zoom rather than being a scaled-up world texture, it stays sharp at
 * every zoom level.
 */
export class Renderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly baseContext: CanvasRenderingContext2D;

  private view: Viewport = { width: 0, height: 0 };
  private dpr = 1;

  private readonly edges: BorderEdge[];
  private readonly fills = new Map<string, string>();
  private nationCenters: { x: number; y: number; count: number }[] = [];

  private baseCameraVersion = -1;
  private baseDay = -1;
  private baseDirty = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: WorldMap,
  ) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('2D canvas is unavailable');
    this.context = context;

    this.base = document.createElement('canvas');
    const baseContext = this.base.getContext('2d', { alpha: false });
    if (!baseContext) throw new Error('2D canvas is unavailable');
    this.baseContext = baseContext;

    this.edges = buildBorderEdges(map);
    for (const nation of map.nations) {
      for (const terrain of Object.keys(TERRAIN) as (keyof typeof TERRAIN)[]) {
        this.fills.set(
          `${nation.id}:${terrain}`,
          shadeHex(nation.color, TERRAIN[terrain].shade),
        );
      }
    }
  }

  get viewport(): Viewport {
    return this.view;
  }

  resize(cssWidth: number, cssHeight: number): void {
    // Cap the backing store at 2x: beyond that the fill rate costs more on a
    // phone than the extra sharpness is worth.
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.view = { width: cssWidth, height: cssHeight };

    for (const canvas of [this.canvas, this.base]) {
      canvas.width = Math.max(1, Math.round(cssWidth * this.dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * this.dpr));
    }
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.baseDirty = true;
  }

  /** Forces a base-layer redraw; ownership changes outside a step need this. */
  invalidate(): void {
    this.baseDirty = true;
  }

  render(input: RenderInput): void {
    const { state, camera } = input;
    if (this.view.width === 0 || this.view.height === 0) return;

    if (
      this.baseDirty ||
      camera.version !== this.baseCameraVersion ||
      state.day !== this.baseDay
    ) {
      this.drawBase(state, camera);
      this.baseCameraVersion = camera.version;
      this.baseDay = state.day;
      this.baseDirty = false;
    }

    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(this.base, 0, 0);
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawOverlays(input);
  }

  /* ---------------------------------------------------------------- */
  /* Base layer                                                        */
  /* ---------------------------------------------------------------- */

  private applyWorldTransform(context: CanvasRenderingContext2D, camera: Camera): void {
    const scale = this.dpr * camera.zoom;
    context.setTransform(
      scale,
      0,
      0,
      scale,
      this.dpr * (this.view.width / 2 - camera.x * camera.zoom),
      this.dpr * (this.view.height / 2 - camera.y * camera.zoom),
    );
  }

  private drawBase(state: GameState, camera: Camera): void {
    const context = this.baseContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = THEME.ocean;
    context.fillRect(0, 0, this.base.width, this.base.height);

    this.applyWorldTransform(context, camera);
    const visible = camera.visibleBounds(this.view);
    const { zoom } = camera;

    // Province fills.
    for (const province of this.map.provinces) {
      if (!boundsIntersect(province.bounds, visible)) continue;
      const owner = state.owner[province.id];
      context.fillStyle = this.fills.get(`${owner}:${province.terrain}`) ?? '#888888';
      tracePolygon(context, province.polygon);
      context.fill();
    }

    // Internal province borders: a hairline, and only once we are zoomed in
    // enough for them to read as detail rather than noise.
    if (zoom > 0.75) {
      context.strokeStyle = THEME.provinceBorder;
      context.lineWidth = 0.7 / zoom;
      context.beginPath();
      for (const edge of this.edges) {
        if (edge.right < 0) continue;
        if (state.owner[edge.left] !== state.owner[edge.right]) continue;
        context.moveTo(edge.x1, edge.y1);
        context.lineTo(edge.x2, edge.y2);
      }
      context.stroke();
    }

    // National borders, drawn only along edges where ownership actually
    // changes — stroking whole polygons would double-draw every shared edge.
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.strokeStyle = THEME.nationBorder;
    context.lineWidth = 2.2 / zoom;
    context.beginPath();
    for (const edge of this.edges) {
      if (edge.right < 0) continue;
      if (state.owner[edge.left] === state.owner[edge.right]) continue;
      context.moveTo(edge.x1, edge.y1);
      context.lineTo(edge.x2, edge.y2);
    }
    context.stroke();

    // Coastline.
    context.strokeStyle = THEME.coastline;
    context.lineWidth = 1.6 / zoom;
    context.beginPath();
    for (const edge of this.edges) {
      if (edge.right >= 0) continue;
      context.moveTo(edge.x1, edge.y1);
      context.lineTo(edge.x2, edge.y2);
    }
    context.stroke();

    // The player's own border, picked out so they can always find themselves.
    context.strokeStyle = THEME.playerOutline;
    context.lineWidth = 2.4 / zoom;
    context.beginPath();
    for (const edge of this.edges) {
      const leftIsPlayer = state.owner[edge.left] === state.playerNation;
      const rightIsPlayer = edge.right >= 0 && state.owner[edge.right] === state.playerNation;
      if (leftIsPlayer === rightIsPlayer) continue;
      context.moveTo(edge.x1, edge.y1);
      context.lineTo(edge.x2, edge.y2);
    }
    context.stroke();

    this.updateNationCenters(state);
  }

  private updateNationCenters(state: GameState): void {
    const centers = this.map.nations.map(() => ({ x: 0, y: 0, count: 0 }));
    for (const province of this.map.provinces) {
      const center = centers[state.owner[province.id]];
      center.x += province.cx;
      center.y += province.cy;
      center.count++;
    }
    for (const center of centers) {
      if (center.count > 0) {
        center.x /= center.count;
        center.y /= center.count;
      }
    }
    this.nationCenters = centers;
  }

  /* ---------------------------------------------------------------- */
  /* Overlays                                                          */
  /* ---------------------------------------------------------------- */

  private toScreen(camera: Camera, wx: number, wy: number): [number, number] {
    return [camera.worldToScreenX(wx, this.view), camera.worldToScreenY(wy, this.view)];
  }

  private strokeProvince(
    context: CanvasRenderingContext2D,
    camera: Camera,
    province: ProvinceId,
  ): void {
    const polygon = this.map.provinces[province].polygon;
    context.beginPath();
    for (let i = 0; i < polygon.length; i += 2) {
      const [x, y] = this.toScreen(camera, polygon[i], polygon[i + 1]);
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
  }

  private drawOverlays(input: RenderInput): void {
    const { state, camera, selected, hovered, moveTargets, time } = input;
    const context = this.context;
    const visible = camera.visibleBounds(this.view);

    context.lineJoin = 'round';
    context.lineCap = 'round';

    // Provinces the selected stack may be ordered into.
    if (moveTargets.size > 0) {
      context.save();
      context.setLineDash([6, 5]);
      context.lineDashOffset = -(time / 45) % 11;
      context.strokeStyle = withAlpha(THEME.selection, 0.75);
      context.lineWidth = 1.6;
      for (const target of moveTargets) {
        this.strokeProvince(context, camera, target);
        context.stroke();
      }
      context.restore();
    }

    if (hovered !== null && hovered !== selected) {
      context.strokeStyle = withAlpha(THEME.selection, 0.4);
      context.lineWidth = 1.5;
      this.strokeProvince(context, camera, hovered);
      context.stroke();
    }

    if (selected !== null) {
      context.strokeStyle = THEME.selection;
      context.lineWidth = 2.5;
      this.strokeProvince(context, camera, selected);
      context.stroke();
    }

    // Battles: a pulsing ring wherever fighting happened on the last day.
    if (state.battles.size > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(time / 180);
      context.strokeStyle = withAlpha(THEME.battle, 0.35 + 0.45 * pulse);
      context.lineWidth = 2;
      for (const province of state.battles) {
        const data = this.map.provinces[province];
        const [x, y] = this.toScreen(camera, data.cx, data.cy);
        context.beginPath();
        context.arc(x, y, 9 + 5 * pulse, 0, Math.PI * 2);
        context.stroke();
      }
    }

    // Labels go under the orders and army pills: in the zoom range where both
    // are drawn, the number on a stack is what you actually need to read.
    if (camera.zoom < LABEL_ZOOM_LIMIT) {
      this.drawNationLabels(state, camera, visible);
    }

    this.drawOrders(input);
    this.drawArmies(input);
  }

  private drawOrders({ state, camera }: RenderInput): void {
    const context = this.context;
    context.save();

    for (const army of state.armies.values()) {
      if (!army.order) continue;
      const from = this.map.provinces[army.province];
      const to = this.map.provinces[army.order.target];
      const [x1, y1] = this.toScreen(camera, from.cx, from.cy);
      const [x2, y2] = this.toScreen(camera, to.cx, to.cy);

      const engaged = army.order.progress >= 1;
      const own = army.owner === state.playerNation;
      // Other nations' movements are shown faintly: enough to read the front,
      // not enough to drown out your own orders.
      context.globalAlpha = own ? 1 : 0.28;
      context.strokeStyle = engaged ? THEME.battle : this.map.nations[army.owner].color;
      context.lineWidth = own ? 2.2 : 1.4;

      const progress = clamp(army.order.progress, 0, 1);
      const tipX = x1 + (x2 - x1) * (0.25 + 0.7 * progress);
      const tipY = y1 + (y2 - y1) * (0.25 + 0.7 * progress);

      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(tipX, tipY);
      context.stroke();

      const angle = Math.atan2(y2 - y1, x2 - x1);
      const size = own ? 7 : 5;
      context.beginPath();
      context.moveTo(tipX, tipY);
      context.lineTo(
        tipX - size * Math.cos(angle - 0.42),
        tipY - size * Math.sin(angle - 0.42),
      );
      context.lineTo(
        tipX - size * Math.cos(angle + 0.42),
        tipY - size * Math.sin(angle + 0.42),
      );
      context.closePath();
      context.fillStyle = engaged ? THEME.battle : this.map.nations[army.owner].color;
      context.fill();
    }

    context.restore();
  }

  private drawArmies({ state, camera }: RenderInput): void {
    const context = this.context;
    const visible = camera.visibleBounds(this.view);
    // Below this zoom the map is a strategic overview; pills would tile over
    // each other, so stacks collapse to dots.
    const detailed = camera.zoom > 0.85;

    context.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    for (const army of state.armies.values()) {
      const province = this.map.provinces[army.province];
      if (!boundsIntersect(province.bounds, visible)) continue;

      const [x, y] = this.toScreen(camera, province.cx, province.cy);
      const nation = this.map.nations[army.owner];
      const own = army.owner === state.playerNation;

      if (!detailed) {
        // Size carries the information a pill would: at a glance you can see
        // where the heavy stacks are without reading a single number.
        const radius = Math.min(9, 2 + Math.sqrt(army.strength) * 0.42);
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = nation.color;
        context.fill();
        context.lineWidth = own ? 1.6 : 0.8;
        context.strokeStyle = own ? THEME.playerOutline : 'rgba(0,0,0,0.6)';
        context.stroke();
        continue;
      }

      const label = String(Math.max(1, Math.round(army.strength)));
      const width = Math.max(22, context.measureText(label).width + 12);
      const height = 16;

      context.beginPath();
      context.roundRect(x - width / 2, y - height / 2, width, height, 4);
      context.fillStyle = nation.color;
      context.fill();
      context.lineWidth = own ? 2 : 1;
      context.strokeStyle = own ? THEME.playerOutline : 'rgba(0,0,0,0.6)';
      context.stroke();

      context.fillStyle = '#0b1118';
      context.fillText(label, x, y + 0.5);
    }
  }

  private drawNationLabels(
    state: GameState,
    camera: Camera,
    visible: { minX: number; minY: number; maxX: number; maxY: number },
  ): void {
    const context = this.context;
    // Fade the labels out as the army pills fade in, so the two never fight.
    const fade = clamp((LABEL_ZOOM_LIMIT - camera.zoom) / 0.6, 0, 1);
    if (fade <= 0.02) return;

    context.save();
    context.globalAlpha = fade;
    context.font = '600 12px ui-sans-serif, system-ui, -apple-system, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // Draw the player first, then the largest nations, and drop any label that
    // would collide with one already placed — overlapping names are worse than
    // a missing one, and the small nations are the ones you can afford to lose.
    const order = [...this.map.nations].sort((a, b) => {
      if (a.id === state.playerNation) return -1;
      if (b.id === state.playerNation) return 1;
      return (this.nationCenters[b.id]?.count ?? 0) - (this.nationCenters[a.id]?.count ?? 0);
    });

    const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];

    for (const nation of order) {
      const center = this.nationCenters[nation.id];
      if (!center || center.count === 0) continue;
      if (
        center.x < visible.minX ||
        center.x > visible.maxX ||
        center.y < visible.minY ||
        center.y > visible.maxY
      ) {
        continue;
      }

      const [x, y] = this.toScreen(camera, center.x, center.y);
      const label = nation.shortName;
      const halfWidth = context.measureText(label).width / 2 + 4;
      const box = { x1: x - halfWidth, y1: y - 9, x2: x + halfWidth, y2: y + 9 };
      // A name sliced off by the edge of the screen reads as a glitch, so drop
      // it rather than draw half of it.
      if (box.x1 < 4 || box.x2 > this.view.width - 4) continue;
      if (placed.some((other) => box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1)) {
        continue;
      }
      placed.push(box);

      const isPlayer = nation.id === state.playerNation;
      context.lineWidth = 3;
      context.strokeStyle = 'rgba(6, 10, 16, 0.85)';
      context.strokeText(label, x, y);
      context.fillStyle = isPlayer ? THEME.playerOutline : THEME.text;
      context.fillText(label, x, y);
    }

    context.restore();
  }
}

function tracePolygon(context: CanvasRenderingContext2D, polygon: readonly number[]): void {
  context.beginPath();
  context.moveTo(polygon[0], polygon[1]);
  for (let i = 2; i < polygon.length; i += 2) {
    context.lineTo(polygon[i], polygon[i + 1]);
  }
  context.closePath();
}

/**
 * Collects every polygon edge once, paired with the province on each side.
 * Voronoi neighbours share exact vertices, so edges can be matched on a
 * rounded key; an edge claimed by only one province is coastline.
 */
function buildBorderEdges(map: WorldMap): BorderEdge[] {
  const seen = new Map<string, BorderEdge>();

  for (const province of map.provinces) {
    const { polygon } = province;
    const count = polygon.length / 2;

    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const x1 = polygon[i * 2];
      const y1 = polygon[i * 2 + 1];
      const x2 = polygon[j * 2];
      const y2 = polygon[j * 2 + 1];

      const a = `${x1.toFixed(2)},${y1.toFixed(2)}`;
      const b = `${x2.toFixed(2)},${y2.toFixed(2)}`;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;

      const existing = seen.get(key);
      if (existing) {
        existing.right = province.id;
      } else {
        seen.set(key, { x1, y1, x2, y2, left: province.id, right: -1 });
      }
    }
  }

  return [...seen.values()];
}
