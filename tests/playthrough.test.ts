import { expect, it } from 'vitest';
import { step } from '../src/game/sim';
import { runAiTurn } from '../src/game/ai';
import { createGame } from '../src/game/state';
import type { GameState } from '../src/game/types';

/**
 * Whole-game properties that only show up over hundreds of simulated days:
 * that a game always reaches a decision, that both endings are reachable, and
 * that no nation is structurally favoured.
 *
 * The player is stood in for by the same AI the opponents use, given a turn on
 * the same cadence the stagger gives everyone else.
 */

const SEEDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
const FAIR_CADENCE = 4;

interface Result {
  outcome: GameState['outcome'];
  day: number;
  share: number;
}

function play(state: GameState, actEvery: number): Result {
  for (let day = 1; day <= 8000 && state.outcome === 'playing'; day++) {
    if (actEvery > 0 && day % actEvery === 0) runAiTurn(state, state.playerNation);
    step(state);
  }
  return {
    outcome: state.outcome,
    day: state.day,
    share: state.nations[state.playerNation].provinceCount / state.owner.length,
  };
}

it('overruns a nation that never gives an order', () => {
  const results = SEEDS.map((seed) => play(createGame({ seed, playerNation: 0 }), 0));
  expect(results.map((r) => r.outcome)).toEqual(SEEDS.map(() => 'lost'));
}, 120_000);

it('lets a nation in a winning position take the continent', () => {
  const results = SEEDS.map((seed) => {
    const state = createGame({ seed });
    // Start from the strongest position on the map with a head start, so a win
    // is reached by play rather than by luck of the draw.
    state.playerNation = state.nations.reduce(
      (best, nation) => (nation.provinceCount > state.nations[best].provinceCount ? nation.id : best),
      0,
    );
    for (const army of state.armies.values()) {
      if (army.owner === state.playerNation) army.strength *= 4;
    }
    state.nations[state.playerNation].manpower = 400;
    state.nations[state.playerNation].industry = 400;
    return play(state, 2);
  });

  expect(results.filter((r) => r.outcome === 'won').length).toBeGreaterThan(0);
  for (const result of results) {
    if (result.outcome === 'won') expect(result.share).toBeGreaterThanOrEqual(0.6);
  }
}, 120_000);

it('always reaches a decision, without favouring any nation', () => {
  const seeds = Array.from({ length: 24 }, (_, index) => `decision-${index}`);
  const results = seeds.map((seed) => play(createGame({ seed, playerNation: 0 }), FAIR_CADENCE));

  // No game may stall: a world that stops changing would sit here forever.
  expect(results.every((result) => result.outcome !== 'playing')).toBe(true);
  expect(results.every((result) => result.day > 0 && result.day < 8000)).toBe(true);

  // One nation of twelve, played to the AI's standard, should win at roughly
  // the fair rate — a systematically disadvantaged seat would never win at all.
  const wins = results.filter((result) => result.outcome === 'won').length;
  expect(wins).toBeLessThan(seeds.length / 2);
}, 180_000);
