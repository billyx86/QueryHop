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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractCitedNumbers,
  commitCitedNumbers,
  evaluateChangelogDrift,
  mergeIntroducedNumbers,
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

// ---- issue #184: merge-commit citation resolution -----------------------

test('evaluateChangelogDrift: a merge commit is acknowledged by the issues its commits cite', () => {
  // The real shape: a merge commit's subject carries ONLY the PR number,
  // while the changelog entry cites the PR's issues (written before the
  // PR number existed). The map resolves the merge to its issues.
  const subjects = [
    'Merge pull request #183 from billyx86/overnight/2026-11-24-google-ccTLD-wave4',
  ];
  const body =
    '- **Google ccTLDs, fourth wave** — … (issue #181).\n- **Changelog drift guard** — … (issue #182).\n';
  const introduced = new Map([
    [
      'Merge pull request #183 from billyx86/overnight/2026-11-24-google-ccTLD-wave4',
      [183, 181, 182],
    ],
  ]);
  assert.deepEqual(
    evaluateChangelogDrift(subjects, body, introduced),
    { ok: true, uncited: [], cited: [181, 182] }
  );
});

test('evaluateChangelogDrift: a merge commit whose issues are NOT cited still fails', () => {
  // The fix must not make the guard vacuous: an uncited PR merged via a
  // merge commit is still an uncited merge.
  const subjects = [
    'Merge pull request #185 from billyx86/overnight/some-other-work',
  ];
  const body = '- **Unrelated** — … (issue #181).\n';
  const introduced = new Map([
    ['Merge pull request #185 from billyx86/overnight/some-other-work', [185, 186]],
  ]);
  const r = evaluateChangelogDrift(subjects, body, introduced);
  assert.equal(r.ok, false);
  assert.deepEqual(r.uncited, [
    'Merge pull request #185 from billyx86/overnight/some-other-work',
  ]);
});

test('evaluateChangelogDrift: squash merges ignore the introduced map', () => {
  const subjects = ['fix: third wave of ccTLDs (#176) (#177)'];
  // The map has a (hypothetical) entry for this subject; a non-merge
  // subject must still decide purely on its own citations.
  const introduced = new Map([
    ['fix: third wave of ccTLDs (#176) (#177)', [999]],
  ]);
  const body = '- **Third wave** — … (issues #175, #176).\n';
  assert.deepEqual(
    evaluateChangelogDrift(subjects, body, introduced),
    { ok: true, uncited: [], cited: [175, 176] }
  );
  // …and the same subject with nothing cited still fails.
  assert.equal(
    evaluateChangelogDrift(subjects, '- **Other** — (issue #1).\n', introduced)
      .ok,
    false
  );
});

test('mergeIntroducedNumbers: resolves a merge to its side-parent subjects', () => {
  // Fixture: main — A(#101) — M;          side: A — B(#102)
  // M is a 2-parent merge ("Merge pull request #103 from x"). The range
  // includes M, A, B. B cites #102; A cites #101.
  const root = mkdtempSync(join(tmpdir(), 'changelog-drift-'));
  const git = (args, opts) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
  try {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'chore: first commit (#101)']);
    const base = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-q', '-b', 'side']);
    writeFileSync(join(root, 'b.txt'), 'b\n');
    git(['add', 'b.txt']);
    git(['commit', '-q', '-m', 'fix: feature work (#102)']);
    const side = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--no-ff', '-m', 'Merge pull request #103 from user/side', side]);
    const head = git(['rev-parse', 'HEAD']).trim();
    assert.equal(git(['rev-parse', '--verify', 'HEAD']).trim(), head);

    const map = mergeIntroducedNumbers(root, `${base}..HEAD`);
    const key = 'Merge pull request #103 from user/side';
    assert.ok(map.has(key), 'merge commit is in the map');
    // PR number from the subject + #102 from the commit the merge
    // introduced. #101 is the merge BASE, not an introduced commit, so
    // it is correctly absent.
    assert.deepEqual([...map.get(key)].sort((a, b) => a - b), [102, 103]);

    // A squash-merge-style history has no merges → empty map.
    assert.deepEqual(mergeIntroducedNumbers(root, `${base}..${side}`), new Map());

    // End-to-end: the drift check passes on the fixture tree when the
    // [Unreleased] body cites the issue the merged commit carries.
    const subjects = git(['log', '--format=%s', `${base}..HEAD`])
      .split('\n')
      .filter(Boolean);
    const r = evaluateChangelogDrift(
      subjects,
      '- **Feature** — done (issue #102).\n',
      map
    );
    assert.deepEqual(r, { ok: true, uncited: [], cited: [102] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
