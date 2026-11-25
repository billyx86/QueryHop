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
// stdlib-only, matching the repo's zero-npm-deps policy. The pure decision
// core (checkReleaseDrift / exitCodeForStatus) is imported by
// tests/release-drift.test.js (issue #186); the gh layer is exercised for
// real by the CI validate job.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- pure core (unit-tested on every CI run) ---------------------------

/**
 * Decide the release-drift verdict for a manifest version against a list of
 * GitHub releases.
 *
 * @param {unknown} manifestVersion the manifest.json `"version"` field.
 * @param {() => unknown} listReleases a thunk returning the parsed
 *   `gh release list` payload (an array of
 *   `{ tagName, publishedAt, isDraft, isPrerelease }`). It may throw
 *   (no gh, not authenticated, unparsable output) or return a non-array —
 *   both are tooling problems, matching the CLI's exit-2 path.
 * @returns {{status: 'sync'|'drift'|'bad-version'|'tooling-error',
 *   version?: string, expectedTag?: string, detail?: string,
 *   release?: object, newest?: object|null}}
 *   - `bad-version` — the version is not three-part semver, so the tag
 *     cannot be derived. Decided before `listReleases` is consulted.
 *   - `sync` — a published (non-draft) release carries the expected
 *     `b<version>` tag. A release flagged `isPrerelease` still satisfies
 *     the tag: only drafts are excluded.
 *   - `drift` — no published release carries the expected tag; `newest`
 *     is the most recently *published* release by `publishedAt` (list
 *     order is not trusted) or null when there is none.
 *   - `tooling-error` — `listReleases` threw or returned a non-array.
 */
export function checkReleaseDrift(manifestVersion, listReleases) {
  const version = String(manifestVersion ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return {
      status: 'bad-version',
      version,
      detail: `manifest.json version "${version}" is not three-part semver; cannot derive the release tag.`,
    };
  }
  const expectedTag = `b${version}`;

  let releases;
  try {
    releases = listReleases();
  } catch (error) {
    return {
      status: 'tooling-error',
      version,
      expectedTag,
      detail: `could not list GitHub releases via gh: ${error.message || error} (is gh installed and authenticated?)`,
    };
  }
  if (!Array.isArray(releases)) {
    return {
      status: 'tooling-error',
      version,
      expectedTag,
      detail: `gh release list did not return an array (got ${typeof releases}).`,
    };
  }

  const published = releases.filter((r) => r && !r.isDraft);
  const current = published.find((r) => r.tagName === expectedTag);
  if (current) {
    return { status: 'sync', version, expectedTag, release: current };
  }

  const newest =
    [...published].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))[0] ?? null;
  return { status: 'drift', version, expectedTag, newest };
}

/**
 * The CLI exit-code contract (issue #186): 0 = in sync, 1 = drift or bad
 * version, 2 = tooling problem.
 *
 * @param {'sync'|'drift'|'bad-version'|'tooling-error'} status
 * @returns {0|1|2}
 */
export function exitCodeForStatus(status) {
  if (status === 'sync') return 0;
  if (status === 'tooling-error') return 2;
  return 1; // drift, bad-version
}

// ---- CLI ----------------------------------------------------------------

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'QueryHop Extension/Resources/manifest.json'), 'utf8')
  );
  const result = checkReleaseDrift(manifest.version, () =>
    JSON.parse(
      execFileSync('gh', [
        'release', 'list', '--limit', '25',
        '--json', 'tagName,publishedAt,isDraft,isPrerelease',
      ], { encoding: 'utf8' })
    )
  );
  switch (result.status) {
    case 'sync':
      console.log(
        `OK: release ${result.expectedTag} exists (published ${result.release.publishedAt}); matches manifest version ${result.version}.`
      );
      break;
    case 'bad-version':
      console.error(`FAIL: ${result.detail}`);
      break;
    case 'tooling-error':
      console.error(`FAIL: ${result.detail}`);
      break;
    case 'drift': {
      const newestDesc = result.newest
        ? `${result.newest.tagName} (published ${result.newest.publishedAt})`
        : 'none';
      console.error(`FAIL: no GitHub release for manifest version ${result.version} (expected tag ${result.expectedTag}).`);
      console.error(`       Newest published release: ${newestDesc}.`);
      console.error(`       Cut it per the README "Releasing" section: git tag ${result.expectedTag}, push it, then create/upload the release.`);
      break;
    }
  }
  process.exit(exitCodeForStatus(result.status));
}
