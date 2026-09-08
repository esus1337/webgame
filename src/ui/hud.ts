import { luminance, shadeHex } from '../core/color';
import * as C from '../game/config';
import { garrisonStrength } from '../game/sim';
import type { GameState, ProvinceId } from '../game/types';

const TERRAIN_LABEL: Record<C.Terrain, string> = {
  plains: 'Plains',
  forest: 'Forest',
  hills: 'Hills',
  mountains: 'Mountains',
};

export interface HudCallbacks {
  onTogglePause(): void;
  onSetSpeed(index: number): void;
  onRecruit(province: ProvinceId): void;
  onCancelOrder(province: ProvinceId): void;
  onClearSelection(): void;
  onMenu(): void;
}

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

/** Formats a game day as a compact year/day, which reads better than a raw count. */
function formatDate(day: number): string {
  const year = Math.floor(day / 360) + 1;
  const dayOfYear = (day % 360) + 1;
  return `Y${year} · D${String(dayOfYear).padStart(3, '0')}`;
}

/**
 * The chrome around the map: a status bar along the top and a details panel for
 * the current selection, which becomes a bottom sheet on narrow screens.
 */
export class Hud {
  readonly root: HTMLElement;

  private readonly nationChip: HTMLElement;
  private readonly nationName: HTMLElement;
  private readonly manpower: HTMLElement;
  private readonly industry: HTMLElement;
  private readonly landShare: HTMLElement;
  private readonly date: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly speedButtons: HTMLButtonElement[] = [];

  private readonly panel: HTMLElement;
  private readonly panelTitle: HTMLElement;
  private readonly panelSubtitle: HTMLElement;
  private readonly panelStats: HTMLElement;
  private readonly panelHint: HTMLElement;
  private readonly recruitButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;

  private readonly toast: HTMLElement;
  private toastTimer = 0;

  private selection: ProvinceId | null = null;

  constructor(private readonly callbacks: HudCallbacks) {
    this.root = el('div', 'hud');

    /* Top bar --------------------------------------------------------- */
    const top = el('header', 'topbar');

    const identity = el('button', 'identity');
    identity.type = 'button';
    this.nationChip = el('span', 'chip');
    this.nationName = el('span', 'identity-name', '—');
    identity.append(this.nationChip, this.nationName);
    identity.addEventListener('click', () => this.callbacks.onMenu());
    identity.title = 'Menu';

    const stats = el('div', 'stats');
    this.manpower = el('span', 'stat-value', '0');
    this.industry = el('span', 'stat-value', '0');
    this.landShare = el('span', 'stat-value', '0%');
    stats.append(
      statBlock('Men', this.manpower),
      statBlock('Ind', this.industry),
      statBlock('Land', this.landShare),
    );

    const clock = el('div', 'clock');
    this.date = el('span', 'date', formatDate(0));

    this.pauseButton = el('button', 'speed-button pause');
    this.pauseButton.type = 'button';
    this.pauseButton.textContent = '▶';
    this.pauseButton.title = 'Pause / resume (space)';
    this.pauseButton.addEventListener('click', () => this.callbacks.onTogglePause());

    const speeds = el('div', 'speeds');
    C.SPEEDS.forEach((speed, index) => {
      const button = el('button', 'speed-button', `${speed}×`);
      button.type = 'button';
      button.title = `Speed ${speed}× (${index + 1})`;
      button.addEventListener('click', () => this.callbacks.onSetSpeed(index));
      this.speedButtons.push(button);
      speeds.append(button);
    });

    clock.append(this.date, this.pauseButton, speeds);
    top.append(identity, stats, clock);

    /* Selection panel ------------------------------------------------- */
    this.panel = el('section', 'panel');
    this.panel.hidden = true;

    const header = el('div', 'panel-header');
    const titles = el('div', 'panel-titles');
    this.panelTitle = el('h2', 'panel-title', '');
    this.panelSubtitle = el('p', 'panel-subtitle', '');
    titles.append(this.panelTitle, this.panelSubtitle);

    const close = el('button', 'panel-close', '✕');
    close.type = 'button';
    close.title = 'Close (esc)';
    close.addEventListener('click', () => this.callbacks.onClearSelection());
    header.append(titles, close);

    this.panelStats = el('div', 'panel-stats');
    this.panelHint = el('p', 'panel-hint', '');

    const actions = el('div', 'panel-actions');
    this.recruitButton = el('button', 'action primary', 'Recruit');
    this.recruitButton.type = 'button';
    this.recruitButton.addEventListener('click', () => {
      if (this.selection !== null) this.callbacks.onRecruit(this.selection);
    });
    this.cancelButton = el('button', 'action', 'Cancel order');
    this.cancelButton.type = 'button';
    this.cancelButton.addEventListener('click', () => {
      if (this.selection !== null) this.callbacks.onCancelOrder(this.selection);
    });
    actions.append(this.recruitButton, this.cancelButton);

    this.panel.append(header, this.panelStats, this.panelHint, actions);

    this.toast = el('div', 'toast');
    this.toast.hidden = true;

    this.root.append(top, this.panel, this.toast);
  }

