// Consistency tests for the preset search engines in popup.html (issue #23).
//
// The presets are hardcoded data-url attributes in the options page. If a
// vendor ever changes a search URL — or an edit drops the %s placeholder —
// the user hits an "invalid URL" state the moment they click the preset,
// with no CI signal. This test iterates every preset and asserts the popup's
// own validator (validateSearchUrl, safe mode) accepts it, so any drift
// fails the build. Same pattern as tests/manifest-consistency.test.js (#9)
// and tests/blocked-schemes-consistency.test.js (#18).
//
// The SearXNG localhost preset is an intentional local-dev exception. It is
// pinned explicitly here so a future "harden all presets" pass (or a
// validation tightening) cannot silently break it — or quietly re-allow it
// — without updating this test on purpose.
//
// popup.html is parsed as text (no module import, no chrome mock), so the
// test runs with plain `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSearchUrl } from '../QueryHop Extension/Resources/popupRules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const popupPath = path.join(root, 'QueryHop Extension/Resources/popup.html');
assert.ok(fs.existsSync(popupPath), 'popup.html is missing');
const popupHtml = fs.readFileSync(popupPath, 'utf8');

// Extract { url, name } for every preset button (role="option").
function extractPresets(html) {
  const presets = [];
  const buttonRe = /<button\b[^>]*\brole="option"[^>]*>[\s\S]*?<\/button>/g;
  for (const block of html.matchAll(buttonRe)) {
    const full = block[0];
    const tag = full.slice(0, full.indexOf('>'));
    const url = tag.match(/\bdata-url="([^"]*)"/)?.[1] ?? null;
    const name = full.match(/<span class="preset-name">([^<]*)<\/span>/)?.[1] ?? '';
    presets.push({ url, name: name.trim() });
  }
  return presets;
}

const presets = extractPresets(popupHtml);

test('popup.html still defines the expected preset count (11)', () => {
  // Pins the list: removing or adding a preset is a deliberate act and must
  // bump this count (and the README's preset list) in the same change.
  assert.equal(presets.length, 11, `expected 11 presets, found ${presets.length}: ${presets.map((p) => p.name || p.url).join(', ')}`);
});

test('every preset has a non-empty display name', () => {
  const missing = presets.filter((p) => !p.name);
  assert.deepEqual(
    missing.map((p) => p.url),
    [],
    `presets with an empty .preset-name: ${missing.map((p) => p.url).join(', ')}`
  );
});

test('preset display names are unique', () => {
  const counts = new Map();
  for (const p of presets) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepEqual(dupes, [], `duplicate preset names: ${dupes.join(', ')}`);
});

test('every preset URL passes validateSearchUrl in safe mode (#23)', () => {
  // The popup runs the same validator on a selected preset before saving.
  // If any preset fails it here, clicking that preset in the UI shows an
  // "invalid URL" state with no way to proceed.
  for (const p of presets) {
    const r = validateSearchUrl(p.url, false);
    assert.equal(r.isValid, true, `${p.name} preset ${p.url} is rejected by the popup's own validator: ${r.message}`);
  }
});

test('the SearXNG localhost preset is pinned as an intentional exception (#23)', () => {
  // http:// (not https) + a localhost host is the one preset the
  // "hardened" rules might flag. Pin it explicitly: it must keep existing,
  // keep being valid, keep pointing at localhost, and keep announcing
  // itself as the local Docker default.
  const searxng = presets.find((p) => p.url === 'http://localhost:8080/search?q=%s');
  assert.ok(searxng, 'SearXNG localhost preset (http://localhost:8080/search?q=%s) is missing');
  assert.equal(validateSearchUrl(searxng.url, false).isValid, true, 'SearXNG localhost preset must stay valid in safe mode');
  assert.equal(new URL(searxng.url).hostname, 'localhost');
  assert.match(searxng.name, /localhost:8080/i, 'SearXNG preset name should still advertise the localhost port');
});

test('all non-localhost presets use https', () => {
  // The localhost preset is the documented exception; every other preset
  // ships a plain-text query to a third party, so it must be TLS.
  for (const p of presets) {
    if (p.url === 'http://localhost:8080/search?q=%s') continue;
    const u = new URL(p.url);
    assert.equal(u.protocol, 'https:', `${p.name} preset must be https: ${p.url}`);
  }
});
