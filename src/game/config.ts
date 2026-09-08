/**
 * Every tunable in one place. Balance work happens here, not scattered through
 * the simulation.
 */

export const WORLD_WIDTH = 2400;
export const WORLD_HEIGHT = 1400;

/** Voronoi cells generated before the ocean is carved away. */
export const CELL_COUNT = 520;
/** Lloyd relaxation passes — evens out cell sizes so no province is a sliver. */
export const RELAXATION_PASSES = 2;
/** Fraction of cells that start as land before the largest-landmass cut. */
export const LAND_FRACTION = 0.52;
/** If the largest landmass comes out smaller than this, retry with more land. */
export const MIN_LAND_PROVINCES = 150;

export const DEFAULT_NATION_COUNT = 12;
export const MIN_NATION_COUNT = 4;
export const MAX_NATION_COUNT = 24;
/** Nations smaller than this get absorbed by a neighbour during generation. */
export const MIN_NATION_SIZE = 5;

export const TERRAINS = ['plains', 'forest', 'hills', 'mountains'] as const;
export type Terrain = (typeof TERRAINS)[number];

export interface TerrainProfile {
  /** Multiplies the defender's staying power in combat. */
  defense: number;
  /** Days of marching per unit of map distance. */
  moveCost: number;
  manpower: number;
  industry: number;
  /** Base fill tint, blended over the owner's color. */
  shade: number;
}

export const TERRAIN: Record<Terrain, TerrainProfile> = {
  plains: { defense: 1.0, moveCost: 1.0, manpower: 1.0, industry: 1.0, shade: 0.0 },
  forest: { defense: 1.25, moveCost: 1.35, manpower: 0.85, industry: 0.8, shade: -0.08 },
  hills: { defense: 1.5, moveCost: 1.7, manpower: 0.7, industry: 0.65, shade: 0.06 },
  mountains: { defense: 2.0, moveCost: 2.3, manpower: 0.4, industry: 0.35, shade: 0.14 },
};

/** Real milliseconds per simulated day at 1x speed. */
export const MS_PER_DAY = 600;
export const SPEEDS = [1, 2, 5] as const;
/** Cap on catch-up steps per frame, so a backgrounded tab does not stampede. */
export const MAX_STEPS_PER_FRAME = 5;

/** Daily yield per province, scaled by terrain and area. */
export const BASE_MANPOWER = 0.55;
export const BASE_INDUSTRY = 0.45;
/** Occupied provinces (owner !== original owner) yield this fraction. */
export const OCCUPIED_YIELD = 0.28;
/** A nation's capital is worth this much extra. */
export const CAPITAL_YIELD_BONUS = 3;

/** Recruiting: one batch of strength costs this much. */
export const RECRUIT_BATCH = 10;
export const RECRUIT_MANPOWER_COST = 10;
export const RECRUIT_INDUSTRY_COST = 8;

/**
 * Every province defends itself. Without this, most of the map is empty and
 * conquest is just walking; the militia makes taking ground cost strength, so
 * expansion is paced by a nation's economy rather than by its marching speed.
 */
export const BASE_GARRISON = 8;
/** Militia in territory its holder only occupies, rather than owns. */
export const OCCUPIED_GARRISON_SCALE = 0.5;

/** Fraction of the opposing strength inflicted as losses per day. */
export const COMBAT_RATE = 0.038;
/** Attacking into a province costs the attacker this penalty on top of terrain. */
export const ATTACKER_PENALTY = 1.15;
/** Below this strength a stack is destroyed rather than routed. */
export const ROUT_THRESHOLD = 2;
/** A losing stack retreats when it drops below this share of the winner. */
export const RETREAT_RATIO = 0.28;
/** Daily attrition for a stack sitting on enemy soil. */
export const ENEMY_TERRITORY_ATTRITION = 0.004;
/** Marching distance is divided by this to convert to days. */
export const MARCH_SPEED = 32;

/** Share of all land provinces the player must hold to win outright. */
export const VICTORY_LAND_SHARE = 0.6;

/** Nations acting per day; the AI is staggered so behaviour desynchronises. */
export const AI_NATIONS_PER_DAY = 3;
/** The AI attacks when its stack is at least this many times the defender. */
export const AI_ATTACK_RATIO = 1.35;
/** Strength the AI tries to keep on its capital. */
export const AI_CAPITAL_GARRISON = 12;
/**
 * The capital garrison only marches out once it is this many times the target,
 * since a stack cannot be split and leaving the capital bare loses wars.
 */
export const AI_CAPITAL_SORTIE_RATIO = 2.5;
