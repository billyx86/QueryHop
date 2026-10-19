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
//     fails if the last SUCCESSFUL SCHEDULED run is older than
//     --max-age-days (default 8: one missed Sunday + margin), or if the
//     latest completed SCHEDULED run's conclusion is not success (the
//     silent-failure tripwire). Only `event: schedule` runs count as
//     schedule liveness (issue #88): a manual workflow_dispatch run is
//     operator intervention — it must neither keep a dead schedule looking
//     fresh nor, when it fails, put the gate in `failing` and block merges;
//   - tolerates ZERO runs inside a grace window measured from the first
//     commit on main that landed the workflow file: the first scheduled
//     fire is the first Sunday after that commit, so the window is that
//     activation plus one full missed cycle.
//
// The split (issue #119): the #83 tripwire originally coupled the
// SCHEDULE's operational health to every merge — a missed Sunday (billing,
// a paused workflow, a runner-image regression) left the last scheduled
// run stale/failed, and EVERY unrelated push went red until the next
// scheduled fire landed green. That actually bricked PR #116 on
// 2026-10-17 (all substantive checks green, force-merged with --admin).
// The tripwire is now split by relevance:
//
//   1. STRUCTURAL CHECK (hard fail on every push, unchanged): the workflow
//      file must exist on this ref and still carry a schedule trigger — a
//      PR that would kill the gate on merge cannot merge (the #80/#83
//      merge-blocking guarantee).
//   2. RUN-HISTORY CHECK (never-fired past grace / stale / failing): hard
//      fail only when the push is GATE-RELATED — it touches the gate
//      workflow, this script, or the e2e tier's test files. Any other push
//      (e.g. one that touches only extension source) gets a WARN and exit
//      0: the e2e-browser job still surfaces the gate-health line in its
//      step summary, so a schedule outage degrades to a visible warning
//      instead of bricking the merge path for up to a week.
//
// Gate-relatedness on CI: for pull_request events the changed files are
// `git diff --name-only origin/<base>...HEAD`; for push events, the files
// the push advanced the ref by — `before...<sha>`, where `before` is the
// push event payload's old ref value (a multi-commit push is judged as a
// whole, not by its tip alone; issue #122). When the payload's `before`
// is absent the fallback is the tip commit's own parent (for the
// merge-queue merge commit on main that is exactly the PR's files); a
// ref-CREATING push (before is the all-zero sha) has no decidable base
// and fails CLOSED. The diff is computed after an unshallow fetch (same
// pattern as the git layer below) so it is exact on CI's shallow
// checkouts; if it is undecidable the push fails CLOSED (gate-related),
// matching a manual run outside CI.
//
// A successful gate run is, by construction, a FULL-tier run: the gate's
// "Require the full tier" step exits non-zero unless e2e-tier.json says
// full. The run conclusion IS the tier signal, so no second API surface is
// needed to read the tier.
//
// Exit codes: 0 = gate healthy (fresh / in-progress / grace) — or an
// unhealthy RUN HISTORY on a non-gate-related push (warning only, issue
// #119), 1 = gate unhealthy (missing file, no schedule trigger, or an
// unhealthy run history on a gate-related push), 2 = tooling/environment
// problem (gh or git unavailable, bad arguments).
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
 *   branches). Only runs with `event: 'schedule'` are considered: manual
 *   `workflow_dispatch` runs are operator interventions, not evidence that
 *   the schedule is alive (issue #88).
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
  // (#88) Schedule-liveness evidence is scheduled runs ONLY. Counting a
  // manual workflow_dispatch run would let one manual success re-satisfy
  // the staleness window while the schedule stays dead, and one failed
  // manual probe would put the gate in `failing` and block merges until
  // the next scheduled success.
  const scheduled = inBranch.filter((r) => r.event === 'schedule');

  if (scheduled.length === 0) {
    if (now.getTime() <= graceUntil.getTime()) {
      return {
        ok: true,
        state: 'grace',
        run: null,
        graceUntil,
        reason: 'no scheduled runs yet, inside the grace window from workflow activation',
      };
    }
    return {
      ok: false,
      state: 'never-fired',
      run: null,
      graceUntil,
      reason: 'the schedule has no runs at all (manual workflow_dispatch runs do not count) and its grace window has passed',
    };
  }

  const latest = scheduled.reduce((a, b) =>
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
      reason: `the latest scheduled run ended '${latest.conclusion}', not success`,
    };
  }

  const successful = scheduled.filter(
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
      reason: `the last successful scheduled run is ${(ageMs / DAY_MS).toFixed(1)} days old (limit ${maxAgeDays}); manual workflow_dispatch runs do not count as schedule liveness`,
    };
  }

  return {
    ok: true,
    state: 'fresh',
    run: lastSuccess,
    ageMs,
    reason: `the last successful scheduled run is ${(ageMs / DAY_MS).toFixed(1)} days old (limit ${maxAgeDays})`,
  };
}

