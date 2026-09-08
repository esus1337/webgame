import { distance } from '../core/geometry';
import * as C from './config';
import { runAiTurn } from './ai';
import { pushEvent } from './state';
import type { Army, GameState, NationId, ProvinceId } from './types';

export interface StepOptions {
  /** Off in tests that need to observe a single mechanic in isolation. */
  runAi?: boolean;
  /**
   * Nations the AI leaves alone. Defaults to the player's nation; balance runs
   * pass an empty list so every nation is driven on the same stagger.
   */
  humanNations?: readonly NationId[];
}

/** Days of marching between two adjacent provinces. */
export function marchDays(state: GameState, from: ProvinceId, to: ProvinceId): number {
  const a = state.map.provinces[from];
  const b = state.map.provinces[to];
  const days = (distance(a.cx, a.cy, b.cx, b.cy) / C.MARCH_SPEED) * C.TERRAIN[b.terrain].moveCost;
  return Math.max(1, days);
}

/** An army has reached its destination and is either moving in or fighting. */
function hasArrived(army: Army): boolean {
  return army.order !== null && army.order.progress >= 1;
}

/**
 * Strength of the local militia defending a province against `attacker`.
 * A population only half resists a change of occupier, so retaking your own
 * land is cheaper than taking someone else's.
 */
export function garrisonStrength(state: GameState, province: ProvinceId): number {
  const data = state.map.provinces[province];
  const held = state.owner[province] === data.initialOwner;
  return data.garrison * (held ? 1 : C.OCCUPIED_GARRISON_SCALE);
}

/* ------------------------------------------------------------------ */
/* Player and AI actions                                               */
/* ------------------------------------------------------------------ */

export function canRecruit(state: GameState, nation: NationId): boolean {
  const pool = state.nations[nation];
  return (
    pool !== undefined &&
    pool.alive &&
    pool.manpower >= C.RECRUIT_MANPOWER_COST &&
    pool.industry >= C.RECRUIT_INDUSTRY_COST
  );
}

/** Raises a batch of strength in an owned province. Instant — there is no queue. */
export function recruit(state: GameState, province: ProvinceId): boolean {
  const nation = state.owner[province];
  if (nation === undefined || !canRecruit(state, nation)) return false;

  const existing = state.armies.get(province);
  if (existing && existing.owner !== nation) return false;

  const pool = state.nations[nation];
  pool.manpower -= C.RECRUIT_MANPOWER_COST;
  pool.industry -= C.RECRUIT_INDUSTRY_COST;

  if (existing) {
    existing.strength += C.RECRUIT_BATCH;
  } else {
    state.armies.set(province, {
      province,
      owner: nation,
      strength: C.RECRUIT_BATCH,
      order: null,
    });
  }
  return true;
}

/** Orders the stack in `from` to march on the adjacent province `to`. */
export function orderMove(state: GameState, from: ProvinceId, to: ProvinceId): boolean {
  const army = state.armies.get(from);
  if (!army || army.strength <= 0) return false;
  if (!state.map.provinces[from].neighbors.includes(to)) return false;

  // Any adjacent province is a legal target: an empty one is a march, a
  // friendly stack is a reinforcement, an enemy stack is an assault.
  army.order = { target: to, progress: 0 };
  return true;
}

export function cancelOrder(state: GameState, province: ProvinceId): boolean {
  const army = state.armies.get(province);
  if (!army || !army.order) return false;
  army.order = null;
  return true;
}

/* ------------------------------------------------------------------ */
/* Simulation phases                                                   */
/* ------------------------------------------------------------------ */

function stepEconomy(state: GameState): void {
  const { map } = state;
  for (const province of map.provinces) {
    const owner = state.owner[province.id];
    const pool = state.nations[owner];
    if (!pool || !pool.alive) continue;

    // Occupied territory is worth far less than the homeland, which is what
    // stops a runaway conqueror from snowballing on captured industry alone.
    const yieldScale = province.initialOwner === owner ? 1 : C.OCCUPIED_YIELD;
    const capitalBonus = map.nations[owner].capital === province.id ? C.CAPITAL_YIELD_BONUS : 0;
    pool.manpower += province.manpower * yieldScale + capitalBonus;
    pool.industry += province.industry * yieldScale + capitalBonus;
  }
}

