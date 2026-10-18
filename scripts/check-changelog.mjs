#!/usr/bin/env node
//
// check-changelog.mjs
//
// Guards the CHANGELOG.md that the release workflow assembles release
// notes from (issue #117).
//
// release-macos.yml creates each GitHub release body from the CHANGELOG
// section matching the release version; without a section, the release
// ships with the workflow's placeholder sentence and users of a
// redaction-sensitive extension get zero per-release change information.
// This guard fails the push when the current manifest version's section
// is missing or empty — the section must land in the same commit as the
// version bump, so a release can never be cut from an empty changelog.
//
// This deliberately FAILS (rather than warning, as #118's stale-tag
// state does) because there is no deadlock: the section is added in the
// very PR that bumps the version, so the fix is always reachable before
// merge — unlike the tag re-point, which can only happen after the merge.
//
// Format: Keep a Changelog — one `## [<version>]` (or `## [Unreleased]`)
// section per released version, newest first, body = the lines up to the
// next `## ` header.
//
// Exit codes: 0 = the current version has a non-empty section,
// 1 = CHANGELOG.md missing, or the section is missing/empty,
// 2 = tooling/environment problem (unreadable manifest, bad arguments).
//
// stdlib-only, matching the repo's zero-npm-deps policy. The pure
// decision core (parseChangelog / checkChangelog) is imported by
// tests/changelog-consistency.test.js.

import { existsSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CHANGELOG = 'CHANGELOG.md';
const MANIFEST = path.join('QueryHop Extension', 'Resources', 'manifest.json');

// ---- pure core (unit-tested on every CI run) ---------------------------

/**
 * Parse a Keep a Changelog document into its version sections.
 *
 * @param {string} text the full CHANGELOG.md text
 * @returns {{unreleased: string|null, sections: Array<{version: string, body: string}>}}
 *   sections in document order, each `version` the raw header label
 *   ("Unreleased" for the unreleased section, otherwise the version
 *   string such as "1.0.2"); `body` is the section text (header line
 *   excluded) up to the next `## ` header, with trailing blank lines
 *   trimmed. `unreleased` is the unreleased body for convenience
 *   (null when absent).
 */
export function parseChangelog(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  const headerRe = /^## \[([^\]]+)\][^\n]*$/;
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      current = { version: m[1].trim(), body: '' };
      sections.push(current);
      continue;
    }
    if (current) current.body += line + '\n';
  }
  for (const s of sections) s.body = s.body.replace(/\n+$/, '');
  const unreleased = sections.find((s) => s.version === 'Unreleased') || null;
  return { unreleased: unreleased ? unreleased.body : null, sections };
}

/**
 * Decide whether the changelog is ready for a release of `version`.
 *
 * @param {string|null} changelogText the CHANGELOG.md text, or null when
 *   the file is missing.
 * @param {{version: string}} opts the manifest version to check
 *   (e.g. "1.0.2") — the section `## [<version>]` must exist and carry
 *   at least one non-blank line.
 * @returns {{ok: boolean, state: 'missing-file'|'missing-section'|'empty-section'|'ok', reason: string}}
 */
export function checkChangelog(changelogText, { version }) {
  if (changelogText === null) {
    return {
      ok: false,
      state: 'missing-file',
      reason: `CHANGELOG.md is missing — the release workflow has no notes to assemble from (issue #117)`,
    };
  }
  const { sections } = parseChangelog(changelogText);
  const section = sections.find((s) => s.version === version);
  if (!section) {
    return {
      ok: false,
      state: 'missing-section',
      reason: `CHANGELOG.md has no "## [${version}]" section for the current version — add it in the version-bump commit so the release notes can be assembled from it (issue #117)`,
    };
  }
  if (!section.body.split('\n').some((l) => l.trim() !== '')) {
    return {
      ok: false,
      state: 'empty-section',
      reason: `CHANGELOG.md's "## [${version}]" section is empty — record what changed before the release is cut (issue #117)`,
    };
  }
  return {
    ok: true,
    state: 'ok',
    reason: `CHANGELOG.md has a non-empty "## [${version}]" section for the current version`,
  };
}

// ---- CLI ----------------------------------------------------------------

// Run as a CLI (node scripts/check-changelog.mjs [root]) — the pure core
// is imported by the tests, so guard on the real file path rather than
// argv[1] (unset when the module is imported).
if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const [root = process.cwd()] = process.argv.slice(2);
  const manifestPath = path.join(root, MANIFEST);
  let version;
  try {
    version = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
  } catch (error) {
    console.error(`FAIL: could not read the manifest version from ${MANIFEST}: ${error.message || error}`);
    process.exit(2);
  }
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`FAIL: manifest version "${version}" is not three-part semver (version-sync.test.js is the guard for the format itself).`);
    process.exit(2);
  }
  const changelogPath = path.join(root, CHANGELOG);
  const text = existsSync(changelogPath)
    ? readFileSync(changelogPath, 'utf8')
    : null;
  const verdict = checkChangelog(text, { version });
  if (verdict.ok) {
    console.log(`OK: ${verdict.reason}.`);
    process.exit(0);
  }
  console.error(`FAIL: ${verdict.reason}.`);
  process.exit(1);
}
