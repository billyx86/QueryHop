// Drift guard for the full-tier e2e gate's substrate and its diagnostics
// (issues #106 and the deferred #108).
//
// The weekly e2e-full-tier gate (issue #80) is the ONLY surface where the
// behavioral browser net (issue #75) runs FULL. It used to run against the
// macos-latest runner's FLOATING Chrome, so the substrate moved under it
// with no way to see. On 2026-10-11 the floating Chrome bumped to 152 and
// the gate degraded on its very first fire, and the #83 freshness tripwire
// went red on every push.
//
// Ground truth (a workflow_dispatch run on the pinned build, 2026-10-13):
//   - Chrome-for-Testing 151.0.7922.138 downloads and launches fine.
//   - The net STILL records `degraded` on 151 — same as on 152.
//   - The browser's `Target.getTargets` sees 6 targets, only 2 of them
//     service_worker, and BOTH are built-in Chrome Web Store component
//     extensions (nkeimhog…/thunk.js, admccjkm…/background.js). QueryHop's
//     own service worker is ABSENT, and Chrome logged no lines at all about
//     loading the extension (neither success nor failure).
//
// So the original #106 hypothesis — "Chrome 152 stopped listing the MV3 SW,
// pin to 151 to fix it" — is NOT what is happening: the unpacked extension's
// service worker does not surface in this headless environment on any of the
// Chrome versions tried, and the gate has never been green in CI. Pinning the
// version does not (and cannot) make the full tier reachable.
//
// What this change does, then, is NOT "fix #106". It makes the gate's
// substrate DETERMINISTIC and REPRODUCIBLE (a known, pinned Chrome-for-
// Testing build instead of a floating image Chrome), and adds the CDP
// `Target.getTargets` diagnostic that turned "degraded, environmental" into
// the concrete finding above. That deterministic, instrumented substrate is
// the prerequisite for actually debugging why the extension's SW does not
// surface — you cannot chase a moving target.
//
// This test is the tripwire for THAT, in the same shape as the #48
// test-count, #59 file-list, and #81 import-graph guards: it re-reads the
// real workflow + harness on every run and fails on the very push that would
// silently move the gate off its pinned substrate, drop the weekly fire,
// re-introduce a per-merge trigger that hard-fails every merge while the
// full tier is unreachable, or remove the CDP diagnostic.
//
// A legitimate re-pin (e.g. once a Chrome build is verified to reach the
// full tier via a workflow_dispatch run) is a deliberate, reviewed change:
// bump PINNED here and the workflow's version literals together, with the
// verifying workflow_dispatch run linked in the PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(root, '.github', 'workflows', 'e2e-full-tier.yml');
const HARNESS = path.join(root, 'tests', 'e2e-browser.test.js');

// The single pinned substrate the full-tier gate runs against. Chosen for
// determinism/reproducibility (a known, inspectable Chrome-for-Testing build),
// NOT because it reaches the full tier — see the file header.
const PINNED = '151.0.7922.138';

const wf = () => readFileSync(WORKFLOW, 'utf8');

test('the full-tier gate runs a PINNED Chrome-for-Testing build, not the image\'s floating Chrome (\\#106)', () => {
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

test('the full-tier gate does NOT run on push:main while the full tier is unreachable (\\#108 deferred)', () => {
  const text = wf();
  const on = text.match(/^on:\n([\s\S]*?)(?=^jobs:)/m);
  assert.ok(on, 'workflow must have an `on:` block');
  const pushTrigger = on[1].match(/^  push:/m);
  assert.equal(pushTrigger, null,
    'e2e-full-tier.yml must NOT have a `push:` trigger while the full tier is unreachable on any runner: this gate REQUIRES the full tier, so a per-merge trigger would hard-fail every merge to main. #108 is deferred until the full tier is reachable again — re-add the trigger only with a linked workflow_dispatch run that proves the full tier passes.');
});

test('the harness keeps the CDP Target.getTargets SW diagnostic (\\#106 instrumented)', () => {
  // The `Target.getTargets` probe is the second, independent vantage point
  // that turned "degraded, environmental" into a concrete finding (which SW
  // targets the browser actually sees). If it is silently removed, the gate
  // regresses to an opaque black box and the real cause stays hidden.
  const harness = readFileSync(HARNESS, 'utf8');
  assert.ok(/Target\.getTargets/.test(harness),
    'e2e-browser.test.js must keep the `Target.getTargets` probe in the degraded path — it is the diagnostic that surfaces which service-worker targets the browser actually sees (built-in vs the extension\u2019s own).');
});
