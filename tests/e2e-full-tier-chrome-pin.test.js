// Drift guard (issue #106, and the #108 trigger it depends on).
//
// The weekly e2e-full-tier gate (issue #80) is the ONLY surface where the
// behavioral browser net (issue #75) runs FULL, but it used to run against
// the macos-latest runner's FLOATING Chrome. On 2026-10-11 that floating
// Chrome bumped to 152, which stopped listing the unpacked MV3 service
// worker in /json/list, so the gate degraded on its very first fire and the
// #83 freshness tripwire went red on every push — the behavioral net
// silently lost its verified substrate for reasons no test could see.
//
// The fix pins the gate to a known-good Chrome-for-Testing build
// (151.0.7922.138, the last stable before the 152 behavior change) and
// downloads it in-workflow. This test is the tripwire for THAT fix, in the
// same shape as the #48 test-count, #59 file-list, and #81 import-graph
// guards: it re-reads the real workflow on every run and fails on the very
// push that would silently move the behavioral net off its verified
// substrate — not eight days later when the weekly run exposes it.
//
// A legitimate re-pin (e.g. once a newer Chrome is verified full via a
// workflow_dispatch run) is a deliberate, reviewed change: bump PINNED here
// and the workflow's version literals together, with the verification run
// linked in the PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(root, '.github', 'workflows', 'e2e-full-tier.yml');
const FRESHNESS = path.join(root, 'scripts', 'check-e2e-full-tier-freshness.mjs');

// The single pinned substrate the full-tier gate must run against.
const PINNED = '151.0.7922.138';

const wf = () => readFileSync(WORKFLOW, 'utf8');

test(`the full-tier gate runs a PINNED Chrome-for-Testing build, not the image's floating Chrome (\\#106)`, () => {
  const text = wf();

  // 1. The download step must carry a concrete version literal (a pinned
  //    build), not a floating "latest" channel.
  const dl = text.match(/version=(\d+\.\d+\.\d+\.\d+)/);
  assert.ok(dl, 'download step must set a concrete `version=<x.y.z.w>` for Chrome-for-Testing');
  assert.equal(dl[1], PINNED,
    `workflow pins Chrome ${dl[1]}, but the guard expects ${PINNED}. A re-pin is a deliberate, reviewed change: bump PINNED and the workflow together, with the verifying workflow_dispatch run linked.`);

  // 2. The cache key must be scoped to that same version (and platform) so a
  //    bump re-downloads instead of reusing a stale ~190MB cache, and so the
  //    key cannot drift from the download URL.
  assert.ok(text.includes(`key: cft-${PINNED}-`),
    `cache key must be scoped to cft-${PINNED}- (it is, so a re-pin cannot silently serve an old build)`);
  const keyVersion = text.match(/key:\s*cft-(\d+\.\d+\.\d+\.\d+)-/);
  assert.ok(keyVersion && keyVersion[1] === PINNED,
    `cache-key version (${keyVersion && keyVersion[1]}) must equal the download version (${PINNED})`);

  // 3. The e2e run must point CHROME_BIN at the pinned CFT binary under
  //    chrome-for-testing-cft/, NOT at the image's floating Chrome
  //    (/usr/bin/google-chrome or an app-bundle path in /Applications).
  //    Note: the CFT binary is itself named "Google Chrome for Testing", so
  //    the negative checks target the IMAGE install locations, not the name.
  const chromeBin = text.match(/CHROME_BIN:\s*"?([^"\n]+)"?/);
  assert.ok(chromeBin, 'the e2e step must set CHROME_BIN');
  assert.ok(chromeBin[1].includes('chrome-for-testing-cft/'),
    `CHROME_BIN must reference the downloaded chrome-for-testing-cft/ build (got "${chromeBin[1]}") — the image's floating Chrome is exactly what regressed`);
  assert.ok(!/\/usr\/bin\/google-chrome/i.test(chromeBin[1]) && !/\/Applications\//.test(chromeBin[1]),
    `CHROME_BIN must not reference the image's Chrome ("${chromeBin[1]}")`);

  // 4. The download step must fail closed if the CFT release layout ever
  //    changes (the binary path is a real-world fragile assumption).
  assert.ok(/test -x "chrome-for-testing-cft\/chrome-[^"]*Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing"/.test(text),
    'download step must `test -x` the exact CFT binary path so a layout change fails loudly, not silently');
});

test('the full-tier gate still has a schedule trigger (the pin must not kill the weekly fire) (\\#106)', () => {
  const cron = wf().match(/^\s*-\s*cron:\s*['"]?([^\n'"]+?)['"]?\s*$/m);
  assert.ok(cron, 'e2e-full-tier.yml must keep its `- cron:` schedule trigger (the weekly full-tier fire)');
  // Sunday weekly cadence is the documented backstop (#83's 8-day limit
  // assumes a single missed Sunday is tolerated).
  assert.equal(cron[1], '0 6 * * 0', `schedule cron changed to '${cron[1]}' — the #83 8-day staleness limit assumes the Sunday 06:00 UTC cadence; update both together if it is a deliberate change`);
});

test('the full-tier gate also runs on every push to main (\\#108)', () => {
  const text = wf();
  // A `push:` trigger scoped to main: the #108 per-merge detection.
  const on = text.match(/^on:\n([\s\S]*?)(?=^jobs:)/m);
  assert.ok(on, 'workflow must have an `on:` block');
  const push = on[1].match(/push:\n\s*branches:\s*\[([^\]]*)\]/);
  assert.ok(push, '#108: e2e-full-tier.yml must gain a `push:` trigger scoped to branches so the gate runs on every merge to main');
  assert.ok(push[1].includes('main'), `the #108 push trigger must include main (got branches [${push[1]}])`);
});

test('the #83 tripwire still reads the schedule runs once per-merge runs exist (\\#108)', () => {
  // Once the gate fires on every push to main, the most recent runs can all
  // be `push` events. If the freshness script's run-list query is not scoped
  // to scheduled events, a burst of per-merge runs crowds the weekly
  // `schedule` run out of its 20-run window — and the #83 tripwire goes blind
  // to schedule health (it sees "no scheduled runs" and false-trips, or
  // misses a dead schedule). So the CLI query must scope to schedule events.
  const script = readFileSync(FRESHNESS, 'utf8');
  assert.ok(script.includes("'--event', 'schedule'"),
    '#108: the freshness script must list e2e-full-tier runs scoped to `--event schedule`, or a per-merge burst can starve the tripwire of the Sunday schedule run');
});
