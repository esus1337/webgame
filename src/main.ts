import './styles.css';

import * as C from './game/config';
import { cancelOrder, orderMove, recruit, step } from './game/sim';
import { createGame, deserializeGame, serializeGame } from './game/state';
import type { GameState, NationId, ProvinceId } from './game/types';
import { Camera } from './render/camera';
import { PickingMap } from './render/picking';
import { Renderer } from './render/renderer';
import { Hud } from './ui/hud';
import { InputController } from './ui/input';
import { GameOverScreen, StartScreen, randomSeed } from './ui/screens';
import { clearSave, loadSave, writeSave } from './ui/storage';

const AUTOSAVE_INTERVAL_DAYS = 20;

const app = document.getElementById('app');
if (!app) throw new Error('#app is missing');

const canvas = document.createElement('canvas');
canvas.className = 'map';
app.append(canvas);

/* ------------------------------------------------------------------ */
/* Mutable session                                                     */
/* ------------------------------------------------------------------ */

let state: GameState;
let camera: Camera;
let renderer: Renderer;
let picking: PickingMap;

let selected: ProvinceId | null = null;
let hovered: ProvinceId | null = null;
let moveTargets = new Set<ProvinceId>();
/** True while the start overlay is up: the world renders but does not tick. */
let previewing = true;
/** True once a game has actually been started, so the menu knows what to offer. */
let started = false;
/** Whether the game was already paused when the pause menu was opened. */
let pausedBeforeMenu = true;
let lastSavedDay = -1;

/** Rebuilds everything derived from a world. */
function adoptState(next: GameState, options: { keepCamera?: boolean } = {}): void {
  const previous = camera;
  state = next;
  camera = new Camera(state.map.landBounds);
  renderer = new Renderer(canvas, state.map);
  picking = new PickingMap(state.map);

  selected = null;
  hovered = null;
  moveTargets = new Set();
  lastSavedDay = -1;

  resize();
  if (options.keepCamera && previous) {
    camera.zoom = previous.zoom;
    camera.centerOn(previous.x, previous.y, renderer.viewport);
  } else {
    camera.fit(renderer.viewport);
  }
}

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.resize(width, height);
  camera.clampToWorld(renderer.viewport);
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

function playerArmyAt(province: ProvinceId): boolean {
  const army = state.armies.get(province);
  return army !== undefined && army.owner === state.playerNation;
}

function refreshMoveTargets(): void {
  moveTargets = new Set();
  if (selected === null || !playerArmyAt(selected)) return;
  for (const neighbor of state.map.provinces[selected].neighbors) {
    moveTargets.add(neighbor);
  }
}

function select(province: ProvinceId | null): void {
  selected = province;
  refreshMoveTargets();
  hud.update(state, selected);
}

/**
 * The whole order system in one gesture: tap your stack, then tap a bordering
 * province. Adjacency makes the intent unambiguous, so there is no mode to
 * switch and the same two taps work with a mouse or a thumb.
 */
function handleTap(screenX: number, screenY: number): void {
  const worldX = camera.screenToWorldX(screenX, renderer.viewport);
  const worldY = camera.screenToWorldY(screenY, renderer.viewport);
  const province = picking.at(worldX, worldY);

  if (province === null) {
    select(null);
    return;
  }

  if (selected !== null && province !== selected && moveTargets.has(province)) {
    if (orderMove(state, selected, province)) {
      const target = state.map.provinces[province];
      const defended = state.armies.get(province);
      hud.showToast(
        defended && defended.owner !== state.playerNation
          ? `Assaulting ${target.name}`
          : `Marching on ${target.name}`,
      );
      select(province);
      return;
    }
  }

  select(province === selected ? null : province);
}

/* ------------------------------------------------------------------ */
/* HUD and screens                                                     */
/* ------------------------------------------------------------------ */

const hud = new Hud({
  onTogglePause: () => togglePause(),
  onSetSpeed: (index) => setSpeed(index),
  onRecruit: (province) => {
    if (recruit(state, province)) {
      renderer.invalidate();
      hud.update(state, selected);
    } else {
      hud.showToast('Not enough manpower or industry');
    }
  },
  onCancelOrder: (province) => {
    cancelOrder(state, province);
    hud.update(state, selected);
  },
  onClearSelection: () => select(null),
  onMenu: () => openStart({ keepWorld: true }),
});

const startScreen = new StartScreen({
  onPreview: (seed, nationCount) => {
    adoptState(createGame({ seed, nationCount }));
    startScreen.setNations(state);
  },
  onChooseNation: (nation: NationId) => {
    state.playerNation = nation;
    startScreen.highlightNation(nation);
    focusOnPlayer();
    renderer.invalidate();
  },
  onBegin: () => beginGame(),
  onResume: () => resumeFromMenu(),
  onNewWorld: () => openStart({ keepWorld: false }),
  onContinue: () => resumeSave(),
});

const gameOverScreen = new GameOverScreen({
  onRestart: () => {
    gameOverScreen.hide();
    openStart({ keepWorld: false });
  },
  onKeepWatching: () => {
    gameOverScreen.hide();
    // The sim has stopped, but the map stays explorable.
  },
});

app.append(hud.root, startScreen.root, gameOverScreen.root);

/**
 * Frames the player's own territory rather than picking a fixed zoom. A zoom
 * that shows a comfortable slice of a 1440px desktop shows barely a handful of
 * provinces on a 390px phone, so the starting view has to be derived from the
 * nation's real extent and the viewport it has to fit into.
 */
