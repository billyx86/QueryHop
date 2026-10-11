// Drift guard (issue #99): redactSensitiveUrlParams strips the search term
// out of a logged URL only for param names in its hardcoded
// SEARCH_QUERY_PARAM_NAMES list — that is the #12 contract's last line of
// defence for the query-string position. Each engine's actual term param is
// declared separately in searchEngines (bgCommon.js). Today every engine's
// param happens to be in the list, so there is no live leak — but nothing
// enforced the subset: add an engine with a new param (e.g. `kw`, `s`, `k`)
// and its plaintext term survives redaction in every logged URL, silently
// re-leaking the #12 contract with the whole suite green.
//
// Following the repo's drift-guard philosophy (#18, #25, #27, #76): the
// expected set is DERIVED from the source of truth by text-parsing
// bgCommon.js (the same regex approach manifest-consistency.test.js uses
// for the engine patterns), never copied by hand. Two checks:
//
//   1. every engine queryParam (string or array member) is a member of
//      SEARCH_QUERY_PARAM_NAMES — the live-leak guard, and
//   2. every entry in SEARCH_QUERY_PARAM_NAMES is used by at least one
//      engine OR is a documented synonym — so a silently dropped/renamed
//      list entry (which would stop redacting a real engine param) also
//      fails instead of rotting quietly.
//
// Parsed as text (no module import, no chrome mock): runs with plain
// `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bgCommonPath = path.join(root, 'QueryHop Extension/Resources/bgCommon.js');
const source = fs.readFileSync(bgCommonPath, 'utf8');

// --- parse SEARCH_QUERY_PARAM_NAMES from bgCommon.js as text -------------
const listBlock = source.match(/const SEARCH_QUERY_PARAM_NAMES = \[([\s\S]*?)\];/);
assert.ok(listBlock, 'could not find SEARCH_QUERY_PARAM_NAMES in bgCommon.js');
const redactionList = [...listBlock[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
assert.ok(
  redactionList.length >= 10,
  `SEARCH_QUERY_PARAM_NAMES parsed to only ${redactionList.length} entries — the text parse is probably broken`
);
assert.equal(new Set(redactionList).size, redactionList.length,
  'duplicate names in SEARCH_QUERY_PARAM_NAMES');

// --- parse the engine queryParams from the searchEngines block -----------
// Same block regex as tests/manifest-consistency.test.js and
// tests/engine-presets-consistency.test.js; the queryParam value is either a
// string ("q") or an array (["wd", "word"] for Baidu).
const engineBlock = source.match(/const searchEngines = \[([\s\S]*?)\];/);
assert.ok(engineBlock, 'could not find the searchEngines array in bgCommon.js');
const engines = [];
for (const entry of engineBlock[1].matchAll(/\{\s*pattern:\s*\/.+?\/\s*,\s*queryParam:\s*(?:"([^"]*)"|\[([\s\S]*?)\])[^}]*name:\s*"([^"]*)"/g)) {
  const params = entry[1] !== undefined
    ? [entry[1]]
    : [...entry[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  engines.push({ name: entry[3], params });
}
assert.equal(engines.length, 7, 'expected 7 engine entries in searchEngines');
for (const e of engines) {
  assert.ok(e.params.length >= 1, `${e.name} engine parsed with no queryParam`);
}

const engineParams = engines.flatMap((e) => e.params);
const listSet = new Set(redactionList);
const usedSet = new Set(engineParams);

// Documented synonyms: search-term param names the list intentionally carries
// beyond the engines' own params, so check 2 does not flag them. If the list
// grows a genuinely new entry that is neither an engine param nor listed
// here, the guard fails — a new list entry must be a deliberate, reviewed
// choice (either it is one, add it to this pin, or redaction of it was
// intended to be dropped and it should come out of the list).
const PINNED_SYNONYMS = [
  'q', 'query', 'search', 'searchterm', 'search_term', 'search_query',
  'srch', 'text', 'word',
];
// 'q', 'text' and 'word' are both engine params AND synonyms; the pin lists
// every NON-engine entry the list is allowed to carry.
const allowed = new Set([...engineParams, ...PINNED_SYNONYMS]);

test('every engine queryParam is a member of SEARCH_QUERY_PARAM_NAMES (#99)', () => {
  const missing = engineParams.filter((p) => !listSet.has(p));
  assert.deepEqual(
    missing,
    [],
    `engine query param(s) ${JSON.stringify(missing)} are NOT redacted by ` +
      `SEARCH_QUERY_PARAM_NAMES — a logged URL for those engines would keep ` +
      `the plaintext search term, re-leaking the #12 contract. Add them to ` +
      `SEARCH_QUERY_PARAM_NAMES in bgCommon.js.`
  );
  for (const e of engines) {
    for (const p of e.params) {
      assert.ok(listSet.has(p), `${e.name} engine uses queryParam "${p}" which is not in the redaction list`);
    }
  }
});

test('every SEARCH_QUERY_PARAM_NAMES entry is an engine param or a pinned synonym (#99)', () => {
  const orphaned = redactionList.filter((p) => !usedSet.has(p) && !allowed.has(p));
  assert.deepEqual(
    orphaned,
    [],
    `SEARCH_QUERY_PARAM_NAMES entry/entries ${JSON.stringify(orphaned)} are used by no engine and are ` +
      `not pinned synonyms — either a real engine param silently dropped out ` +
      `of searchEngines (a term those URLs would no longer have redacted) or ` +
      `a stale list entry. If this is intentional, update PINNED_SYNONYMS here.`
  );
});

test('the redaction list keeps its pinned shape (tripwire, #99)', () => {
  // Readable failure if the whole list is edited in one change: the current
  // membership is pinned so a wholesale rewrite needs an explicit decision
  // here, not just a passing engine-param check.
  assert.equal(
    redactionList.length,
    11,
    `SEARCH_QUERY_PARAM_NAMES now has ${redactionList.length} entries (pinned 11) — deliberate edit? Update the pin.`
  );
  for (const p of engineParams) {
    assert.ok(listSet.has(p), `engine param "${p}" missing from the pinned list`);
  }
});