/** Moves an army into a province it now controls, merging with any friendly stack. */
function relocate(state: GameState, army: Army, to: ProvinceId): void {
  state.armies.delete(army.province);
  const friendly = state.armies.get(to);
  if (friendly && friendly.owner === army.owner) {
    friendly.strength += army.strength;
    return;
  }
  army.province = to;
  army.order = null;
  state.armies.set(to, army);
}

function capture(state: GameState, province: ProvinceId, nation: NationId): void {
  const previous = state.owner[province];
  if (previous === nation) return;
  state.owner[province] = nation;

  const { map } = state;
  if (nation === state.playerNation) {
    pushEvent(state, `Captured ${map.provinces[province].name}`);
  } else if (previous === state.playerNation) {
    pushEvent(state, `Lost ${map.provinces[province].name} to ${map.nations[nation].name}`);
  }
}

function stepMovement(state: GameState): void {
  // Snapshot: relocation mutates the army map as we go.
  for (const army of [...state.armies.values()]) {
    if (!army.order) continue;
    if (state.armies.get(army.province) !== army) continue;

    const { target } = army.order;
    if (!state.map.provinces[army.province].neighbors.includes(target)) {
      army.order = null;
      continue;
    }

    if (army.order.progress < 1) {
      army.order.progress += 1 / marchDays(state, army.province, target);
      if (army.order.progress < 1) continue;
    }

    const defender = state.armies.get(target);
    if (defender && defender.owner !== army.owner) {
      // Contested: the stack stays put and stepCombat resolves the assault.
      continue;
    }

    if (state.owner[target] !== army.owner) {
      // Undefended, but not undefeated: the militia has to be beaten first.
      const militia = garrisonStrength(state, target);
      if (army.strength <= militia) {
        army.order = null;
        continue;
      }
      army.strength -= militia;
      capture(state, target, army.owner);
    }
    relocate(state, army, target);
  }
}

interface Assault {
  target: ProvinceId;
  attackers: Army[];
}

/** Groups arrived attackers by the province they are assaulting. */
function collectAssaults(state: GameState): Assault[] {
  const byTarget = new Map<ProvinceId, Army[]>();

  for (const army of state.armies.values()) {
    if (!hasArrived(army)) continue;
    const target = army.order!.target;
    const defender = state.armies.get(target);
    if (!defender || defender.owner === army.owner) continue;

    const group = byTarget.get(target);
    if (group) group.push(army);
    else byTarget.set(target, [army]);
  }

  return [...byTarget.entries()].map(([target, attackers]) => ({ target, attackers }));
}

/** Sends a beaten stack to an adjacent friendly province, or destroys it. */
function retreat(state: GameState, army: Army, awayFrom: ProvinceId): void {
  const options = state.map.provinces[army.province].neighbors.filter((n) => {
    if (n === awayFrom) return false;
    if (state.owner[n] !== army.owner) return false;
    const occupant = state.armies.get(n);
    return !occupant || occupant.owner === army.owner;
  });

  state.armies.delete(army.province);
  if (options.length === 0) return; // Surrounded: the stack is lost.

  // Prefer an empty province so the retreat does not stack everything up.
  const empty = options.filter((n) => !state.armies.has(n));
  const destination = (empty.length > 0 ? empty : options)[0];

  const friendly = state.armies.get(destination);
  if (friendly) {
    friendly.strength += army.strength;
    return;
  }
  army.province = destination;
  army.order = null;
  state.armies.set(destination, army);
}

