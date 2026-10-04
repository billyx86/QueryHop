// Regression guard (issue #77): the chrome.webNavigation.onBeforeNavigate
// listener in background.js must NOT be registered with a malformed `url`
// filter.
//
// It used to be registered as:
//   addListener(async (details) => {...},
//     { url: searchEngines.map(engine => ({ urlMatches: engine.pattern.source })) })
// but `urlMatches` is not a chrome.webNavigation filter key (the key is `url`,
// which takes an array of MatchPattern *strings*) and the mapped values are
// regex sources, not MatchPatterns. The filter was therefore never valid, and
// the redirect may never have fired in a real browser — the authoritative
// match is the `engine.pattern.test(url)` loop inside handleNavigation(),
// which runs on every top-frame navigation regardless.
//
// Deriving valid MatchPatterns from the regexes would reintroduce a third
// surface (regex, host_permissions, MatchPattern) that must stay in lockstep —
// exactly the drift this repo's other guards exist to prevent. The fix is to
// drop the filter and let handleNavigation() match. This guard fails the build
// if the malformed filter is ever reintroduced, or if the authoritative
// matcher is deleted on the assumption the filter is doing the work.
//
// Parsed as text (no module import, no chrome mock), so it runs with plain
// `node --test` — same pattern as blocked-schemes-consistency.test.js (#18).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backgroundPath = path.join(root, 'QueryHop Extension/Resources/background.js');

assert.ok(fs.existsSync(backgroundPath), 'background.js is missing');
const worker = fs.readFileSync(backgroundPath, 'utf8');

test('background.js never registers the malformed urlMatches webNavigation filter (#77)', () => {
  assert.doesNotMatch(
    worker,
    /urlMatches/,
    'background.js references `urlMatches`, which is not a chrome.webNavigation ' +
      'filter key. The onBeforeNavigate listener must not be passed a `url` filter ' +
      'derived from the engine regex sources — handleNavigation() is the authoritative matcher.'
  );
  assert.doesNotMatch(
    worker,
    /url:\s*searchEngines/,
    'background.js maps searchEngines into a `url` webNavigation filter. ' +
      'The filter was malformed (issue #77) and is intentionally absent; ' +
      'do not reintroduce it.'
  );
});

test('background.js still registers the onBeforeNavigate listener (#77)', () => {
  assert.match(
    worker,
    /chrome\.webNavigation\.onBeforeNavigate\.addListener\s*\(/,
    'background.js is missing the chrome.webNavigation.onBeforeNavigate.addListener registration'
  );
});

test('background.js keeps the authoritative searchEngines regex matcher (#77)', () => {
  // The filter is only an optimization; the real decision is testing each
  // engine regex against the navigation URL inside handleNavigation(). If
  // this loop is removed the redirect stops working entirely.
  assert.match(
    worker,
    /for\s*\(const\s+engine\s+of\s+searchEngines\)/,
    'background.js no longer loops over searchEngines — the authoritative match may be gone'
  );
  assert.match(
    worker,
    /engine\.pattern\.test\s*\(/,
    'background.js no longer tests engine.pattern against the URL — the authoritative match may be gone'
  );
  assert.match(
    worker,
    /function\s+handleNavigation\s*\(/,
    'background.js is missing handleNavigation()'
  );
});