// ---- git layer (CI / manual) -------------------------------------------

// The files whose change makes a push gate-related (issue #119): the gate
// workflow itself, this guard, and the e2e tier's test files. The
// extension source is deliberately NOT in this set — the full tier
// exercises it, but a schedule outage must not hold unrelated extension
// PRs hostage (the #119 acceptance criterion: a PR touching only
// extension source merges with a stale/failed scheduled run, warning
// surfaced, not a red check).
const GATE_RELEVANT_FILES = [
  '.github/workflows/e2e-full-tier.yml',
  'scripts/check-e2e-full-tier-freshness.mjs',
  'tests/e2e-browser.test.js',
  'tests/e2e-full-tier-chrome-pin.test.js',
  'tests/e2e-full-tier-freshness.test.js',
];

/**
 * Decide whether a change set is gate-related (issue #119): touching any
 * of the gate files makes the push responsible for the gate's run history,
 * so an unhealthy gate fails the push; anything else only warns.
 *
 * `null` (undecidable change set — a manual run outside CI) returns
 * false here: "no evidence of relevance" is a fact, while FAILING CLOSED
 * on undecidability is the CLI's policy (a manual run must behave exactly
 * like a gate-related push, not like a bystander).
 *
 * @param {string[]|null} paths repo-relative paths of the changed files
 * @returns {boolean}
 */
export function isGateRelated(paths) {
  if (!Array.isArray(paths)) return false;
  return paths.some((p) => GATE_RELEVANT_FILES.includes(String(p).trim()));
}

/**
 * The #119 split, as a policy: given the gate verdict and whether the
 * push is gate-related, decide the run outcome.
 *
 * - healthy gate            -> 'pass' (exit 0)
 * - unhealthy + gate-related-> 'fail' (exit 1): the push that owns the
 *   gate must not merge while the gate's run history is broken
 * - unhealthy + unrelated   -> 'warn' (exit 0): a schedule outage degrades
 *   to a visible warning (the e2e-browser job still surfaces the
 *   gate-health line in its step summary) instead of bricking every
 *   unrelated PR until the next scheduled fire
 *
 * @param {{ok: boolean, gateRelated: boolean}} p
 * @returns {'pass'|'fail'|'warn'}
 */
export function tripwireOutcome({ ok, gateRelated }) {
  if (ok) return 'pass';
  return gateRelated ? 'fail' : 'warn';
}

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

const ZERO_SHA = '0'.repeat(40);

/**
 * Choose the diff base for a push event (issue #122). Returns a spec for
 * `git diff --name-only <spec>` that covers every commit the push advanced
 * the ref by — or null when the base is undecidable (the caller then fails
 * CLOSED, treating the push as gate-related).
 *
 * - a normal push carries its old ref tip in the event payload's `before`
 *   field: `before...<sha>` captures the whole push, including any
 *   gate-relevant change in an intermediate commit (the #122 bug was
 *   judging a multi-commit push by its tip commit alone);
 *   - a ref-CREATING push has `before` as the all-zero sha, which has no
 *     diffable history in the repo: undecidable, fail closed;
 *   - no `before` at all (payload missing or unreadable outside CI): fall
 *     back to the tip commit's own parent, `sha^..<sha>` — for the
 *     merge-queue merge commit on main that is exactly the PR's files.
 *
 * Pure (no git / fs) so the unit tests can drive every branch with a fake
 * payload object.
 *
 * @param {{before?: string}|null|undefined} pushPayload the parsed push
 *   event payload (from GITHUB_EVENT_PATH), or null/undefined
 * @param {string} sha GITHUB_SHA — the pushed ref tip
 * @returns {string|null}
 */
