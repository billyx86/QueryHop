#!/usr/bin/env node
//
// check-e2e-full-tier-freshness.mjs
//
// Guards the health of the weekly e2e full-tier gate (issue #83; the gate
// itself is issue #80, .github/workflows/e2e-full-tier.yml).
//
// The gate is the ONLY surface where the behavioral browser net (issue #75)
// runs full — the ubuntu-latest PR job degrades by design. But the gate had
// no tripwire for its own health:
//
//   1. STALENESS — if the schedule stops firing (repo settings, Actions
//      billing on a free tier, a disabled workflow), nothing fails; the
//      full-tier evidence quietly goes stale while every PR keeps passing
//      in degraded mode.
//   2. SILENT FAILURE — if a runner image stops exposing the MV3 service
//      worker (the very environmental failure mode that motivated #75's
//      tiering), the run fails in the Actions history with no signal
//      anywhere else: no branch check, no comparison against the previous
//      tier.
//
// This guard closes both. On every CI push it:
//
//   - fails IMMEDIATELY if e2e-full-tier.yml is missing from this ref, or
//     no longer carries a schedule trigger — a PR that would kill the gate
//     on merge cannot merge (acceptance: "a PR that breaks/disables the
//     weekly workflow -> regular CI fails within one push");
//   - queries the latest e2e-full-tier.yml runs on the default branch and
//     fails if the last SUCCESSFUL run is older than --max-age-days
//     (default 8: one missed Sunday + margin), or if the latest completed
//     run's conclusion is not success (the silent-failure tripwire);
//   - tolerates ZERO runs inside a grace window measured from the first
//     commit on main that landed the workflow file: the first scheduled
//     fire is the first Sunday after that commit, so the window is that
//     activation plus one full missed cycle.
//
// A successful gate run is, by construction, a FULL-tier run: the gate's
// "Require the full tier" step exits non-zero unless e2e-tier.json says
// full. The run conclusion IS the tier signal, so no second API surface is
// needed to read the tier.
//
// Exit codes: 0 = gate healthy (fresh / in-progress / grace), 1 = gate
// unhealthy (missing file, no schedule trigger, never fired, stale, or the
// latest run is not a success), 2 = tooling/environment problem (gh or git
// unavailable, bad arguments).
//
// stdlib-only (node + git + gh), matching the repo's zero-npm-deps policy.
// The pure decision core (extractCron / completionTimestamp /
// evaluateFreshness) is imported by tests/e2e-full-tier-freshness.test.js.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOW = '.github/workflows/e2e-full-tier.yml';
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- pure core (unit-tested on every CI run) ---------------------------

/**
 * Extract the first schedule cron expression from a workflow file's text.
 *
 * @param {string} workflowText
 * @returns {string|null} the cron expression, or null when there is no
 *   `cron:` trigger line (a workflow without a schedule can never fire).
 */
export function extractCron(workflowText) {
  const match = workflowText.match(/^\s*-\s*cron:\s*['"]?([^\n'"]+?)['"]?\s*$/m);
  return match ? match[1].trim() : null;
}

/**
 * The timestamp a run finished: its `updatedAt`, which flips when the run
 * completes (with `createdAt` as the fallback for runs missing the field).
 *
 * @param {{updatedAt?: string, createdAt?: string}} run
 * @returns {Date}
 */
export function completionTimestamp(run) {
  return new Date(run.updatedAt || run.createdAt);
}

/**
 * Decide whether the weekly full-tier gate is healthy.
 *
 * @param {Array<{databaseId?: number, number?: number, headBranch?: string,
 *   event?: string, status?: string, conclusion?: string, createdAt?: string,
 *   updatedAt?: string, url?: string}>} runs
 *   Every e2e-full-tier.yml run, as returned by `gh run list` (all
 *   branches).
 * @param {{now: Date, activatedAt: Date, maxAgeDays?: number,
 *   defaultBranch?: string|null}} opts
 *   now: reference "current time" (injectable so the core is testable).
 *   activatedAt: the first commit on main that landed the workflow file —
 *   the baseline for the zero-run grace window.
 *   maxAgeDays: staleness limit in days (default 8: one missed Sunday +
 *   margin).
 *   defaultBranch: restrict the run history to this branch (the schedule
 *   fires on the default branch only); null = no restriction.
 * @returns {{ok: boolean,
 *   state: 'grace'|'never-fired'|'in-progress'|'failing'|'stale'|'fresh',
 *   run?: object|null, ageMs?: number, graceUntil?: Date, reason: string}}
 */