  showToast(message: string): void {
    this.toast.textContent = message;
    this.toast.hidden = false;
    this.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.classList.remove('visible');
    }, 2200);
  }

  update(state: GameState, selected: ProvinceId | null): void {
    this.selection = selected;
    const player = state.map.nations[state.playerNation];
    const pool = state.nations[state.playerNation];

    this.nationChip.style.background = player.color;
    this.nationName.textContent = player.name;
    this.manpower.textContent = String(Math.floor(pool.manpower));
    this.industry.textContent = String(Math.floor(pool.industry));
    this.landShare.textContent = `${Math.round((100 * pool.provinceCount) / state.owner.length)}%`;
    this.date.textContent = formatDate(state.day);

    this.pauseButton.textContent = state.paused ? '▶' : '❚❚';
    this.pauseButton.classList.toggle('active', !state.paused);
    this.speedButtons.forEach((button, index) => {
      button.classList.toggle('active', !state.paused && index === state.speedIndex);
    });

    if (selected === null) {
      this.panel.hidden = true;
      return;
    }
    this.renderSelection(state, selected);
  }

  private renderSelection(state: GameState, province: ProvinceId): void {
    const data = state.map.provinces[province];
    const owner = state.owner[province];
    const nation = state.map.nations[owner];
    const army = state.armies.get(province);
    const isPlayers = owner === state.playerNation;
    const isCapital = state.map.nations[owner].capital === province;

    this.panel.hidden = false;
    this.panelTitle.textContent = data.name;

    const occupied = data.initialOwner !== owner;
    this.panelSubtitle.textContent = [
      nation.name,
      isCapital ? 'capital' : null,
      occupied ? 'occupied' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    // Lift dark nation colors so the subtitle stays legible on the dark panel.
    this.panelSubtitle.style.color =
      luminance(nation.color) > 110 ? nation.color : shadeHex(nation.color, 0.35);

    const yieldScale = occupied ? C.OCCUPIED_YIELD : 1;
    this.panelStats.replaceChildren(
      statRow('Terrain', TERRAIN_LABEL[data.terrain]),
      statRow('Defence', `×${C.TERRAIN[data.terrain].defense.toFixed(2)}`),
      statRow('Militia', garrisonStrength(state, province).toFixed(0)),
      statRow(
        'Yield',
        `${(data.manpower * yieldScale).toFixed(1)} men · ${(data.industry * yieldScale).toFixed(1)} ind`,
      ),
      statRow('Garrison', army ? `${Math.round(army.strength)} (${state.map.nations[army.owner].name})` : 'none'),
    );

    const playerArmy = army && army.owner === state.playerNation ? army : undefined;
    const canRecruitHere = isPlayers && (!army || army.owner === state.playerNation);
    const affordable =
      state.nations[state.playerNation].manpower >= C.RECRUIT_MANPOWER_COST &&
      state.nations[state.playerNation].industry >= C.RECRUIT_INDUSTRY_COST;

    this.recruitButton.hidden = !canRecruitHere;
    this.recruitButton.disabled = !affordable;
    this.recruitButton.textContent = `Recruit +${C.RECRUIT_BATCH} (${C.RECRUIT_MANPOWER_COST}m ${C.RECRUIT_INDUSTRY_COST}i)`;

    this.cancelButton.hidden = !playerArmy?.order;

    if (playerArmy?.order) {
      const target = state.map.provinces[playerArmy.order.target].name;
      this.panelHint.textContent =
        playerArmy.order.progress >= 1
          ? `Assaulting ${target}.`
          : `Marching on ${target} — ${Math.round(playerArmy.order.progress * 100)}%.`;
    } else if (playerArmy) {
      this.panelHint.textContent = 'Tap a bordering province to march there.';
    } else if (isPlayers) {
      this.panelHint.textContent = 'No troops here. Recruit to raise a stack.';
    } else {
      this.panelHint.textContent = 'Foreign soil. Select one of your own stacks to attack it.';
    }
  }
}

function statBlock(label: string, value: HTMLElement): HTMLElement {
  const block = el('div', 'stat');
  block.append(el('span', 'stat-label', label), value);
  return block;
}

function statRow(label: string, value: string): HTMLElement {
  const row = el('div', 'stat-row');
  row.append(el('span', 'stat-row-label', label), el('span', 'stat-row-value', value));
  return row;
}