export function pushDiffRange(pushPayload, sha) {
  const before = pushPayload && typeof pushPayload.before === 'string'
    ? pushPayload.before.trim()
    : '';
  if (before === ZERO_SHA) return null; // ref-creating push: no decidable base
  if (before === '') return `${sha}^`; // no payload (manual run) -> tip-only fallback
  return before;
}

/**
 * The changed files of the CI push/PR this guard is running on, or null
 * when undecidable (not a CI push/PR event, or git cannot compute the
 * diff) — the caller fails CLOSED on null (treat the push as
 * gate-related), which is also the manual-run behaviour.
 *
 * CI checkouts are shallow and may not carry the refs a diff needs, so
 * each branch explicitly fetches its ref first (unshallow where possible);
 * any fetch or diff failure returns null, never a wrong file list.
 *
 * @param {string} root repository root
 * @returns {string[]|null}
 */
export function ciChangedFiles(root) {
  if (process.env.GITHUB_BASE_REF) {
    // pull_request: the PR's files since it diverged from its base. The
    // checkout on CI is the PR's merge commit (shallow), so fetch the base
    // branch in full to make the merge base computable.
    const base = String(process.env.GITHUB_BASE_REF);
    const refspec = `+refs/heads/${base}:refs/remotes/origin/${base}`;
    try {
      git(root, ['fetch', '--unshallow', 'origin', refspec]);
    } catch {
      try {
        git(root, ['fetch', 'origin', refspec]);
      } catch {
        return null; // undecidable -> caller fails closed
      }
    }
    try {
      return git(root, ['diff', '--name-only', `origin/${base}...HEAD`])
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      return null;
    }
  }
  if (
    process.env.GITHUB_SHA &&
    process.env.GITHUB_REF &&
    process.env.GITHUB_REF.startsWith('refs/heads/')
  ) {
    // push to a branch. The diff covers the whole push — the ref advanced
    // from the payload's `before` to the pushed `sha` — not just the tip
    // commit: on a multi-commit push a gate-relevant change in an
    // intermediate commit must still make the push gate-related (issue
    // #122). A ref-creating push (before is the all-zero sha) has no
    // decidable base and fails closed.
    const sha = String(process.env.GITHUB_SHA);
    let pushPayload = null;
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (eventPath && existsSync(eventPath)) {
      try {
        pushPayload = JSON.parse(readFileSync(eventPath, 'utf8'));
      } catch {
        pushPayload = null; // unreadable payload -> tip-only fallback
      }
    }
    const base = pushDiffRange(pushPayload, sha);
    if (base === null) return null; // undecidable -> caller fails closed
    try {
      try {
        git(root, ['fetch', '--unshallow', 'origin']);
      } catch {
        try {
          git(root, ['fetch', 'origin']);
        } catch {
          // A shallow tip without its parent below: the diff will fail
          // and return null (fail closed) — acceptable.
        }
      }
      return git(root, ['diff', '--name-only', `${base}...${sha}`])
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      return null;
    }
  }
  return null; // workflow_dispatch / manual / non-branch ref
}

// ---- CLI ----------------------------------------------------------------