export function evaluateFreshness(runs, { now, activatedAt, maxAgeDays = 8, defaultBranch = null }) {
  const limitMs = maxAgeDays * DAY_MS;
  const graceUntil = new Date(activatedAt.getTime() + limitMs);
  const inBranch = runs.filter((r) => !defaultBranch || r.headBranch === defaultBranch);

  if (inBranch.length === 0) {
    if (now.getTime() <= graceUntil.getTime()) {
      return {
        ok: true,
        state: 'grace',
        run: null,
        graceUntil,
        reason: 'no runs yet, inside the grace window from workflow activation',
      };
    }
    return {
      ok: false,
      state: 'never-fired',
      run: null,
      graceUntil,
      reason: 'the schedule has no runs at all and its grace window has passed',
    };
  }

  const latest = inBranch.reduce((a, b) =>
    new Date(a.createdAt) >= new Date(b.createdAt) ? a : b
  );

  if (latest.status !== 'completed') {
    return {
      ok: true,
      state: 'in-progress',
      run: latest,
      reason: `run ${latest.number ?? latest.databaseId} is still ${latest.status}`,
    };
  }

  if (latest.conclusion !== 'success') {
    return {
      ok: false,
      state: 'failing',
      run: latest,
      reason: `the latest completed run ended '${latest.conclusion}', not success`,
    };
  }

  const successful = inBranch.filter(
    (r) => r.conclusion === 'success' && r.status === 'completed'
  );
  const lastSuccess = successful.reduce((a, b) =>
    completionTimestamp(a) >= completionTimestamp(b) ? a : b
  );
  const ageMs = now.getTime() - completionTimestamp(lastSuccess).getTime();

  if (ageMs > limitMs) {
    return {
      ok: false,
      state: 'stale',
      run: lastSuccess,
      ageMs,
      reason: `the last successful run is ${(ageMs / DAY_MS).toFixed(1)} days old (limit ${maxAgeDays})`,
    };
  }

  return {
    ok: true,
    state: 'fresh',
    run: lastSuccess,
    ageMs,
    reason: `the last successful run is ${(ageMs / DAY_MS).toFixed(1)} days old (limit ${maxAgeDays})`,
  };
}

// ---- git layer (CI / manual) -------------------------------------------

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The date of the first commit on origin/main that touched the workflow
 * file (the grace-window baseline). Deepens a shallow CI checkout first so
 * the reverse history is exact — same pattern as
 * check-release-tag-hygiene.mjs.
 *
 * @param {string} root repository root
 * @returns {Date}
 * @throws {Error} when git cannot determine the activation commit
 */
export function activationDate(root) {
  try {
    try {
      git(root, ['fetch', '--unshallow', 'origin']);
    } catch {
      // Already a complete repository.
    }
    git(root, ['fetch', 'origin', 'main']);
    const when = git(root, ['log', '-1', '--reverse', '--format=%cI', 'FETCH_HEAD', '--', WORKFLOW]).trim();
    if (!when) throw new Error(`no commit on main touched ${WORKFLOW}`);
    return new Date(when);
  } catch (error) {
    throw new Error(String(error.stderr || error.message || error));
  }
}

// ---- CLI ----------------------------------------------------------------

