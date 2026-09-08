import type { SaveData } from '../game/state';

const KEY = 'province-conquest:save:v1';

/**
 * localStorage can throw outright (private modes, blocked site data) rather
 * than merely returning null, so every access is guarded and a failure just
 * means the game runs without saving.
 */
export function loadSave(): SaveData | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    return typeof data?.version === 'number' ? data : null;
  } catch {
    return null;
  }
}

export function writeSave(data: SaveData): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* Saving is a convenience; never let it break the game. */
  }
}

export function clearSave(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