// Run as a CLI (node scripts/check-e2e-full-tier-freshness.mjs
// [--max-age-days N] [--strict] [root]) — the pure core is imported by the
// tests, so guard on the real file path rather than argv[1] (unset when the
// module is imported). --strict forces the gate-related (hard) behaviour
// regardless of the push's changed files — a manual invocation outside CI
// already fails closed, because the changed files are undecidable there.
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
  const strict = args.includes('--strict');
  const positional = args.filter(
    (a, i) => a !== '--max-age-days' && a !== '--strict' && i !== maxAgeIdx + 1
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

  // 4. (#119) Relevance: is THIS push responsible for the gate's run
  //    history? --strict forces gate-related; outside CI the changed
  //    files are undecidable, so a manual run also fails closed — exactly
  //    like a gate-related push, never like a bystander.
  let gateRelated = strict;
  if (!strict) {
    const changedFiles = ciChangedFiles(root);
    gateRelated = changedFiles === null ? true : isGateRelated(changedFiles);
  }
  const outcome = tripwireOutcome({ ok: verdict.ok, gateRelated });

  if (verdict.state === 'fresh') {
    console.log(`OK: e2e full-tier gate fresh — last successful scheduled run ${runRef(verdict.run)} completed ${runWhen(verdict.run)}${verdict.run.url ? ` (${verdict.run.url})` : ''}. Tier is full by construction (the gate requires it). ${verdict.reason}.`);
  } else if (verdict.state === 'in-progress') {
    console.log(`OK: e2e full-tier gate — run ${runRef(verdict.run)} is ${verdict.run.status} (started ${verdict.run.createdAt}); re-checked on the next push.`);
  } else if (verdict.state === 'grace') {
    console.log(`OK: e2e full-tier gate armed — no runs yet (grace until ${verdict.graceUntil.toISOString()}; the first scheduled fire is the first Sunday after activation on ${activatedAt.toISOString()}).`);
  } else if (outcome === 'warn') {
    // Unhealthy RUN HISTORY on a non-gate-related push (issue #119): the
    // schedule's operational problem is real and must stay visible, but it
    // must not hold unrelated work hostage until the next Sunday fire. The
    // e2e-browser job still prints the gate-health line in its step
    // summary, so this is a loud warning, not a silent one.
    const line =
      verdict.state === 'never-fired'
        ? `e2e full-tier gate never fired — no scheduled runs at all (manual workflow_dispatch runs do not count), and the grace window ended ${verdict.graceUntil.toISOString()}. The schedule is dead (repo settings, Actions billing, or the workflow is disabled).`
        : verdict.state === 'failing'
          ? `e2e full-tier gate — latest scheduled run ${runRef(verdict.run)} ended '${verdict.run.conclusion}' (${runWhen(verdict.run)}${verdict.run.url ? `, ${verdict.run.url}` : ''}). The behavioral net is not passing full on the weekly gate (runner-image regression? see issue #83).`
          : `e2e full-tier gate stale — last successful scheduled run ${runRef(verdict.run)} completed ${runWhen(verdict.run)} (${(verdict.ageMs / DAY_MS).toFixed(1)} days ago; limit ${maxAgeDays}). The weekly schedule appears dead.`;
    console.log(`WARN: ${line}`);
    console.log(`Not blocking: this push is not gate-related (it touches none of ${GATE_RELEVANT_FILES.join(', ')}), so the run-history tripwire does not fail it (issue #119). Fix the schedule itself (repo settings, billing, a paused workflow, or the runner-image regression behind a failed run) and let the next scheduled fire re-arm the window; run-history pushes (gate workflow, this script, or the e2e tier tests) still fail while it is unhealthy.`);
    process.exit(0);
  } else if (verdict.state === 'never-fired') {
    console.error(`FAIL: e2e full-tier gate never fired — no scheduled runs at all (manual workflow_dispatch runs do not count), and the grace window ended ${verdict.graceUntil.toISOString()}. The schedule is dead (repo settings, Actions billing, or the workflow is disabled).`);
    console.error(`Blocking because this push is gate-related (issue #119): it must not merge while the weekly full-tier gate is dead.`);
    process.exit(1);
  } else if (verdict.state === 'failing') {
    console.error(`FAIL: e2e full-tier gate — latest scheduled run ${runRef(verdict.run)} ended '${verdict.run.conclusion}' (${runWhen(verdict.run)}${verdict.run.url ? `, ${verdict.run.url}` : ''}). The behavioral net is not passing full on the weekly gate (runner-image regression? see issue #83).`);
    console.error(`Blocking because this push is gate-related (issue #119): a push that owns the gate must not merge while its run history is broken.`);
    process.exit(1);
  } else {
    // 'stale'
    console.error(`FAIL: e2e full-tier gate stale — last successful scheduled run ${runRef(verdict.run)} completed ${runWhen(verdict.run)} (${(verdict.ageMs / DAY_MS).toFixed(1)} days ago; limit ${maxAgeDays}). The weekly schedule appears dead.`);
    console.error(`Blocking because this push is gate-related (issue #119): a push that owns the gate must not merge while its schedule is dead.`);
    process.exit(1);
  }
  process.exit(0);
}
