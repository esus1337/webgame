import type { Bounds } from '../core/geometry';
import type { Terrain } from './config';

export type ProvinceId = number;
export type NationId = number;

/**
 * A land province. Ocean cells are discarded during generation — the sea is
 * simply the background the land is drawn on — so every province here is land
 * and ids are dense, contiguous indices.
 */
export interface Province {
  id: ProvinceId;
  name: string;
  /** Flat [x0, y0, x1, y1, ...] in world coordinates. */
  polygon: number[];
  /** Centroid; the anchor for army markers and labels. */
  cx: number;
  cy: number;
  bounds: Bounds;
  terrain: Terrain;
  /** Adjacent land provinces. Symmetric. */
  neighbors: ProvinceId[];
  /** Whether the province touches the sea. */
  coastal: boolean;
  /** Daily yields before the occupied-territory penalty. */
  manpower: number;
  industry: number;
  /** Local militia an attacker must beat to take the province. */
  garrison: number;
  /** Owner at world generation; occupied territory yields less than this. */
  initialOwner: NationId;
}

export interface Nation {
  id: NationId;
  /** Full name, including any form of government: "Republic of Vareth". */
  name: string;
  /** Bare place name, used where space is tight (map labels). */
  shortName: string;
  /** CSS color for fills. */
  color: string;
  /** Darker variant for borders and text on light fills. */
  borderColor: string;
  capital: ProvinceId;
}

/** The exact inputs that reproduce a world; a save stores these, not geometry. */
export interface GenerationOptions {
  seed: string;
  nationCount: number;
  cellCount: number;
}

/** The deterministic half of a world: pure function of the generation options. */
export interface WorldMap {
  generation: GenerationOptions;
  seed: string;
  /** Nations actually present, which may be fewer than were requested. */
  nationCount: number;
  width: number;
  height: number;
  /**
   * Bounding box of the land itself. The world rectangle is mostly sea, so the
   * camera frames and clamps to this instead — otherwise zooming out strands
   * the continent as a small blob in an empty ocean.
   */
  landBounds: Bounds;
  provinces: Province[];
  nations: Nation[];
}

export interface ArmyOrder {
  target: ProvinceId;
  /** Days of marching accumulated; the move lands at >= 1. */
  progress: number;
}

/** At most one stack per province — the simplification the whole UI rests on. */
export interface Army {
  province: ProvinceId;
  owner: NationId;
  strength: number;
  order: ArmyOrder | null;
}

export interface NationState {
  id: NationId;
  manpower: number;
  industry: number;
  provinceCount: number;
  alive: boolean;
}

export type Outcome = 'playing' | 'won' | 'lost';

export interface GameEvent {
  day: number;
  text: string;
}

/** The mutable half of a world. Serialised alongside the seed as the save. */
export interface GameState {
  map: WorldMap;
  /** Current owner per province id. */
  owner: Int16Array;
  armies: Map<ProvinceId, Army>;
  nations: NationState[];
  playerNation: NationId;
  day: number;
  /** Index into SPEEDS. */
  speedIndex: number;
  paused: boolean;
  outcome: Outcome;
  /** Provinces that saw combat on the most recent day, for the render pulse. */
  battles: Set<ProvinceId>;
  events: GameEvent[];
  /** Cursor for staggering AI turns across days. */
  aiCursor: number;
}
