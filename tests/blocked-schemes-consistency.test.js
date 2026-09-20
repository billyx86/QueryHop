// Invariant tests: the BLOCKED_SCHEMES denylist in background.js (the
// authoritative navigation gate) must stay in sync with the copy in
// popupRules.js (the popup's configuration validator) — issue #18.
//
// The two files live in separate JS contexts (service worker vs. popup
// page), so a direct import is impossible and the lists are duplicated by
// hand. Nothing else enforces the invariant: the day a scheme is added to
// one list and not the other, the popup and the background silently
// disagree about what "unsafe mode" allows. This test fails the build on
// that drift — same pattern as tests/manifest-consistency.test.js (engine
// regex vs. host_permissions, #9).
//
// Both files are parsed as text (no module import, no chrome mock), so the
// test runs with plain `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourceDir = path.join(root, 'QueryHop Extension/Resources');
const backgroundPath = path.join(resourceDir, 'background.js');
const popupRulesPath = path.join(resourceDir, 'popupRules.js');

assert.ok(fs.existsSync(backgroundPath), 'background.js is missing');
assert.ok(fs.existsSync(popupRulesPath), 'popupRules.js is missing');

const background = fs.readFileSync(backgroundPath, 'utf8');
const popupRules = fs.readFileSync(popupRulesPath, 'utf8');

// Extract the string literal entries of `const BLOCKED_SCHEMES = [...]`.
// Works for both the plain `const` (background.js) and the
// `export const` (popupRules.js) declaration.
function extractBlockedSchemes(source, label) {
  const m = source.match(/BLOCKED_SCHEMES\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, `${label} is missing the BLOCKED_SCHEMES array`);
  const schemes = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(
    schemes.length > 0,
    `${label}: BLOCKED_SCHEMES parsed empty — extraction broke or the list was deleted`
  );
  return schemes;
}

const backgroundSchemes = extractBlockedSchemes(background, 'background.js');
const popupRulesSchemes = extractBlockedSchemes(popupRules, 'popupRules.js');

const asSet = (list) => new Set(list);

test('BLOCKED_SCHEMES: background.js and popupRules.js agree as sets (#18)', () => {
  const a = asSet(backgroundSchemes);
  const b = asSet(popupRulesSchemes);
  const onlyBackground = [...a].filter((s) => !b.has(s));
  const onlyPopup = [...b].filter((s) => !a.has(s));
  assert.deepEqual(
    onlyBackground,
    [],
    `schemes in background.js but NOT in popupRules.js: ${onlyBackground.join(', ')}`
  );
  assert.deepEqual(
    onlyPopup,
    [],
    `schemes in popupRules.js but NOT in background.js: ${onlyPopup.join(', ')}`
  );
});

test('BLOCKED_SCHEMES: both files keep the isBlockedScheme gate', () => {
  // A list without its checker is as bad as a drifted list: the denylist
  // must be consulted, in both contexts.
  assert.ok(
    /function\s+isBlockedScheme\s*\(/.test(background),
    'background.js is missing the isBlockedScheme() gate'
  );
  assert.ok(
    /function\s+isBlockedScheme\s*\(/.test(popupRules),
    'popupRules.js is missing the isBlockedScheme() gate'
  );
});

test('BLOCKED_SCHEMES: the core code-injection primitives are denylisted', () => {
  // Even if both lists drifted together, these must never be missing —
  // they are the schemes an unsafe-mode URL could turn into code execution.
  const required = ['javascript:', 'data:', 'vbscript:', 'file:', 'chrome-extension:'];
  for (const label of ['background.js', 'popupRules.js']) {
    const set = label === 'background.js' ? asSet(backgroundSchemes) : asSet(popupRulesSchemes);
    const missing = required.filter((s) => !set.has(s));
    assert.deepEqual(missing, [], `${label} is missing core denylisted schemes: ${missing.join(', ')}`);
  }
});
