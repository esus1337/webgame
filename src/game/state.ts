import { createRng } from '../core/rng';
import * as C from './config';
import { generateWorld } from './mapgen';
import type {
  Army,
  GameState,
  NationId,
  NationState,
  ProvinceId,
  WorldMap,
} from './types';

export interface NewGameOptions {
  seed: string;
  nationCount?: number;
  cellCount?: number;
  /** Nation the human plays; a random one is chosen when omitted. */
  playerNation?: NationId;
}

const STARTING_MANPOWER = 45;
const STARTING_INDUSTRY = 35;
const CAPITAL_GARRISON = 22;
const FIELD_GARRISON = 11;
const FIELD_ARMIES_PER_NATION = 3;

export function provincesOf(state: GameState, nation: NationId): ProvinceId[] {
  const owned: ProvinceId[] = [];
  for (let i = 0; i < state.owner.length; i++) {
    if (state.owner[i] === nation) owned.push(i);
  }
  return owned;
}

/** True when the province touches at least one province owned by someone else. */
export function isBorderProvince(state: GameState, province: ProvinceId): boolean {
  const owner = state.owner[province];
  return state.map.provinces[province].neighbors.some((n) => state.owner[n] !== owner);
}

export function createNationStates(map: WorldMap, owner: Int16Array): NationState[] {
  const counts = new Array<number>(map.nationCount).fill(0);
  for (let i = 0; i < owner.length; i++) counts[owner[i]]++;

  return map.nations.map((nation) => ({
    id: nation.id,
    manpower: STARTING_MANPOWER,
    industry: STARTING_INDUSTRY,
    provinceCount: counts[nation.id],
    alive: counts[nation.id] > 0,
  }));
}

export function createGame(options: NewGameOptions): GameState {
  const map = generateWorld({
    seed: options.seed,
    ...(options.nationCount !== undefined ? { nationCount: options.nationCount } : {}),
    ...(options.cellCount !== undefined ? { cellCount: options.cellCount } : {}),
  });

  const owner = new Int16Array(map.provinces.length);
  for (const province of map.provinces) owner[province.id] = province.initialOwner;

  const state: GameState = {
    map,
    owner,
    armies: new Map<ProvinceId, Army>(),
    nations: createNationStates(map, owner),
    playerNation: 0,
    day: 0,
    speedIndex: 0,
    paused: true,
    outcome: 'playing',
    battles: new Set<ProvinceId>(),
    events: [],
    aiCursor: 0,
  };

  // Starting forces: a solid capital garrison plus a few field armies pushed
  // out to the borders, so every nation begins with something to manoeuvre.
  const rng = createRng(`${map.seed}:deployment`);
  for (const nation of map.nations) {
    placeArmy(state, nation.capital, nation.id, CAPITAL_GARRISON);

    const border = provincesOf(state, nation.id).filter(
      (p) => p !== nation.capital && isBorderProvince(state, p),
    );
    for (let i = 0; i < FIELD_ARMIES_PER_NATION && border.length > 0; i++) {
      const pick = border.splice(rng.int(border.length), 1)[0];
      placeArmy(state, pick, nation.id, FIELD_GARRISON);
    }
  }

  const player =
    options.playerNation !== undefined && options.playerNation < map.nationCount
      ? options.playerNation
      : rng.int(map.nationCount);
  state.playerNation = player;

  return state;
}

export function placeArmy(
  state: GameState,
  province: ProvinceId,
  owner: NationId,
  strength: number,
): Army {
  const existing = state.armies.get(province);
  if (existing && existing.owner === owner) {
    existing.strength += strength;
    return existing;
  }
  const army: Army = { province, owner, strength, order: null };
  state.armies.set(province, army);
  return army;
}

export function pushEvent(state: GameState, text: string): void {
  state.events.push({ day: state.day, text });
  if (state.events.length > 40) state.events.shift();
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

const SAVE_VERSION = 1;

interface SavedArmy {
  p: ProvinceId;
  o: NationId;
  s: number;
  t: ProvinceId | null;
  g: number;
}

export interface SaveData {
  version: number;
  generation: WorldMap['generation'];
  playerNation: NationId;
  day: number;
  speedIndex: number;
  outcome: GameState['outcome'];
  owner: number[];
  armies: SavedArmy[];
  pools: [number, number][];
  aiCursor: number;
}

export function serializeGame(state: GameState): SaveData {
  return {
    version: SAVE_VERSION,
    generation: state.map.generation,
    playerNation: state.playerNation,
    day: state.day,
    speedIndex: state.speedIndex,
    outcome: state.outcome,
    owner: Array.from(state.owner),
    armies: [...state.armies.values()].map((army) => ({
      p: army.province,
      o: army.owner,
      s: army.strength,
      t: army.order ? army.order.target : null,
      g: army.order ? army.order.progress : 0,
    })),
    pools: state.nations.map((nation) => [nation.manpower, nation.industry]),
    aiCursor: state.aiCursor,
  };
}

/**
 * Rebuilds a game from a save. Geometry is regenerated from the seed rather
 * than stored, so the save stays tiny — at the cost of being invalidated if
 * generation ever changes, which the province-count check below catches.
 */
export function deserializeGame(data: SaveData): GameState | null {
  if (data.version !== SAVE_VERSION) return null;

  const map = generateWorld(data.generation);
  if (map.provinces.length !== data.owner.length) return null;

  const owner = Int16Array.from(data.owner);
  const nations = createNationStates(map, owner);
  data.pools.forEach(([manpower, industry], index) => {
    const nation = nations[index];
    if (nation) {
      nation.manpower = manpower;
      nation.industry = industry;
    }
  });

  const armies = new Map<ProvinceId, Army>();
  for (const saved of data.armies) {
    armies.set(saved.p, {
      province: saved.p,
      owner: saved.o,
      strength: saved.s,
      order: saved.t === null ? null : { target: saved.t, progress: saved.g },
    });
  }

  return {
    map,
    owner,
    armies,
    nations,
    playerNation: data.playerNation,
    day: data.day,
    speedIndex: Math.min(C.SPEEDS.length - 1, Math.max(0, data.speedIndex)),
    paused: true,
    outcome: data.outcome,
    battles: new Set<ProvinceId>(),
    events: [],
    aiCursor: data.aiCursor,
  };
}
