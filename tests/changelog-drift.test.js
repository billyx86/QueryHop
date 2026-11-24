// Unit tests for scripts/check-changelog-drift.mjs (issue #182): the
// decision core that keeps the [Unreleased] section of CHANGELOG.md from
// silently dropping merged work.
//
// The gap: check-changelog.mjs (issue #117) only requires the CURRENT
// version's section to exist and be non-empty — the [Unreleased] section
// passes with any single bullet, so merged PRs can accumulate without
// entries and the next release's notes (assembled from this section)
// silently omit user-visible changes. This core is what the CI validate
// job (scripts/check-changelog-drift.mjs) runs: every PR merged since
// the current version's tag must be cited in [Unreleased].
//
// Only the pure core is unit-tested here (same split as
// changelog-consistency.test.js and release-tag-hygiene.test.js); the
// git/manifest layer is exercised by the CI validate job.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCitedNumbers,
  commitCitedNumbers,
  evaluateChangelogDrift,
} from '../scripts/check-changelog-drift.mjs';

test('extractCitedNumbers: cites every #number in the body', () => {
  assert.deepEqual(
    [...extractCitedNumbers('- **Thing** — it works (issue #999).')],
    [999]
  );
});

test('extractCitedNumbers: a bare "#number range" cites both endpoints', () => {
  // "#167–#170" — each end carries its own #.
  assert.deepEqual(
    [...extractCitedNumbers('regional shapes (issues #167–#170).')],
    [167, 170]
  );
});

test('extractCitedNumbers: duplicate citations collapse to one number', () => {
  assert.deepEqual(
    [...extractCitedNumbers('(#176) (#176) (issue #176).')],
    [176]
  );
});

test('extractCitedNumbers: version strings cite nothing', () => {
  // "1.0.3" is a version, not a citation; only "#N" counts.
  assert.equal(extractCitedNumbers('Work on main since 1.0.3:').size, 0);
});

test('extractCitedNumbers: a missing body cites nothing', () => {
  assert.equal(extractCitedNumbers(null).size, 0);
});

test('commitCitedNumbers: a squash subject cites its trailing PR group', () => {
  assert.deepEqual(
    commitCitedNumbers('fix: cover the third wave of Google ccTLDs (#176)'),
    [176]
  );
});

test('commitCitedNumbers: a squash subject cites its issue ranges and its PR', () => {
  // The real shape: issue citations in one group, the PR number in the
  // trailing group.
  assert.deepEqual(
    commitCitedNumbers(
      'fix(engines): DDG no-slash html?q= + third wave of Google ccTLDs (#175, #176) (#177)'
    ),
    [175, 176, 177]
  );
});

test('commitCitedNumbers: an en-dash range cites both endpoints', () => {
  assert.deepEqual(
    commitCitedNumbers(
      'feat(engines): cover regional + endpoint search-engine patterns (#167–#170) (#171)'
    ),
    [167, 170, 171]
  );
});

test('commitCitedNumbers: a merge commit cites the PR from its subject', () => {
  assert.deepEqual(
    commitCitedNumbers(
      'Merge pull request #161 from billyx86/overnight/2026-11-11-brave-engine'
    ),
    [161]
  );
});

test('commitCitedNumbers: a subject with no numbers cites nothing', () => {
  assert.deepEqual(commitCitedNumbers('Update the icon set'), []);
});

test('evaluateChangelogDrift: every cited merge acknowledged passes', () => {
  const subjects = [
    'feat(engines): cover regional + endpoint search-engine patterns (#167–#170) (#171)',
    'Merge pull request #174 from billyx86/overnight/baidu-hk',
  ];
  // A squash merge is satisfied by ANY of its subject's numbers (the
  // entry cites the issues, the subject also carries the PR number).
  // A merge commit's subject carries ONLY the PR number, so the entry
  // must cite #174 itself.
  const body = '- **Engine pattern coverage** — now redirects (issues #167–#170).\n- **Baidu Hong Kong** — now redirects (issue #172, PR #174).\n';
  const r = evaluateChangelogDrift(subjects, body);
  assert.equal(r.ok, true);
  assert.deepEqual(r.uncited, []);
});

test('evaluateChangelogDrift: an uncited merge fails with its subject', () => {
  const subjects = [
    'e2e: fix dead popup probe (#178)',
    'feat(engines): third wave of ccTLDs (#176) (#177)',
  ];
  const body = '- **e2e popup probe fixed** — it works now (issue #178).\n';
  const r = evaluateChangelogDrift(subjects, body);
  assert.equal(r.ok, false);
  assert.deepEqual(r.uncited, [
    'feat(engines): third wave of ccTLDs (#176) (#177)',
  ]);
});

test('evaluateChangelogDrift: a subject citing no numbers is skipped', () => {
  // A numberless merge shape cannot be cited — skipping it (rather than
  // failing) is what keeps the guard reachable on repos whose history
  // predates conventional merge subjects.
  const r = evaluateChangelogDrift(['Update the icon set'], 'anything');
  assert.equal(r.ok, true);
});

test('evaluateChangelogDrift: a missing [Unreleased] section uncites every cited merge', () => {
  const r = evaluateChangelogDrift(
    ['feat: thing (#176)'],
    null
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.uncited, ['feat: thing (#176)']);
});

test('evaluateChangelogDrift: no merges since the tag passes vacuously', () => {
  assert.deepEqual(evaluateChangelogDrift([], null), {
    ok: true,
    uncited: [],
    cited: [],
  });
});
