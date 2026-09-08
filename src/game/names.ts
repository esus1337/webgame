import type { Rng } from '../core/rng';

/**
 * Procedural place names. Deliberately invented — the game has no historical
 * content, so nothing here should read as a real country.
 */

const ONSETS = [
  'b', 'br', 'd', 'dr', 'f', 'g', 'gr', 'h', 'k', 'kr', 'l', 'm', 'n', 'p', 'pr',
  'r', 's', 'sk', 'sl', 'st', 't', 'tr', 'v', 'z', 'th', 'ch', 'sh', 'kh', 'j',
];

const NUCLEI = ['a', 'e', 'i', 'o', 'u', 'ae', 'ei', 'ia', 'ou', 'au', 'y', 'oa'];

const CODAS = ['n', 'r', 'l', 's', 'm', 'th', 'sk', 'nd', 'rn', 'ld', 'st', 'lk', ''];

const ENDINGS = [
  'ia', 'land', 'mark', 'stan', 'ovia', 'aria', 'eth', 'or', 'esse', 'ora',
  'ika', 'une', 'gard', 'holm', 'vik', 'dor', 'ane', 'ux',
];

const FORMS = [
  '{name}',
  '{name}',
  '{name}',
  'Republic of {name}',
  'Kingdom of {name}',
  'Federation of {name}',
  'Union of {name}',
  'Free State of {name}',
  'Dominion of {name}',
  'Commonwealth of {name}',
];

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function syllable(rng: Rng, allowCoda: boolean): string {
  const onset = rng.pick(ONSETS);
  const nucleus = rng.pick(NUCLEI);
  const coda = allowCoda && rng.chance(0.45) ? rng.pick(CODAS) : '';
  return onset + nucleus + coda;
}

/** A bare place name, e.g. "Vareth" or "Drossia". */
export function generateName(rng: Rng): string {
  let word = '';
  // Keep building until the name has enough body to read as a place. A single
  // short syllable with no ending ("Su") looks like a bug rather than a name.
  do {
    const syllables = rng.chance(0.55) ? 2 : 1;
    word = '';
    for (let i = 0; i < syllables; i++) {
      word += syllable(rng, i === syllables - 1);
    }
    if (rng.chance(0.6)) {
      word += rng.pick(ENDINGS);
    }
    // Collapse the triple letters that syllable joins occasionally produce.
    word = word.replace(/(.)\1{2,}/g, '$1$1');
  } while (word.length < 4);
  return capitalize(word);
}

/** A nation name, sometimes dressed with a form of government. */
export function generateNationName(rng: Rng): string {
  return rng.pick(FORMS).replace('{name}', generateName(rng));
}

/**
 * Draws unique names from `generate`, giving up on uniqueness after enough
 * collisions so a small syllable space can never hang generation.
 */
export function createNameGenerator(
  rng: Rng,
  generate: (rng: Rng) => string,
): () => string {
  const used = new Set<string>();
  return () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const name = generate(rng);
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
    let suffix = 2;
    let name = generate(rng);
    while (used.has(`${name} ${suffix}`)) suffix++;
    name = `${name} ${suffix}`;
    used.add(name);
    return name;
  };
}
