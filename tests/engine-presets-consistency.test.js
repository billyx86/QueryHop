// Drift guard (issue #25): background.js keeps the SOURCE engine list
// (engines whose searches get redirected) and popup.html keeps the
// DESTINATION preset list (engines searches can be redirected to). The two
// lists are independent, nothing checked they stay stable, and together they
// describe the set of search engines this repo cares about.
//
// The two lists have deliberately different roles (a source engine is not a
// preset), so this guard does NOT assert the sets are equal. Following the
// repo's drift-guard philosophy (#9 TLD drift, #18 denylist duplication,
// #23 preset validation): both lists are pinned as ORDERED sets, so adding,
// removing, or renaming an entry fails the build until the pinned set below
// is updated on purpose in the same change.
//
// Both files are parsed as text (no module import, no chrome mock), so the
// test runs with plain `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backgroundPath = path.join(root, 'QueryHop Extension/Resources/background.js');
const popupPath = path.join(root, 'QueryHop Extension/Resources/popup.html');

assert.ok(fs.existsSync(backgroundPath), 'background.js is missing');
assert.ok(fs.existsSync(popupPath), 'popup.html is missing');

const background = fs.readFileSync(backgroundPath, 'utf8');
const popupHtml = fs.readFileSync(popupPath, 'utf8');

// --- source engines: parse searchEngines from background.js as text ---
const engineBlock = background.match(/const searchEngines = \[([\s\S]*?)\];/);
assert.ok(engineBlock, 'could not find the searchEngines array in background.js');
const engineNames = [...engineBlock[1].matchAll(/\{\s*pattern:\s*\/.+?\/\s*,\s*queryParam:.*?name:\s*"([^"]*)"/g)]
  .map((m) => m[1]);

// --- destination presets: parse the preset buttons from popup.html ---
// Same extraction as tests/preset-consistency.test.js. Since #35 the
// display name carries a data-i18n key; the pin below is on the static
// English fallback text, which must stay the English name even in a
// localized locale.
function extractPresets(html) {
  const presets = [];
  const buttonRe = /<button\b[^>]*\brole="option"[^>]*>[\s\S]*?<\/button>/g;
  for (const block of html.matchAll(buttonRe)) {
    const full = block[0];
    const tag = full.slice(0, full.indexOf('>'));
    const url = tag.match(/\bdata-url="([^"]*)"/)?.[1] ?? null;
    const nameSpan = full.match(/<span class="preset-name"([^>]*)>([^<]*)<\/span>/);
    const name = nameSpan?.[2] ?? '';
    const i18nKey = nameSpan?.[1]?.match(/\bdata-i18n="([a-z_0-9]+)"/)?.[1] ?? null;
    presets.push({ url, name: name.trim(), i18nKey });
  }
  return presets;
}
const presets = extractPresets(popupHtml);

// Pinned sets — the tripwire. Editing either list in the product code
// without updating the pin here fails CI on purpose.
const PINNED_SOURCE_ENGINES = ['Google', 'DuckDuckGo', 'Bing', 'Ecosia', 'Baidu', 'Yahoo', 'Yandex'];
const PINNED_PRESETS = [
  'Ask.com', 'Brave', 'Kagi', 'Lilo', 'Mojeek', 'Perplexity',
  'Presearch', 'Qwant', 'SearXNG Docker Default [localhost:8080]',
  'Startpage', 'You',
];

test('searchEngines (source engines) matches the pinned set, in order (#25)', () => {
  assert.deepEqual(
    engineNames,
    PINNED_SOURCE_ENGINES,
    `source engines drifted from the pinned set.\n  found:  ${JSON.stringify(engineNames)}\n  pinned: ${JSON.stringify(PINNED_SOURCE_ENGINES)}`
  );
});

test('popup.html presets match the pinned set, in order (#25)', () => {
  assert.deepEqual(
    presets.map((p) => p.name),
    PINNED_PRESETS,
    `presets drifted from the pinned set.\n  found:  ${JSON.stringify(presets.map((p) => p.name))}\n  pinned: ${JSON.stringify(PINNED_PRESETS)}`
  );
});

test('every preset points at a legitimate destination host (#25)', () => {
  for (const p of presets) {
    assert.ok(p.url, `${p.name} preset has no data-url`);
    const u = new URL(p.url);
    assert.ok(u.hostname, `${p.name}: empty hostname in ${p.url}`);
    // The pinned SearXNG local-dev exception (http + localhost) is asserted
    // in tests/preset-consistency.test.js; it is not a third-party destination.
    if (p.url === 'http://localhost:8080/search?q=%s') continue;
    assert.ok(!/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname), `${p.name}: preset points at a raw IP: ${p.url}`);
    const tld = u.hostname.split('.').pop();
    assert.match(tld, /^[a-z]{2,}$/, `${p.name}: suspicious TLD in ${p.url}`);
    assert.equal(u.protocol, 'https:', `${p.name}: non-https destination ${p.url}`);
  }
});

test('the two lists keep their expected sizes (count tripwire, #25)', () => {
  // The deep-equals above already enforce this; the explicit counts keep the
  // failure message readable if both lists are edited in one change.
  assert.equal(engineNames.length, 7, `expected 7 source engines, found ${engineNames.length}`);
  assert.equal(presets.length, 11, `expected 11 presets, found ${presets.length}`);
});
