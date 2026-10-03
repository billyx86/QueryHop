// Unit tests for scripts/check-release-tag-hygiene.mjs (issue #67): the
// classification core that keeps release tags (`b*`) from being orphaned
// off main or silently running a stale release pipeline.
//
// The incident: b1.0.2 pointed at a pre-#65 commit for weeks. GitHub
// Actions checks out the workflow file FROM the ref being run, so
// re-pushing that tag would execute the old, broken release-macos.yml —
// fixes on main never retroactively protect an old tag.
//
// Only the pure classification is unit-tested here; the git layer
// (fetch + merge-base) needs a real repo and is exercised for real by
// the CI validate job.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTags } from '../scripts/check-release-tag-hygiene.mjs';

test('evaluateTags: all tags on main with current workflow is healthy', () => {
  const r = evaluateTags(
    [
      { tag: 'b1.0', onMain: true },
      { tag: 'b1.0-2', onMain: true },
      { tag: 'b1.0.2', onMain: true, hasCurrentWorkflow: true },
    ],
    { currentTag: 'b1.0.2' }
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.orphaned, []);
  assert.equal(r.stale, null);
});

test('evaluateTags: a tag not reachable from main is orphaned', () => {
  const r = evaluateTags(
    [
      { tag: 'b1.0.2', onMain: false },
      { tag: 'b1.0', onMain: true },
    ],
    { currentTag: 'b1.0.2' }
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.orphaned, ['b1.0.2']);
});

test('evaluateTags: an undecidable tag (null) fails closed', () => {
  // An object missing after fetch cannot be vouched for.
  const r = evaluateTags(
    [{ tag: 'b9.9.9', onMain: null }, { tag: 'b1.0', onMain: true }],
    { currentTag: 'b1.0' }
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.orphaned, ['b9.9.9']);
});

test('evaluateTags: non-release tags are ignored', () => {
  const r = evaluateTags(
    [
      { tag: 'v1.0', onMain: false },
      { tag: 'experiment', onMain: false },
      { tag: 'b1.0', onMain: true, hasCurrentWorkflow: true },
    ],
    { currentTag: 'b1.0' }
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.orphaned, []);
  assert.equal(r.stale, null);
});

test('evaluateTags: an empty tag list is healthy', () => {
  const r = evaluateTags([], { currentTag: 'b1.0.2' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.orphaned, []);
  assert.equal(r.stale, null);
});

test('evaluateTags: the current tag predating the workflow is stale', () => {
  // The exact #67 shape: b1.0.2 is reachable from main (so the orphan
  // check passes) but predates the latest release-macos.yml change, so a
  // re-push would run the old pipeline.
  const r = evaluateTags(
    [
      { tag: 'b1.0', onMain: true },
      { tag: 'b1.0.2', onMain: true, hasCurrentWorkflow: false },
    ],
    { currentTag: 'b1.0.2' }
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.orphaned, []);
  assert.equal(r.stale, 'b1.0.2');
});

test('evaluateTags: historical tags are not required to carry the current workflow', () => {
  // Grandfathering: only the current version's tag is held to
  // hasCurrentWorkflow — demanding every historical tag be re-pointed at
  // the newest main on each workflow change would be pure churn.
  const r = evaluateTags(
    [
      { tag: 'b1.0', onMain: true, hasCurrentWorkflow: false },
      { tag: 'b1.0-2', onMain: true, hasCurrentWorkflow: false },
      { tag: 'b1.0.2', onMain: true, hasCurrentWorkflow: true },
    ],
    { currentTag: 'b1.0.2' }
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.orphaned, []);
  assert.equal(r.stale, null);
});

test('evaluateTags: a stale current tag also orphaned reports both', () => {
  const r = evaluateTags(
    [{ tag: 'b1.0.2', onMain: false }],
    { currentTag: 'b1.0.2' }
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.orphaned, ['b1.0.2']);
  // Orphaned already implies unusable; stale is only reported for
  // on-main tags so the remediation message stays accurate.
  assert.equal(r.stale, null);
});