// Run as a CLI (node scripts/check-e2e-full-tier-freshness.mjs
// [--max-age-days N] [root]) — the pure core is imported by the tests, so
// guard on the real file path rather than argv[1] (unset when the module is
// imported).
if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const args = process.argv.slice(2);
  const maxAgeIdx = args.indexOf('--max-age-days');
  let maxAgeDays = 8;
  if (maxAgeIdx !== -1) {
    maxAgeDays = Number(args[maxAgeIdx + 1]);
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      console.error('FAIL: --max-age-days requires a positive number');
      process.exit(2);
    }
  }
  const positional = args.filter(
    (a, i) => a !== '--max-age-days' && i !== maxAgeIdx + 1
  );
  const root = positional[0] || process.cwd();

  // 1. The gate must still exist in THIS ref — a PR that deletes or
  //    de-schedules the workflow fails immediately, not eight days later.
  const wfPath = path.join(root, WORKFLOW);
  if (!existsSync(wfPath)) {
    console.error(`FAIL: ${WORKFLOW} is missing from this ref — merging would kill the weekly full-tier gate (issue #83).`);
    process.exit(1);
  }
  const cron = extractCron(readFileSync(wfPath, 'utf8'));
  if (!cron) {
    console.error(`FAIL: ${WORKFLOW} no longer has a schedule trigger — the weekly full-tier gate can never fire again (issue #83).`);
    process.exit(1);
  }

  // 2. The gate's run history. gh needs GH_TOKEN (the runner's
  //    GITHUB_TOKEN is not picked up automatically — same as
  //    check-release-drift.mjs).
  let runs;
  try {
    runs = JSON.parse(execFileSync('gh', [
      'run', 'list',
      '--workflow', WORKFLOW,
      '--limit', '20',
      '--json', 'databaseId,number,headBranch,event,status,conclusion,createdAt,updatedAt,url',
    ], { encoding: 'utf8' }));
  } catch (error) {
    console.error(`FAIL: could not list e2e-full-tier runs via gh: ${error.message || error}`);
    console.error('       (is gh installed and is GH_TOKEN set?)');
    process.exit(2);
  }

  // 3. The grace-window baseline: the first commit on main that landed the
  //    workflow file (the first scheduled fire is the first Sunday after
  //    that, so the window is the activation plus one full missed cycle).
  let activatedAt;
  try {
    activatedAt = activationDate(root);
  } catch (error) {
    console.error(`FAIL: could not determine when the workflow first landed on main: ${error.message || error}`);
    process.exit(2);
  }

  const defaultBranch = process.env.GITHUB_DEFAULT_BRANCH || 'main';
  const verdict = evaluateFreshness(runs, { now: new Date(), activatedAt, maxAgeDays, defaultBranch });
  const runRef = (r) => (r ? `#${r.number ?? r.databaseId}` : 'none');
  const runWhen = (r) => (r ? r.updatedAt || r.createdAt || '' : '');

  if (verdict.state === 'fresh') {
    console.log(`OK: e2e full-tier gate fresh — last successful run ${runRef(verdict.run)} completed ${runWhen(verdict.run)}${verdict.run.url ? ` (${verdict.run.url})` : ''}. Tier is full by construction (the gate requires it). ${verdict.reason}.`);
  } else if (verdict.state === 'in-progress') {
    console.log(`OK: e2e full-tier gate — run ${runRef(verdict.run)} is ${verdict.run.status} (started ${verdict.run.createdAt}); re-checked on the next push.`);
  } else if (verdict.state === 'grace') {
    console.log(`OK: e2e full-tier gate armed — no runs yet (grace until ${verdict.graceUntil.toISOString()}; the first scheduled fire is the first Sunday after activation on ${activatedAt.toISOString()}).`);
  } else if (verdict.state === 'never-fired') {
    console.error(`FAIL: e2e full-tier gate never fired — no runs at all, and the grace window ended ${verdict.graceUntil.toISOString()}. The schedule is dead (repo settings, Actions billing, or the workflow is disabled).`);
    process.exit(1);
  } else if (verdict.state === 'failing') {
    console.error(`FAIL: e2e full-tier gate — latest run ${runRef(verdict.run)} ended '${verdict.run.conclusion}' (${runWhen(verdict.run)}${verdict.run.url ? `, ${verdict.run.url}` : ''}). The behavioral net is not passing full on the weekly gate (runner-image regression? see issue #83).`);
    process.exit(1);
  } else {
    // 'stale'
    console.error(`FAIL: e2e full-tier gate stale — last successful run ${runRef(verdict.run)} completed ${runWhen(verdict.run)} (${(verdict.ageMs / DAY_MS).toFixed(1)} days ago; limit ${maxAgeDays}). The weekly schedule appears dead.`);
    process.exit(1);
  }
  process.exit(0);
}
