import { createRng } from '../core/rng';
import * as C from './config';
import { orderMove, recruit } from './sim';
import type { Army, GameState, NationId, ProvinceId } from './types';

/**
 * A deliberately transparent opponent. It is meant to be readable and to give
 * the player a coherent war to fight, not to be hard to beat: hold the capital,
 * shore up whatever is under attack, keep recruiting, push where the odds are
 * good, and drift idle stacks toward the front.
 */

interface AiView {
  armies: Army[];
  owned: Set<ProvinceId>;
}

function view(state: GameState, nation: NationId): AiView {
  const armies: Army[] = [];
  for (const army of state.armies.values()) {
    if (army.owner === nation) armies.push(army);
  }
  const owned = new Set<ProvinceId>();
  for (let i = 0; i < state.owner.length; i++) {
    if (state.owner[i] === nation) owned.add(i);
  }
  return { armies, owned };
}

/** Enemy provinces adjacent to one of ours, with the strength defending each. */
function borderTargets(
  state: GameState,
  nation: NationId,
  from: ProvinceId,
): { target: ProvinceId; defence: number }[] {
  const targets: { target: ProvinceId; defence: number }[] = [];
  for (const neighbor of state.map.provinces[from].neighbors) {
    if (state.owner[neighbor] === nation) continue;
    const defender = state.armies.get(neighbor);
    targets.push({ target: neighbor, defence: defender ? defender.strength : 0 });
  }
  return targets;
}

/** Breadth-first hop count to the nearest province bordering another nation. */
function distanceToFront(state: GameState, nation: NationId, from: ProvinceId): number {
  const seen = new Set<ProvinceId>([from]);
  let frontier: ProvinceId[] = [from];
  let depth = 0;

  while (frontier.length > 0 && depth < 12) {
    const next: ProvinceId[] = [];
    for (const province of frontier) {
      for (const neighbor of state.map.provinces[province].neighbors) {
        if (state.owner[neighbor] !== nation) return depth;
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
    depth++;
  }
  return depth;
}

/** Moves a stack one hop toward the nearest contested border. */
function advanceToFront(state: GameState, nation: NationId, army: Army): void {
  const here = distanceToFront(state, nation, army.province);
  if (here === 0) return;

  let best: ProvinceId | null = null;
  let bestDistance = here;
  for (const neighbor of state.map.provinces[army.province].neighbors) {
    if (state.owner[neighbor] !== nation) continue;
    const occupant = state.armies.get(neighbor);
    if (occupant && occupant.owner !== nation) continue;
    const d = distanceToFront(state, nation, neighbor);
    if (d < bestDistance) {
      bestDistance = d;
      best = neighbor;
    }
  }

  if (best !== null) orderMove(state, army.province, best);
}

export function runAiTurn(state: GameState, nation: NationId): void {
  const pool = state.nations[nation];
  if (!pool || !pool.alive) return;

  const { armies, owned } = view(state, nation);
  const rng = createRng(`${state.map.seed}:ai:${nation}:${state.day}`);
  const capital = state.map.nations[nation].capital;

  // 1. Keep recruiting while the pools allow. Reinforce the weakest front-line
  //    province, or the capital if nothing is exposed.
  while (state.nations[nation].manpower >= C.RECRUIT_MANPOWER_COST * 2 &&
         state.nations[nation].industry >= C.RECRUIT_INDUSTRY_COST * 2) {
    const threatened = [...owned].filter((province) =>
      state.map.provinces[province].neighbors.some((n) => {
        const occupant = state.armies.get(n);
        return occupant !== undefined && occupant.owner !== nation;
      }),
    );

    const site =
      owned.has(capital) && state.armies.get(capital) === undefined
        ? capital
        : threatened.length > 0
          ? threatened[rng.int(threatened.length)]
          : owned.has(capital)
            ? capital
            : [...owned][rng.int(owned.size)];

    if (site === undefined || !recruit(state, site)) break;
  }

  // 2. Hold the capital. Because a province holds at most one stack, the
  //    garrison cannot be split: it either stays or it all leaves. So it stays
  //    unless it has grown large enough that marching out still leaves the
  //    capital better defended than an empty province would be.
  const marchOutThreshold = C.AI_CAPITAL_GARRISON * C.AI_CAPITAL_SORTIE_RATIO;
  const capitalGarrison = state.armies.get(capital);
  if (capitalGarrison && capitalGarrison.owner === nation) {
    if (capitalGarrison.strength < marchOutThreshold) {
      capitalGarrison.order = null;
    }
  }

  // 3. Give every idle stack something to do.
  for (const army of armies) {
    if (army.order) continue;
    if (army.province === capital && army.strength < marchOutThreshold) continue;
    if (state.armies.get(army.province) !== army) continue;

    const targets = borderTargets(state, nation, army.province);
    if (targets.length === 0) {
      advanceToFront(state, nation, army);
      continue;
    }

    // Attack the softest adjacent province, but only at favourable odds —
    // otherwise the AI throws stacks away and every war stalls into attrition.
    targets.sort((a, b) => a.defence - b.defence);
    const easiest = targets[0];
    const undefended = easiest.defence === 0;
    const favourable = army.strength >= easiest.defence * C.AI_ATTACK_RATIO;

    if (undefended || favourable) {
      orderMove(state, army.province, easiest.target);
      continue;
    }

    // Not strong enough to push: reinforce a neighbouring friendly stack that
    // is closer to the action, so strength pools instead of trickling in.
    const rally = state.map.provinces[army.province].neighbors.find((neighbor) => {
      if (state.owner[neighbor] !== nation) return false;
      const friend = state.armies.get(neighbor);
      return friend !== undefined && friend.owner === nation && friend.strength > army.strength;
    });
    if (rally !== undefined && rng.chance(0.5)) {
      orderMove(state, army.province, rally);
    }
  }
}
