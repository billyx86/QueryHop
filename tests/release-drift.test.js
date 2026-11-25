// Unit tests for scripts/check-release-drift.mjs (issue #186): the
// decision core that keeps the manifest.json version from drifting ahead
// of the newest GitHub release (issue #54: "main is ahead of the newest
// release" silently accumulated for 18 months).
//
// The guard's non-obvious contract worth locking down:
//   - the manifest version must be three-part semver before a tag can be
//     derived (`b` prefix, README "Releasing": version 1.0.3 -> b1.0.3);
//   - a *published* (non-draft) release carrying the expected tag is in
//     sync — a release flagged isPrerelease still satisfies the tag,
//     only drafts are excluded;
//   - the newest-release hint sorts by publishedAt, not list order;
//   - a gh failure (no gh / not authenticated / unparsable output) is a
//     tooling problem (exit 2), never a drift verdict (exit 1) — a
//     flaky gh must not be mistaken for a missing release.
//
// The gh layer (execFileSync of `gh release list`) is exercised for real
// by the CI validate job; only the pure core is tested here, matching the
// sibling guard tests (tests/release-tag-hygiene.test.js,
// tests/changelog-drift.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkReleaseDrift, exitCodeForStatus } from '../scripts/check-release-drift.mjs';

const releases = (list) => () => list;

test('in sync: a published release with the expected b<version> tag', () => {
  const r = checkReleaseDrift('1.0.3', releases([
    { tagName: 'b1.0.2', publishedAt: '2026-09-29T02:26:31Z', isDraft: false, isPrerelease: false },
    { tagName: 'b1.0.3', publishedAt: '2026-11-13T02:46:10Z', isDraft: false, isPrerelease: false },
  ]));
  assert.equal(r.status, 'sync');
  assert.equal(r.expectedTag, 'b1.0.3');
  assert.equal(r.release.tagName, 'b1.0.3');
});

test('in sync even when the matching release is listed before older ones (order is not trusted)', () => {
  const r = checkReleaseDrift('2.0.0', releases([
    { tagName: 'b2.0.0', publishedAt: '2026-01-02T00:00:00Z', isDraft: false, isPrerelease: false },
    { tagName: 'b1.0', publishedAt: '2025-04-03T19:15:35Z', isDraft: false, isPrerelease: false },
  ]));
  assert.equal(r.status, 'sync');
});

test('a draft release with the expected tag is NOT in sync', () => {
  // Drafts are excluded from the published set: the release workflow's
  // placeholder releases and uncut drafts must not satisfy the guard.
  const r = checkReleaseDrift('3.1.4', releases([
    { tagName: 'b3.1.4', publishedAt: '2026-11-01T00:00:00Z', isDraft: true, isPrerelease: false },
    { tagName: 'b3.1.3', publishedAt: '2026-10-01T00:00:00Z', isDraft: false, isPrerelease: false },
  ]));
  assert.equal(r.status, 'drift');
  assert.equal(r.newest.tagName, 'b3.1.3');
});

test('a prerelease release with the expected tag IS in sync', () => {
  // The guard only excludes drafts (isDraft); isPrerelease is carried in
  // the gh JSON but deliberately does not disqualify — a tagged prerelease
  // is still a cut release for the manifest version.
  const r = checkReleaseDrift('0.9.0', releases([
    { tagName: 'b0.9.0', publishedAt: '2026-05-05T00:00:00Z', isDraft: false, isPrerelease: true },
  ]));
  assert.equal(r.status, 'sync');
});

test('drift: no release carries the expected tag; newest hint is the most recent published', () => {
  const r = checkReleaseDrift('1.1.0', releases([
    { tagName: 'b1.0', publishedAt: '2025-04-03T19:15:35Z', isDraft: false, isPrerelease: false },
    { tagName: 'b1.0.2', publishedAt: '2026-09-29T02:26:31Z', isDraft: false, isPrerelease: false },
    { tagName: 'b1.0.3', publishedAt: '2026-11-13T02:46:10Z', isDraft: false, isPrerelease: false },
  ]));
  assert.equal(r.status, 'drift');
  assert.equal(r.expectedTag, 'b1.1.0');
  // Sorted by publishedAt, not by list order — the newest is b1.0.3
  // even though it is last in the array.
  assert.equal(r.newest.tagName, 'b1.0.3');
});

test('drift: newest hint ignores drafts', () => {
  const r = checkReleaseDrift('9.9.9', releases([
    { tagName: 'b9.9.8', publishedAt: '2026-01-01T00:00:00Z', isDraft: false, isPrerelease: false },
    { tagName: 'b9.9.9', publishedAt: '2026-12-01T00:00:00Z', isDraft: true, isPrerelease: false },
  ]));
  assert.equal(r.status, 'drift');
  assert.equal(r.newest.tagName, 'b9.9.8');
});

test('drift: an empty release list reports newest = null', () => {
  const r = checkReleaseDrift('1.0.0', releases([]));
  assert.equal(r.status, 'drift');
  assert.equal(r.newest, null);
});

test('drift: list order is not trusted for the newest hint (publishedAt wins)', () => {
  const r = checkReleaseDrift('5.0.0', releases([
    { tagName: 'b4.0.0', publishedAt: '2026-06-01T00:00:00Z', isDraft: false, isPrerelease: false },
    { tagName: 'b3.0.0', publishedAt: '2026-07-01T00:00:00Z', isDraft: false, isPrerelease: false },
  ]));
  assert.equal(r.status, 'drift');
  assert.equal(r.newest.tagName, 'b3.0.0');
});

test('bad version: not three-part semver fails before gh is consulted', () => {
  let ghCalled = false;
  const r = checkReleaseDrift('1.0', () => {
    ghCalled = true;
    throw new Error('must not be called');
  });
  assert.equal(r.status, 'bad-version');
  assert.equal(r.version, '1.0');
  assert.equal(ghCalled, false);
});

test('bad version: four-part and non-numeric versions are rejected', () => {
  assert.equal(checkReleaseDrift('1.0.3.1', releases([])).status, 'bad-version');
  assert.equal(checkReleaseDrift('1.0.3-rc.1', releases([])).status, 'bad-version');
  assert.equal(checkReleaseDrift('v1.0.3', releases([])).status, 'bad-version');
  assert.equal(checkReleaseDrift('', releases([])).status, 'bad-version');
  assert.equal(checkReleaseDrift(undefined, releases([])).status, 'bad-version');
});

test('tooling error: a throwing gh call (no gh / not authenticated) is never a drift verdict', () => {
  const r = checkReleaseDrift('1.0.3', () => {
    throw new Error(`gh: not found`);
  });
  assert.equal(r.status, 'tooling-error');
  assert.equal(r.expectedTag, 'b1.0.3');
  assert.match(r.detail, /not found/);
});

test('tooling error: unparsable / non-array gh output', () => {
  assert.equal(checkReleaseDrift('1.0.3', () => ({ tagName: 'b1.0.3' })).status, 'tooling-error');
  assert.equal(checkReleaseDrift('1.0.3', () => '[]').status, 'tooling-error');
  assert.equal(checkReleaseDrift('1.0.3', () => null).status, 'tooling-error');
});

test('exit code contract: 0 = sync, 1 = drift and bad-version, 2 = tooling-error', () => {
  assert.equal(exitCodeForStatus('sync'), 0);
  assert.equal(exitCodeForStatus('drift'), 1);
  assert.equal(exitCodeForStatus('bad-version'), 1);
  assert.equal(exitCodeForStatus('tooling-error'), 2);
});
