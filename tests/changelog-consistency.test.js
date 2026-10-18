// Unit tests for scripts/check-changelog.mjs (issue #117): the changelog
// decision core that keeps the GitHub release notes from shipping with the
// workflow's placeholder sentence.
//
// The gap: release-macos.yml creates each release body from the CHANGELOG
// section matching the release version; with no section the release ships
// with the placeholder text ("Replace these notes with the curated
// changelog") and users of a redaction-sensitive extension get zero
// per-release change information. This core is what the CI validate job
// (scripts/check-changelog.mjs) and the release workflow's note assembly
// both run.
//
// Only the pure core is unit-tested here (same split as
// release-tag-hygiene.test.js); the git/manifest layer is exercised by
// the CI validate job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseChangelog, checkChangelog } from '../scripts/check-changelog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SAMPLE = `# Changelog

All notable changes to QueryHop are documented here.

## [Unreleased]

Work on main since 1.0.2:

- **Thing** — it works (issue #999).

## [1.0.2] - 2026-09-29

First release in 18 months.

- **Settings cache fix** — edits apply immediately (issue #55).

## [1.0-2] - 2025-04-04

Renamed to QueryHop.

## [1.0] - 2025-04-03

Initial release of Safari Search Redirector.
`;

test('parseChangelog: sections are extracted in document order with their bodies', () => {
  const { sections, unreleased } = parseChangelog(SAMPLE);
  assert.deepEqual(
    sections.map((s) => s.version),
    ['Unreleased', '1.0.2', '1.0-2', '1.0']
  );
  assert.match(sections[1].body, /Settings cache fix/);
  assert.doesNotMatch(sections[1].body, /Renamed to QueryHop/, 'a body must not bleed into the next section');
  assert.doesNotMatch(sections[1].body, /^## \[/m);
  assert.match(unreleased, /it works/);
  // Trailing blank lines are trimmed so emptiness is decidable.
  assert.equal(sections[0].body.endsWith('\n'), false);
});

test('parseChangelog: a document without sections has none', () => {
  const { sections, unreleased } = parseChangelog('# Changelog\n\nJust prose.\n');
  assert.deepEqual(sections, []);
  assert.equal(unreleased, null);
});

test('checkChangelog: a missing file fails with missing-file', () => {
  const r = checkChangelog(null, { version: '1.0.2' });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'missing-file');
});

test('checkChangelog: a missing version section fails with missing-section', () => {
  const r = checkChangelog(SAMPLE, { version: '1.0.3' });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'missing-section');
  assert.match(r.reason, /1\.0\.3/);
});

test('checkChangelog: an empty section fails with empty-section', () => {
  const text = '## [1.0.2]\n\n\n## [1.0] - 2025-04-03\n\nInitial.\n';
  const r = checkChangelog(text, { version: '1.0.2' });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'empty-section');
});

test('checkChangelog: a non-empty current section passes', () => {
  const r = checkChangelog(SAMPLE, { version: '1.0.2' });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'ok');
});

test('checkChangelog: the Unreleased section does not satisfy a version check', () => {
  // A changelog that only ever grows [Unreleased] (never cut into version
  // sections) must not silently certify itself for a release.
  const text = '## [Unreleased]\n\n- stuff\n';
  const r = checkChangelog(text, { version: '1.0.3' });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'missing-section');
});

test('checkChangelog: the real CHANGELOG.md passes for the current manifest version', () => {
  // Self-check against the repo's own files: the very state CI verifies.
  // (The manifest-read layer is the CLI's; here we pin the content
  // contract directly — 1.0.2 is the released version the guard shipped
  // with, so it must have a section.)
  const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const r = checkChangelog(text, { version: '1.0.2' });
  assert.equal(r.ok, true, r.reason);
});