function focusOnPlayer(): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const province of state.map.provinces) {
    if (state.owner[province.id] !== state.playerNation) continue;
    minX = Math.min(minX, province.bounds.minX);
    minY = Math.min(minY, province.bounds.minY);
    maxX = Math.max(maxX, province.bounds.maxX);
    maxY = Math.max(maxY, province.bounds.maxY);
  }

  const view = renderer.viewport;
  if (!Number.isFinite(minX)) {
    camera.fit(view);
    return;
  }

  // Leave the nation filling roughly two thirds of the view, so its borders
  // and the neighbours pressing on them are both visible.
  const fit = camera.fitZoom(view);
  const zoom = Math.min(view.width / (maxX - minX), view.height / (maxY - minY)) * 0.68;
  camera.zoom = Math.min(Math.max(zoom, fit), 3.5);
  camera.centerOn((minX + maxX) / 2, (minY + maxY) / 2, view);
}

function openStart(options: { keepWorld: boolean }): void {
  // Remember whether the player had already paused, so resuming restores the
  // state they left rather than always handing back a running game.
  pausedBeforeMenu = previewing ? true : state.paused;
  previewing = true;
  state.paused = true;
  if (!options.keepWorld) {
    started = false;
    const seed = randomSeed();
    startScreen.setSeed(seed);
    adoptState(createGame({ seed, nationCount: startScreen.nationCount }));
  }
  // Reopening mid-game is a pause menu, not a chance to redraw the world.
  startScreen.setMode(options.keepWorld && started ? 'menu' : 'new');
  startScreen.setNations(state);
  startScreen.setResumable(loadSave() !== null);
  startScreen.show();
  hud.update(state, selected);
}

/** Leaves the pause menu without disturbing the game in progress. */
function resumeFromMenu(): void {
  previewing = false;
  state.paused = pausedBeforeMenu;
  startScreen.hide();
  hud.update(state, selected);
}

function beginGame(): void {
  previewing = false;
  started = true;
  startScreen.hide();
  state.paused = false;
  state.speedIndex = 0;
  focusOnPlayer();
  renderer.invalidate();
  hud.update(state, selected);
  hud.showToast(`You lead ${state.map.nations[state.playerNation].name}`);
}

function resumeSave(): void {
  const data = loadSave();
  const restored = data ? deserializeGame(data) : null;
  if (!restored) {
    hud.showToast('That save could not be loaded');
    clearSave();
    startScreen.setResumable(false);
    return;
  }

  adoptState(restored);
  previewing = false;
  started = true;
  startScreen.hide();
  state.paused = true;
  focusOnPlayer();
  hud.update(state, selected);
  hud.showToast('Game restored — paused');
}

function togglePause(): void {
  if (previewing || state.outcome !== 'playing') return;
  state.paused = !state.paused;
  hud.update(state, selected);
}

function setSpeed(index: number): void {
  if (previewing || state.outcome !== 'playing') return;
  state.speedIndex = Math.min(C.SPEEDS.length - 1, Math.max(0, index));
  state.paused = false;
  hud.update(state, selected);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const initialSeed = randomSeed();
startScreen.setSeed(initialSeed);

state = createGame({ seed: initialSeed, nationCount: C.DEFAULT_NATION_COUNT });
camera = new Camera(state.map.landBounds);
renderer = new Renderer(canvas, state.map);
picking = new PickingMap(state.map);
resize();
camera.fit(renderer.viewport);

startScreen.setNations(state);
startScreen.setResumable(loadSave() !== null);
hud.update(state, null);

new InputController(canvas, () => camera, {
  onTap: (x, y) => {
    if (!previewing) handleTap(x, y);
  },
  onHover: (x, y) => {
    if (previewing) return;
    const worldX = camera.screenToWorldX(x, renderer.viewport);
    const worldY = camera.screenToWorldY(y, renderer.viewport);
    hovered = picking.at(worldX, worldY);
    canvas.style.cursor = hovered === null ? 'default' : 'pointer';
  },
  onHoverEnd: () => {
    hovered = null;
    canvas.style.cursor = 'default';
  },
  onTogglePause: () => togglePause(),
  onSetSpeed: (index) => setSpeed(index),
  onCancel: () => select(null),
});

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => window.setTimeout(resize, 120));

/* ------------------------------------------------------------------ */
/* Frame loop                                                          */
/* ------------------------------------------------------------------ */

let accumulator = 0;
let lastFrame = performance.now();

function frame(now: number): void {
  const elapsed = Math.min(250, now - lastFrame);
  lastFrame = now;

  const running = !previewing && !state.paused && state.outcome === 'playing';
  if (running) {
    accumulator += elapsed * C.SPEEDS[state.speedIndex];
    let steps = 0;
    while (accumulator >= C.MS_PER_DAY && steps < C.MAX_STEPS_PER_FRAME) {
      accumulator -= C.MS_PER_DAY;
      step(state);
      steps++;
    }
    // Drop any backlog rather than fast-forwarding a tab that was hidden.
    if (accumulator >= C.MS_PER_DAY) accumulator = 0;

    if (steps > 0) {
      refreshMoveTargets();
      hud.update(state, selected);
      maybeAutosave();
      if (state.outcome !== 'playing') gameOverScreen.show(state);
    }
  } else {
    accumulator = 0;
  }

  renderer.render({ state, camera, selected, hovered, moveTargets, time: now });
  requestAnimationFrame(frame);
}

function maybeAutosave(): void {
  if (state.outcome !== 'playing') return;
  if (lastSavedDay >= 0 && state.day - lastSavedDay < AUTOSAVE_INTERVAL_DAYS) return;
  lastSavedDay = state.day;
  writeSave(serializeGame(state));
}

requestAnimationFrame(frame);
