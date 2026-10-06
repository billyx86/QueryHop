// Unit tests for the pure decision core of
// scripts/check-e2e-full-tier-freshness.mjs (issue #83). The CLI layer (gh /
// git calls) is exercised for real in CI; here the core is driven with
// injected `now` / `activatedAt` so every branch of the freshness matrix is
// deterministic. The same zero-npm-deps / node:test conventions as the rest
// of the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCron,
  completionTimestamp,
  evaluateFreshness,
} from '../scripts/check-e2e-full-tier-freshness.mjs';

const NOW = new Date('2026-10-06T01:00:00Z');
const ACT = new Date('2026-10-05T03:19:56Z'); // first commit that landed the workflow

const run = (over = {}) => ({
  databaseId: 1,
  number: 100,
  headBranch: 'main',
  event: 'schedule',
  status: 'completed',
  conclusion: 'success',
  createdAt: '2026-10-04T06:00:00Z',
  updatedAt: '2026-10-04T06:12:00Z',
  url: 'https://github.com/x/actions/runs/1',
  ...over,
});

// ---------------------------------------------------------------------------
// extractCron — workflow text -> schedule cron expression
// ---------------------------------------------------------------------------
test('extractCron: reads the cron from a real workflow shape', () => {
  const text = [
    'on:',
    "  schedule:",
    '    # Weekly, Sunday 06:00 UTC.',
    "    - cron: '0 6 * * 0'",
    '  workflow_dispatch: {}',
    '',
  ].join('\n');
  assert.equal(extractCron(text), '0 6 * * 0');
});

test('extractCron: handles the unquoted cron variant', () => {
  assert.equal(extractCron('  schedule:\n    - cron: 0 6 * * 0\n'), '0 6 * * 0');
});

test('extractCron: a workflow with no schedule returns null', () => {
  assert.equal(extractCron('on:\n  push:\n    branches: [main]\n'), null);
});

// ---------------------------------------------------------------------------
// completionTimestamp — run completion proxy
// ---------------------------------------------------------------------------
test('completionTimestamp: prefers updatedAt over createdAt', () => {
  const r = run();
  assert.equal(completionTimestamp(r).toISOString(), '2026-10-04T06:12:00.000Z');
});

test('completionTimestamp: falls back to createdAt when updatedAt is absent', () => {
  const r = run({ updatedAt: undefined });
  assert.equal(completionTimestamp(r).toISOString(), '2026-10-04T06:00:00.000Z');
});

// ---------------------------------------------------------------------------
// evaluateFreshness — the full matrix
// ---------------------------------------------------------------------------
test('fresh: a recent successful run on the default branch is ok', () => {
  const v = evaluateFreshness([run()], { now: NOW, activatedAt: ACT });
  assert.equal(v.ok, true);
  assert.equal(v.state, 'fresh');
  assert.ok(v.ageMs > 0 && v.ageMs < 8 * 86400000);
});

test('stale: a successful run older than maxAgeDays fails', () => {
  const v = evaluateFreshness(
    [run({ createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T06:12:00Z' })],
    { now: NOW, activatedAt: ACT }
  );
  assert.equal(v.ok, false);
  assert.equal(v.state, 'stale');
});

test('stale: respects a custom maxAgeDays', () => {
  // 3 days old: fresh at 8-day limit, stale at 2-day limit.
  const recent = run({ createdAt: '2026-10-03T06:00:00Z', updatedAt: '2026-10-03T06:12:00Z' });
  assert.equal(evaluateFreshness([recent], { now: NOW, activatedAt: ACT, maxAgeDays: 8 }).state, 'fresh');
  assert.equal(evaluateFreshness([recent], { now: NOW, activatedAt: ACT, maxAgeDays: 2 }).state, 'stale');
});

test('failing: the latest completed run ended in failure', () => {
  const v = evaluateFreshness(
    [run(), run({ number: 101, databaseId: 2, conclusion: 'failure', createdAt: '2026-10-05T06:00:00Z', updatedAt: '2026-10-05T06:12:00Z' })],
    { now: NOW, activatedAt: ACT }
  );
  assert.equal(v.ok, false);
  assert.equal(v.state, 'failing');
  assert.equal(v.run.number, 101);
});

test('failing: a cancelled latest run is not a success', () => {
  const v = evaluateFreshness(
    [run(), run({ number: 102, databaseId: 3, conclusion: 'cancelled', createdAt: '2026-10-05T06:00:00Z', updatedAt: '2026-10-05T06:05:00Z' })],
    { now: NOW, activatedAt: ACT }
  );
  assert.equal(v.ok, false);
  assert.equal(v.state, 'failing');
});

test('in-progress: a running latest run is tolerated (not yet a verdict)', () => {
  const v = evaluateFreshness(
    [run(), run({ number: 103, databaseId: 4, status: 'in_progress', conclusion: null, createdAt: '2026-10-06T00:30:00Z', updatedAt: '2026-10-06T00:45:00Z' })],
    { now: NOW, activatedAt: ACT }
  );
  assert.equal(v.ok, true);
  assert.equal(v.state, 'in-progress');
});

test('grace: zero runs inside the activation window is ok', () => {
  const v = evaluateFreshness([], { now: NOW, activatedAt: ACT });
  assert.equal(v.ok, true);
  assert.equal(v.state, 'grace');
  assert.ok(v.graceUntil.getTime() > NOW.getTime());
});

test('never-fired: zero runs after the grace window fails', () => {
  // Activation far in the past, still no runs.
  const v = evaluateFreshness([], { now: NOW, activatedAt: new Date('2026-08-01T00:00:00Z') });
  assert.equal(v.ok, false);
  assert.equal(v.state, 'never-fired');
});

test('branch isolation: runs on other branches do not count as fresh', () => {
  const v = evaluateFreshness(
    [run({ headBranch: 'feature/xyz' })],
    { now: NOW, activatedAt: ACT, defaultBranch: 'main' }
  );
  // Only non-main runs are visible -> treated as "no runs on main" -> in grace.
  assert.equal(v.state, 'grace');
});

test('branch isolation: no defaultBranch set counts all branches', () => {
  const v = evaluateFreshness(
    [run({ headBranch: 'feature/xyz' })],
    { now: NOW, activatedAt: ACT, defaultBranch: null }
  );
  assert.equal(v.state, 'fresh');
});

test('latest is chosen by createdAt, not array order', () => {
  const older = run({ number: 90, databaseId: 9, conclusion: 'failure', createdAt: '2026-09-25T06:00:00Z', updatedAt: '2026-09-25T06:12:00Z' });
  const newer = run();
  const v = evaluateFreshness([newer, older], { now: NOW, activatedAt: ACT });
  assert.equal(v.ok, true);
  assert.equal(v.run.number, 100); // the newer success wins
});

test('staleness is measured from the last SUCCESS even when a newer failure exists', () => {
  // An older success (3 days) and a newer failure (1 day). Latest is failing
  // -> 'failing' verdict (the tripwire), regardless of the success age.
  const success3d = run({ number: 95, databaseId: 5, createdAt: '2026-10-03T06:00:00Z', updatedAt: '2026-10-03T06:12:00Z' });
  const failure1d = run({ number: 96, databaseId: 6, conclusion: 'failure', createdAt: '2026-10-05T06:00:00Z', updatedAt: '2026-10-05T06:12:00Z' });
  const v = evaluateFreshness([success3d, failure1d], { now: NOW, activatedAt: ACT });
  assert.equal(v.ok, false);
  assert.equal(v.state, 'failing');
});
