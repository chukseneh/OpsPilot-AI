// The example policy packs shipped with OpsPilot (STORY-009). They are
// ILLUSTRATIVE: real sources, example values, not legal advice. A compliance
// officer adapts one, has it reviewed, and proposes it through the governance
// service; it takes effect only once a second person approves it.

import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'));

// A fresh copy each time, so nobody can change the shipped examples by accident.
export const examplePack = (code) => {
  const file = { UK: 'uk', EU: 'eu' }[code];
  if (!file) throw new Error(`There is no example pack for "${code}" (available: UK, EU).`);
  return load(file);
};
export const EXAMPLE_JURISDICTIONS = Object.freeze(['UK', 'EU']);
