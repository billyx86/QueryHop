// Drift guard for the in-extension popup.html fetch probe in the e2e harness
// (issue #178).
//
// The probe's stated purpose: prove that the extension's own resource
// resolver can load popup.html from inside the service worker. It never
// worked. The probe expression was `new Promise((res) => { … })()` — the
// trailing `()` invoked the returned Promise as a function, so the CDP eval
// threw `TypeError: (intermediate value) is not a function` on EVERY
// full-tier run (ground truth: runs 42481928647 and 43797504551) and the
// failure was caught and downgraded to a trailing note, producing zero
// evidence of the probe's purpose while the net still recorded
// e2e-tier=full.
//
// This test is the tripwire, in the same shape as the #48 test-count, #59
// file-list, #81 import-graph, and #106/#108 chrome-pin guards: it re-reads
// the real harness (and the CI step-summary plumbing) on every run and fails
// on the push that would (a) reintroduce an invoked-Promise wrapper around
// the probe, (b) drop the probe itself, or (c) let a dead probe die quietly
// again by removing the machine-readable `popupProbe` tier-file field that
// the CI step summary surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(root, 'tests', 'e2e-browser.test.js');
const CI = path.join(root, '.github', 'workflows', 'ci.yml');

// Extract the template literal passed to evalValue() that contains the
// popup.html fetch probe. The literal contains no nested backticks (all
// strings inside are single- or double-quoted), so the nearest enclosing
// backticks delimit it exactly.
function probeLiteral() {
  const harness = readFileSync(HARNESS, 'utf8');
  const idx = harness.indexOf("chrome.runtime.getURL('popup.html')");
  assert.ok(idx > -1,
    'the in-extension popup.html fetch probe (chrome.runtime.getURL + fetch) must exist in e2e-browser.test.js');
  const start = harness.lastIndexOf('`', idx);
  const end = harness.indexOf('`', idx);
  assert.ok(start > -1 && end > idx,
    'the probe expression must be a template literal passed to evalValue()');
  return { literal: harness.slice(start + 1, end), harness };
}

test('the popup probe is NOT wrapped in an invoked new Promise (the #178 dead-probe shape)', () => {
  const { literal } = probeLiteral();
  assert.ok(!/new Promise\(/.test(literal),
    'the probe expression must not use a `new Promise(` wrapper at all — the original dead-probe bug was `new Promise((res) => { … })()`, where the trailing `()` invoked the returned Promise as a function and the CDP eval threw "TypeError: (intermediate value) is not a function" on every full-tier run (issue #178). `evalValue` already passes `awaitPromise: true`, so evaluate the awaitable chain directly.');
});

test('the popup probe evaluates the fetch chain as a bare awaitable (async IIFE)', () => {
  const { literal } = probeLiteral();
  assert.ok(/\(async \(\) => \{/.test(literal),
    'the probe must be an async IIFE `(async () => { … })` — a bare awaitable that `evalValue` (awaitPromise: true) resolves. The IIFE keeps the getURL() call inside the try, so even a missing chrome.runtime degrades to the ok:false JSON instead of a throw.');
  // The literal ends with the IIFE invocation: the raw file text reads
  // `…})()`))` (closing paren of the IIFE, the call's `()`, the outer
  // wrapper's `)`, then the closing backtick). An uninvoked
  // `(async () => { … })` would evaluate to the function itself, not the
  // fetch result, so the invocation is load-bearing.
  assert.ok(/\}\)\(\)$/.test(literal.trimEnd()),
    'the probe literal must end by invoking the async IIFE (`})()` — an uninvoked `(async () => { … })` would return the function itself, not the fetch result.');
  assert.ok(literal.includes('await (await fetch('),
    'the probe must await the fetch round-trip (url -> text) rather than rely on a .then() chain wrapped in another Promise.');
});

test('a dead popup probe is loud: machine-readable popupProbe status in the tier file (#178)', () => {
  const { harness } = probeLiteral();
  // The status variable is declared next to popupNote and only takes a
  // machine-readable shape (ok / unavailable / threw) — never a free-text
  // string that the step summary would have to parse.
  assert.ok(/let popupProbe = null;/.test(harness),
    'the harness must declare a machine-readable `popupProbe` status (null = probe never ran, e.g. no SW target).');
  assert.ok(/\{ status: 'ok', len:/.test(harness),
    'a successful probe must be recorded as popupProbe { status: \'ok\', len, hasSave }.');
  assert.ok(/\{ status: 'threw', error:/.test(harness),
    'a thrown probe (the exact failure mode of the old dead probe) must be recorded as popupProbe { status: \'threw\', … } — the tier file, not a trailing note, is where a dead probe is visible.');
  // Both tier writes that happen AFTER the probe ran (the post-probe
  // surface-degraded write and the full-tier write) must carry the status.
  // The pre-probe degraded write (SW not exposed as a CDP target) runs
  // before the probe exists and correctly omits it.
  assert.ok((harness.match(/\{ popupProbe \}/g) || []).length >= 2,
    'the post-probe degraded tier write AND the full tier write must pass `{ popupProbe }` to writeTierFile — a dead probe recorded in only one of the two surfaces that run after the probe would be invisible on the other.');
  // writeTierFile must merge the extra field into the payload LAST, so it
  // can never clobber the core tier/browser/detail/generatedAt fields.
  assert.ok(harness.includes('...(extra && typeof extra === \'object\' ? extra : {})'),
    'writeTierFile must merge its `extra` argument into the tier-file payload (spread last) so the popupProbe status lands in e2e-tier.json as a first-class field.');
});

test('the CI step summary still cats the tier file verbatim (the loud path must reach CI history)', () => {
  const ci = readFileSync(CI, 'utf8');
  assert.ok(ci.includes('cat e2e-tier.json') && ci.includes('GITHUB_STEP_SUMMARY'),
    'the e2e-browser CI job must keep dumping e2e-tier.json into the step summary — that is the surface on which the machine-readable popupProbe status (issue #178) becomes visible in CI history. If the summary step changes, re-prove the probe status still lands there and update this guard.');
});
