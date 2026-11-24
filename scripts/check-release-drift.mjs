#!/usr/bin/env node
//
// check-release-drift.mjs
//
// Guards against the release/manifest version drift documented in issue
// #54: the manifest.json version must have a corresponding GitHub release,
// tagged with the `b` prefix the earlier releases used (README "Releasing":
// version 1.0.3 -> tag b1.0.3). This fails until a release for the current
// version exists, so "main is ahead of the newest release" can't silently
// accumulate for 18 months again.
//
// Reads manifest.json from the repo (so it runs on any branch in CI) and
// asks `gh` for the release list. Exit codes: 0 = in sync, 1 = drift or
// bad version, 2 = tooling problem (no gh / not authenticated).
//
// Two layers, mirroring check-release-tag-hygiene.mjs (issue #67):
//   - evaluateReleaseDrift(version, releases): the pure decision core,
//     unit-tested in tests/release-drift.test.js (issue #186).
//   - checkReleaseDrift(root): the manifest + `gh` layer; the CLI below
//     only formats its result into the messages above and exits.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- pure core (unit-tested on every CI run) --------------------------

/**
 * Classify a manifest version against the release list from `gh`.
 *
 * Only a full release satisfies the expected tag: a draft or a prerelease
 * cut for the version is not the release this guard exists to wait for,
 * so neither counts as in sync, and neither is reported as the newest
 * published release either.
 *
 * @param {string} version manifest.json version, e.g. "1.0.3"
 * @param {Array<{tagName: string, publishedAt?: string, isDraft?: boolean, isPrerelease?: boolean}>} releases
 *   rows from `gh release list --json tagName,publishedAt,isDraft,isPrerelease`
 * @returns {{ok: boolean, reason: 'in-sync'|'drift'|'bad-version', expectedTag: string|null, current: object|null, newest: object|null}}
 */
export function evaluateReleaseDrift(version, releases) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return {
      ok: false,
      reason: 'bad-version',
      expectedTag: null,
      current: null,
      newest: null,
    };
  }

  const expectedTag = `b${version}`;
  const published = releases.filter((r) => !r.isDraft && !r.isPrerelease);
  const current = published.find((r) => r.tagName === expectedTag) ?? null;
  if (current) {
    return { ok: true, reason: 'in-sync', expectedTag, current, newest: null };
  }

  const newest =
    [...published].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))[0] ??
    null;
  return { ok: false, reason: 'drift', expectedTag, current: null, newest };
}

// ---- manifest + gh layer (CI / manual) --------------------------------

/**
 * Evaluate the manifest version in `root` against the GitHub releases.
 * Never throws for the cases the CLI reports: a bad version or a `gh`
 * failure comes back as a result with `reason: 'bad-version' | 'tooling'`.
 *
 * @param {string} root repo root holding `QueryHop Extension/Resources/manifest.json`
 * @returns {{ok: boolean, reason: 'in-sync'|'drift'|'bad-version'|'tooling', version: string, expectedTag: string|null, current: object|null, newest: object|null, error?: string}}
 */
export function checkReleaseDrift(root) {
  const manifest = JSON.parse(
    readFileSync(
      path.join(root, 'QueryHop Extension/Resources/manifest.json'),
      'utf8'
    )
  );
  const version = manifest.version;

  // Reuse the pure core for the version check so a bad version never
  // reaches `gh` — same order as before the refactor.
  const probe = evaluateReleaseDrift(version, []);
  if (probe.reason === 'bad-version') {
    return { ...probe, version };
  }

  let releases;
  try {
    releases = JSON.parse(
      execFileSync(
        'gh',
        [
          'release',
          'list',
          '--limit',
          '25',
          '--json',
          'tagName,publishedAt,isDraft,isPrerelease',
        ],
        { encoding: 'utf8' }
      )
    );
  } catch (error) {
    return {
      ok: false,
      reason: 'tooling',
      version,
      expectedTag: probe.expectedTag,
      current: null,
      newest: null,
      error: error.message || String(error),
    };
  }

  return { version, ...evaluateReleaseDrift(version, releases) };
}

// ---- CLI ----------------------------------------------------------------

// Run as a CLI (node scripts/check-release-drift.mjs) — the pure core is
// imported by the tests, so guard on the real file path rather than
// argv[1] (unset when the module is imported).
if (
  process.argv[1] &&
  import.meta.url === `file://${realpathSync(process.argv[1])}`
) {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const result = checkReleaseDrift(root);

  if (result.reason === 'bad-version') {
    console.error(
      `FAIL: manifest.json version "${result.version}" is not three-part semver; cannot derive the release tag.`
    );
    process.exit(1);
  }

  if (result.reason === 'tooling') {
    console.error(
      `FAIL: could not list GitHub releases via gh: ${result.error}`
    );
    console.error('       (is gh installed and authenticated?)');
    process.exit(2);
  }

  if (result.ok) {
    console.log(
      `OK: release ${result.expectedTag} exists (published ${result.current.publishedAt}); matches manifest version ${result.version}.`
    );
    process.exit(0);
  }

  const newestDesc = result.newest
    ? `${result.newest.tagName} (published ${result.newest.publishedAt})`
    : 'none';
  console.error(
    `FAIL: no GitHub release for manifest version ${result.version} (expected tag ${result.expectedTag}).`
  );
  console.error(`       Newest published release: ${newestDesc}.`);
  console.error(
    `       Cut it per the README "Releasing" section: git tag ${result.expectedTag}, push it, then create/upload the release.`
  );
  process.exit(1);
}
