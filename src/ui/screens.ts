import * as C from '../game/config';
import type { GameState, NationId } from '../game/types';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function randomSeed(): string {
  const words = [
    'ember', 'north', 'salt', 'iron', 'harbor', 'ridge', 'delta', 'crown',
    'amber', 'frost', 'stone', 'tide', 'vale', 'wolf', 'lark', 'quarry',
  ];
  const pick = (): string => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 900 + 100)}`;
}

export interface StartScreenCallbacks {
  /** Regenerate the previewed world from these settings. */
  onPreview(seed: string, nationCount: number): void;
  onChooseNation(nation: NationId): void;
  onBegin(): void;
  /** Dismiss the pause menu and carry on with the game in progress. */
  onResume(): void;
  /** Abandon the game in progress and set up a new world. */
  onNewWorld(): void;
  onContinue(): void;
}

/**
 * 'new' sets up a world to play; 'menu' is the same overlay reopened mid-game,
 * where the world settings and the choice of nation are no longer on offer —
 * changing either halfway through would not be a menu, it would be a cheat.
 */
export type StartMode = 'new' | 'menu';

/**
 * The opening overlay. The generated world is already rendered behind it, so
 * settings and the choice of nation are made against the map you will play.
 */
export class StartScreen {
  readonly root: HTMLElement;

  private readonly seedInput: HTMLInputElement;
  private readonly nationsInput: HTMLInputElement;
  private readonly nationsValue: HTMLElement;
  private readonly nationList: HTMLElement;
  private readonly continueButton: HTMLButtonElement;
  private readonly primaryButton: HTMLButtonElement;
  private readonly newWorldButton: HTMLButtonElement;
  private readonly settingsRows: HTMLElement[];
  private readonly lede: HTMLElement;
  private readonly heading: HTMLElement;
  private mode: StartMode = 'new';
  private resumable = false;

  constructor(private readonly callbacks: StartScreenCallbacks) {
    this.root = el('div', 'overlay start');

    const card = el('div', 'card');
    this.heading = el('h1', 'title', 'Province Conquest');
    this.lede = el(
      'p',
      'lede',
      'A continent of invented nations, generated fresh every game. Raise armies, take ground, hold three fifths of the land.',
    );
    card.append(this.heading, this.lede);

    /* Seed ------------------------------------------------------------ */
    const seedRow = el('div', 'field');
    seedRow.append(el('label', 'field-label', 'World seed'));
    const seedGroup = el('div', 'field-group');
    this.seedInput = el('input', 'text-input');
    this.seedInput.type = 'text';
    this.seedInput.value = randomSeed();
    this.seedInput.spellcheck = false;
    this.seedInput.autocapitalize = 'off';
    this.seedInput.setAttribute('aria-label', 'World seed');

    const shuffle = el('button', 'action', 'Shuffle');
    shuffle.type = 'button';
    shuffle.addEventListener('click', () => {
      this.seedInput.value = randomSeed();
      this.preview();
    });
    this.seedInput.addEventListener('change', () => this.preview());
    seedGroup.append(this.seedInput, shuffle);
    seedRow.append(seedGroup);

    /* Nation count ---------------------------------------------------- */
    const nationsRow = el('div', 'field');
    const nationsLabel = el('label', 'field-label', 'Nations');
    this.nationsValue = el('span', 'field-value', String(C.DEFAULT_NATION_COUNT));
    nationsLabel.append(this.nationsValue);

    this.nationsInput = el('input', 'range-input');
    this.nationsInput.type = 'range';
    this.nationsInput.min = String(C.MIN_NATION_COUNT);
    this.nationsInput.max = String(C.MAX_NATION_COUNT);
    this.nationsInput.value = String(C.DEFAULT_NATION_COUNT);
    this.nationsInput.setAttribute('aria-label', 'Number of nations');
    this.nationsInput.addEventListener('input', () => {
      this.nationsValue.textContent = this.nationsInput.value;
    });
    this.nationsInput.addEventListener('change', () => this.preview());
    nationsRow.append(nationsLabel, this.nationsInput);

    /* Nation picker --------------------------------------------------- */
    const pickRow = el('div', 'field');
    pickRow.append(el('label', 'field-label', 'Play as'));
    this.nationList = el('div', 'nation-list');
    pickRow.append(this.nationList);

    /* Actions --------------------------------------------------------- */
    const actions = el('div', 'card-actions');
    this.primaryButton = el('button', 'action primary large', 'Begin');
    this.primaryButton.type = 'button';
    this.primaryButton.addEventListener('click', () => {
      if (this.mode === 'menu') this.callbacks.onResume();
      else this.callbacks.onBegin();
    });

    this.continueButton = el('button', 'action large', 'Continue saved game');
    this.continueButton.type = 'button';
    this.continueButton.hidden = true;
    this.continueButton.addEventListener('click', () => this.callbacks.onContinue());

    this.newWorldButton = el('button', 'action large', 'Abandon and start over');
    this.newWorldButton.type = 'button';
    this.newWorldButton.hidden = true;
    this.newWorldButton.addEventListener('click', () => this.callbacks.onNewWorld());

    actions.append(this.primaryButton, this.continueButton, this.newWorldButton);
    this.settingsRows = [seedRow, nationsRow, pickRow];
    card.append(seedRow, nationsRow, pickRow, actions);
    this.root.append(card);
  }

  setMode(mode: StartMode): void {
    this.mode = mode;
    const isMenu = mode === 'menu';

    for (const row of this.settingsRows) row.hidden = isMenu;
    this.newWorldButton.hidden = !isMenu;
    this.primaryButton.textContent = isMenu ? 'Resume' : 'Begin';
    this.heading.textContent = isMenu ? 'Paused' : 'Province Conquest';
    this.lede.textContent = isMenu
      ? 'The war waits. Resume when you are ready.'
      : 'A continent of invented nations, generated fresh every game. Raise armies, take ground, hold three fifths of the land.';
    this.continueButton.hidden = isMenu || !this.resumable;
  }

  private preview(): void {
    this.callbacks.onPreview(this.seedInput.value.trim() || randomSeed(), this.nationCount);
  }

  get seed(): string {
    return this.seedInput.value.trim() || randomSeed();
  }

  get nationCount(): number {
    return Number(this.nationsInput.value);
  }

  setSeed(seed: string): void {
    this.seedInput.value = seed;
  }

  setResumable(resumable: boolean): void {
    this.resumable = resumable;
    this.continueButton.hidden = this.mode === 'menu' || !resumable;
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  /** Rebuilds the nation chips for a freshly generated world. */
  setNations(state: GameState): void {
    const chips = state.map.nations.map((nation) => {
      const chip = el('button', 'nation-chip');
      chip.type = 'button';
      chip.dataset.nation = String(nation.id);
      chip.setAttribute(
        'aria-label',
        `Play as ${nation.name}, ${state.nations[nation.id].provinceCount} provinces`,
      );

      const swatch = el('span', 'nation-swatch');
      swatch.style.background = nation.color;
      chip.append(
        swatch,
        el('span', 'nation-chip-name', nation.name),
        el('span', 'nation-chip-size', String(state.nations[nation.id].provinceCount)),
      );
      chip.addEventListener('click', () => this.callbacks.onChooseNation(nation.id));
      return chip;
    });

    this.nationList.replaceChildren(...chips);
    this.highlightNation(state.playerNation);
  }

  highlightNation(nation: NationId): void {
    for (const chip of this.nationList.children) {
      chip.classList.toggle('selected', chip instanceof HTMLElement && Number(chip.dataset.nation) === nation);
    }
    const selected = this.nationList.querySelector('.nation-chip.selected');
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

export interface GameOverCallbacks {
  onRestart(): void;
  onKeepWatching(): void;
}

export class GameOverScreen {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;

  constructor(callbacks: GameOverCallbacks) {
    this.root = el('div', 'overlay result');
    this.root.hidden = true;

    const card = el('div', 'card');
    this.title = el('h1', 'title', '');
    this.body = el('p', 'lede', '');

    const actions = el('div', 'card-actions');
    const restart = el('button', 'action primary large', 'New game');
    restart.type = 'button';
    restart.addEventListener('click', () => callbacks.onRestart());

    // The simulation has stopped for good at this point, so this only dismisses
    // the overlay to let the player look over the final map.
    const watch = el('button', 'action large', 'View the final map');
    watch.type = 'button';
    watch.addEventListener('click', () => callbacks.onKeepWatching());

    actions.append(restart, watch);
    card.append(this.title, this.body, actions);
    this.root.append(card);
  }

  show(state: GameState): void {
    const won = state.outcome === 'won';
    const nation = state.map.nations[state.playerNation];
    const share = Math.round((100 * state.nations[state.playerNation].provinceCount) / state.owner.length);
    const years = (state.day / 360).toFixed(1);

    this.title.textContent = won ? 'The continent is yours' : 'Your nation has fallen';
    this.body.textContent = won
      ? `${nation.name} holds ${share}% of the land after ${years} years of war.`
      : `${nation.name} was erased from the map after ${years} years.`;
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }
}