function stepCombat(state: GameState): void {
  state.battles.clear();

  for (const { target, attackers } of collectAssaults(state)) {
    const defender = state.armies.get(target);
    if (!defender) continue;

    state.battles.add(target);
    for (const attacker of attackers) state.battles.add(attacker.province);

    const defenseModifier = C.TERRAIN[state.map.provinces[target].terrain].defense;
    const attackStrength = attackers.reduce((total, army) => total + army.strength, 0);
    // The militia fights alongside the garrisoned stack but cannot be killed,
    // so a province is always harder to take than the field army on it.
    const defendStrength = defender.strength + garrisonStrength(state, target);

    // One day of grinding. Terrain shields the defender; the attacker pays a
    // flat penalty for being the one crossing the border.
    const defenderLoss = (attackStrength * C.COMBAT_RATE) / defenseModifier;
    const attackerLoss = defendStrength * C.COMBAT_RATE * C.ATTACKER_PENALTY;

    defender.strength -= defenderLoss;
    for (const attacker of attackers) {
      // Losses are shared out in proportion to each stack's contribution.
      attacker.strength -= attackerLoss * (attacker.strength / attackStrength);
    }

    const survivors = attackers.filter((army) => {
      if (army.strength > C.ROUT_THRESHOLD) return true;
      state.armies.delete(army.province);
      return false;
    });

    const survivingStrength = survivors.reduce((total, army) => total + army.strength, 0);
    const defenderBroken =
      defender.strength <= C.ROUT_THRESHOLD ||
      defender.strength < survivingStrength * C.RETREAT_RATIO;

    if (defenderBroken && survivors.length > 0) {
      if (defender.strength > C.ROUT_THRESHOLD) {
        retreat(state, defender, survivors[0].province);
      } else {
        state.armies.delete(target);
      }
      // The strongest attacker takes the ground; the rest merge in next day.
      const victor = survivors.reduce((best, army) =>
        army.strength > best.strength ? army : best,
      );
      capture(state, target, victor.owner);
      relocate(state, victor, target);
      continue;
    }

    if (survivors.length === 0) continue;

    // The assault has stalled: call it off rather than feeding the meat grinder.
    if (survivingStrength < defender.strength * C.RETREAT_RATIO) {
      for (const army of survivors) army.order = null;
    }
  }
}

function stepAttrition(state: GameState): void {
  for (const army of [...state.armies.values()]) {
    const province = state.map.provinces[army.province];
    if (province.initialOwner === army.owner) continue;

    army.strength *= 1 - C.ENEMY_TERRITORY_ATTRITION;
    if (army.strength <= C.ROUT_THRESHOLD) {
      state.armies.delete(army.province);
    }
  }
}

function stepVictory(state: GameState): void {
  const counts = new Array<number>(state.map.nationCount).fill(0);
  for (let i = 0; i < state.owner.length; i++) counts[state.owner[i]]++;

  for (const nation of state.nations) {
    nation.provinceCount = counts[nation.id];
    if (nation.alive && counts[nation.id] === 0) {
      nation.alive = false;
      for (const army of [...state.armies.values()]) {
        if (army.owner === nation.id) state.armies.delete(army.province);
      }
      pushEvent(state, `${state.map.nations[nation.id].name} has been conquered`);
    }
  }

  if (state.outcome !== 'playing') return;

  const player = state.nations[state.playerNation];
  if (!player.alive) {
    state.outcome = 'lost';
    pushEvent(state, 'Your nation has fallen.');
    return;
  }

  const aliveCount = state.nations.filter((nation) => nation.alive).length;
  const share = player.provinceCount / state.owner.length;
  if (aliveCount === 1 || share >= C.VICTORY_LAND_SHARE) {
    state.outcome = 'won';
    pushEvent(state, 'You have conquered the continent.');
  }
}

/** Advances the world by one day. */
export function step(state: GameState, options: StepOptions = {}): void {
  if (state.outcome !== 'playing') return;

  state.day++;
  stepEconomy(state);

  if (options.runAi ?? true) {
    const human = options.humanNations ?? [state.playerNation];
    const total = state.map.nationCount;
    for (let i = 0; i < Math.min(C.AI_NATIONS_PER_DAY, total); i++) {
      const nation = state.aiCursor % total;
      state.aiCursor = (state.aiCursor + 1) % total;
      if (!human.includes(nation) && state.nations[nation].alive) {
        runAiTurn(state, nation);
      }
    }
  }

  stepMovement(state);
  stepCombat(state);
  stepAttrition(state);
  stepVictory(state);
}
