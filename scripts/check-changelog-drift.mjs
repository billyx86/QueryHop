#!/usr/bin/env node
//
// check-changelog-drift.mjs
//
// Guards against the class of gap documented in issue #182: the
// [Unreleased] section of CHANGELOG.md only needs to be non-empty to
// satisfy check-changelog.mjs, so merged work can accumulate without
// ever being recorded — and the next release's notes (assembled from
// this section, issue #117) then silently drop user-visible changes.
//
// Invariant: every PR that merged to main since the current version's
// release tag (b<manifest version>) must be acknowledged in the
// [Unreleased] section — i.e. at least one of the #numbers the PR's
// merge subject cites (the PR itself, or an issue it closed) is cited
// in the section. The changelog entry lands in the same PR as (or
// after) the work, so the invariant is always reachable before merge:
// a PR whose diff adds the missing entry passes at its own HEAD.
//
// Subject shapes counted as a PR merge:
//   - squash merges: "<subject> (#<PR>)" — the trailing group carries
//     the PR number; the subject may also cite issues ("(#167–#170)")
//   - merge commits: "Merge pull request #<PR> from ..."
// Commits whose subjects cite no numbers at all are skipped — a
// numberless merge shape cannot be cited, and both merge shapes above
// always carry one.
//
// Baseline: the tag b<version> of the CURRENT manifest version. After
// a version bump, [Unreleased] is re-cut and the baseline moves with
// the new tag, so history before the cut is never re-demanded.
//
// Exit codes: 0 = every merged PR is cited (or the current version's
// tag does not exist yet — check-release-drift.mjs owns that failure
// and fails the same push, so skipping here cannot hide a gap),
// 1 = uncited merge(s) found,
// 2 = tooling/environment problem (unreadable manifest, git failure).
//
// stdlib-only, matching the repo's zero-npm-deps policy. The pure
// decision core (extractCitedNumbers / commitCitedNumbers /
// evaluateChangelogDrift) is imported by
// tests/changelog-drift.test.js.

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseChangelog } from './check-changelog.mjs';

const MANIFEST = path.join('QueryHop Extension', 'Resources', 'manifest.json');

// ---- pure core (unit-tested on every CI run) ---------------------------

/**
 * Extract every #number cited in a changelog section body.
 *
 * A range like "#167–#170" cites both endpoints (each carries its own
 * `#`); a bare version string such as "1.0.3" cites nothing.
 *
 * @param {string|null} text the section body (null when the section
 *   is absent).
 * @returns {Set<number>} the cited numbers.
 */
export function extractCitedNumbers(text) {
  const nums = new Set();
  for (const m of String(text ?? '').matchAll(/#(\d+)/g)) nums.add(Number(m[1]));
  return nums;
}

/**
 * The #numbers a merge subject cites: the PR number of a merge commit
 * plus every number inside any parenthesized group (a squash subject's
 * trailing "(#PR)" together with its issue citations).
 *
 * @param {string} subject a commit subject line.
 * @returns {number[]} the cited numbers, possibly empty.
 */
export function commitCitedNumbers(subject) {
  const s = String(subject);
  const nums = [];
  const merge = s.match(/^Merge pull request #(\d+)/);
  if (merge) nums.push(Number(merge[1]));
  for (const g of s.matchAll(/\(([^)]*)\)/g)) {
    for (const n of g[1].matchAll(/#(\d+)/g)) nums.push(Number(n[1]));
  }
  return nums;
}

/**
 * Decide whether the [Unreleased] section acknowledges every PR that
 * merged since the current version's tag.
 *
 * @param {string[]} mergeSubjects the commit subjects since the tag
 *   (e.g. `git log b1.0.3..HEAD --format=%s`), oldest first.
 * @param {string|null} unreleasedBody the [Unreleased] section body
 *   (`parseChangelog(...).unreleased`), or null when the section is
 *   absent.
 * @returns {{ok: boolean, uncited: string[], cited: number[]}}
 *   `uncited` = subjects that cite at least one #number none of which
 *   appears in the section; subjects citing no numbers are skipped,
 *   not failed.
 */
export function evaluateChangelogDrift(mergeSubjects, unreleasedBody) {
  const cited = extractCitedNumbers(unreleasedBody);
  const uncited = [];
  for (const subject of mergeSubjects) {
    const nums = commitCitedNumbers(subject);
    if (nums.length === 0) continue;
    if (!nums.some((n) => cited.has(n))) uncited.push(subject);
  }
  return { ok: uncited.length === 0, uncited, cited: [...cited] };
}

// ---- git layer (CI / manual) -------------------------------------------

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Evaluate the drift invariant for the current manifest version.
 * Deepens a shallow CI checkout first (same pattern as
 * check-release-tag-hygiene.mjs) so the tag..HEAD range is exact.
 *
 * @returns {{ok: boolean, skipped?: string, uncited?: string[], subjectsChecked?: number}}
 *   `skipped` is set (and ok is true) when the current version's tag
 *   does not exist — the release-drift guard fails the same push.
 */
export function checkChangelogDrift(root) {
  let version;
  try {
    version = JSON.parse(
      readFileSync(path.join(root, MANIFEST), 'utf8')
    ).version;
  } catch (error) {
    return {
      ok: false,
      error: `could not read the manifest version: ${error.message || error}`,
    };
  }
  try {
    try {
      git(root, ['fetch', '--unshallow', 'origin']);
    } catch {
      // Already a complete repository.
    }
    git(root, ['fetch', '--tags', '--prune', 'origin']);
    git(root, ['fetch', 'origin', 'main']);

    const tag = `b${version}`;
    try {
      // Peel the tag to its commit to prove it exists (annotated tags
      // cannot be range endpoints directly).
      git(root, ['rev-parse', `-q`, `--verify`, `${tag}^{commit}`]);
    } catch {
      return {
        ok: true,
        skipped: `${tag} does not exist (check-release-drift.mjs fails the same push)`,
      };
    }

    const subjects = git(root, ['log', '--format=%s', `${tag}..HEAD`])
      .split('\n')
      .filter(Boolean);

    const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const { unreleased } = parseChangelog(text);
    const verdict = evaluateChangelogDrift(subjects, unreleased);
    return {
      ok: verdict.ok,
      uncited: verdict.uncited,
      subjectsChecked: subjects.length,
      tag,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error.stderr || error.message || error),
    };
  }
}

// ---- CLI ----------------------------------------------------------------
//
// Run as a CLI (node scripts/check-changelog-drift.mjs [root]) — the pure
// core is imported by the tests, so guard on the real file path rather
// than argv[1] (unset when the module is imported).

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const [root = process.cwd()] = process.argv.slice(2);
  const result = checkChangelogDrift(root);
  if (result.error) {
    console.error(`FAIL: ${result.error}`);
    process.exit(2);
  }
  if (result.skipped) {
    console.log(`OK: skipped — ${result.skipped}.`);
    process.exit(0);
  }
  if (!result.ok) {
    console.error(
      `FAIL: ${result.uncited.length} PR(s) merged since ${result.tag} have no entry in CHANGELOG.md's [Unreleased] section (issue #182):`
    );
    for (const subject of result.uncited) console.error(`  ${subject}`);
    console.error(
      '\nAdd one entry per PR to the [Unreleased] section (the entry may land in the same PR as the work).'
    );
    process.exit(1);
  }
  console.log(
    `OK: all ${result.subjectsChecked} commit(s) merged since ${result.tag} are acknowledged in the [Unreleased] section.`
  );
  process.exit(0);
}
