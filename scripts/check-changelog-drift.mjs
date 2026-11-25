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
// merge commit message cites (the PR itself, an issue it closed in the
// title, or an issue cited in the squash body — the PR body is
// appended to the squash commit message) is cited in the section.
// Body citations close the issue-less-title gap: a squash merge whose
// TITLE cites no issues was irreconcilable from subject alone (the
// entry precedes the PR number), leaving main red after PR #189
// (issue #190).
//
// Subject shapes counted as a PR merge:
//   - squash merges: "<subject> (#<PR>)" — the trailing group carries
//     the PR number; the subject or the body may also cite issues
//     ("(#167–#170)")
//   - merge commits: "Merge pull request #<PR> from ..."
// Commits whose full message cites no #numbers at all are skipped — a
// numberless merge shape cannot be cited, and both merge shapes above
// always carry one.
//
// A merge commit's subject carries ONLY the PR number, so its citations
// are resolved through its second parent (issue #184): every #number
// cited in the subjects of the commits the merge introduced — reachable
// from the second parent, not from the first — counts toward it. That
// is the only reachable acknowledgment for a merge-commit PR: its
// changelog entry is written before the PR number exists, so it cites
// the issues, never the PR itself.
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
 * The #numbers a full commit message cites: every #number in the
 * subject or the body.
 *
 * A squash commit's body carries the PR body (GitHub appends the PR
 * description to the squash message), and a PR's changelog entry is
 * written before the PR number exists — so a squash merge whose TITLE
 * cites no issues is still reconcilable through the issues its body
 * cites. Subject-only resolution was the gap that left main red after
 * PR #189 merged with an issue-less title (issue #190). For the
 * subject line this agrees exactly with commitCitedNumbers (the merge
 * prefix's "#N" is itself a #number), so no subject-only caller is
 * affected.
 *
 * @param {string} message the full commit message (subject + body)
 * @returns {number[]} the cited #numbers, deduped, possibly empty
 */
export function messageCitedNumbers(message) {
  return [...extractCitedNumbers(message)];
}

/**
 * Decide whether the [Unreleased] section acknowledges every PR that
 * merged since the current version's tag.
 *
 * @param {string[]} mergeMessages the full commit messages since the
 *   tag (e.g. `git log b1.0.3..HEAD --format=%B`), oldest first. A
 *   message's subject line is what identifies the merge; the body
 *   carries the squash PR body, whose issue citations count too
 *   (issue #190).
 * @param {string|null} unreleasedBody the [Unreleased] section body
 *   (`parseChangelog(...).unreleased`), or null when the section is
 *   absent.
 * @param {Map<string, number[]>} [introducedByMerge] optional map from
 *   a merge-commit subject to the #numbers cited by the commits that
 *   merge introduced (reachable from the second parent, not from the
 *   first). A merge commit's subject carries only the PR number, and a
 *   PR's changelog entry is written before the PR number exists, so
 *   for a merge-commit PR the only reachable acknowledgment is an
 *   issue citation in the commits it merged (issue #184). Squash
 *   merges decide on their own full message and ignore the map.
 * @returns {{ok: boolean, uncited: string[], cited: number[]}}
 *   `uncited` = subjects that cite at least one #number none of which
 *   appears in the section; subjects whose full message cites no
 *   numbers are skipped, not failed.
 */
export function evaluateChangelogDrift(
  mergeMessages,
  unreleasedBody,
  introducedByMerge = new Map()
) {
  const cited = extractCitedNumbers(unreleasedBody);
  const uncited = [];
  for (const message of mergeMessages) {
    const text = String(message ?? '');
    const subject = text.split('\n', 1)[0] ?? '';
    const isMerge = /^Merge pull request #\d+/.test(subject);
    const nums = isMerge
      ? [...commitCitedNumbers(subject), ...(introducedByMerge.get(subject) ?? [])]
      : messageCitedNumbers(text);
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
 * For every merge commit in a range, collect the #numbers cited by the
 * subjects of the commits that merge introduced — reachable from its
 * second (or later) parent but not from its first parent. Returns a map
 * keyed by the merge commit's subject (issue #184).
 *
 * A merge commit's subject cites only the PR number, and a PR's
 * changelog entry is written before the PR number exists, so the only
 * reachable acknowledgment for a merge-commit PR is an issue citation
 * in the commits it merged. Squash-merge commits (a single parent) are
 * absent from the map and keep the subject-only behavior.
 *
 * @param {string} root the repository root
 * @param {string} range a `git log` range (e.g. `b1.0.3..HEAD`)
 * @returns {Map<string, number[]>} merge subject → deduped #numbers
 */
export function mergeIntroducedNumbers(root, range) {
  const out = new Map();
  const lines = git(root, ['log', '--format=%P%x1f%s', range])
    .split('\n')
    .filter(Boolean);
  const merges = [];
  for (const line of lines) {
    const [parents, subject] = line.split('\x1f');
    const parentList = parents.split(' ').filter(Boolean);
    if (parentList.length >= 2) {
      merges.push({ subject, base: parentList[0], sides: parentList.slice(1) });
    }
  }
  for (const { subject, base, sides } of merges) {
    // The PR number from the merge subject itself plus every number
    // cited by the commits the merge introduced (subject or body —
    // the same citation surface as the squash path, issue #190).
    const numbers = new Set(commitCitedNumbers(subject));
    for (const side of sides) {
      try {
        const introduced = git(
          root,
          ['log', '--format=%B%x00', `${base}..${side}`]
        )
          .split('\x00')
          .filter((m) => m.trim().length > 0);
        for (const msg of introduced) {
          for (const n of messageCitedNumbers(msg)) numbers.add(n);
        }
      } catch {
        // A side parent missing from a partial history degrades to the
        // merge subject's own numbers — same as before issue #184.
      }
    }
    out.set(subject, [...numbers]);
  }
  return out;
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

    // Full messages (%B, NUL-separated so bodies with embedded newlines
    // stay intact): the subject identifies the merge, and a squash
    // message's body — the PR body — carries issue citations that count
    // toward the entry (issue #190).
    const subjects = git(root, ['log', '--format=%B%x00', `${tag}..HEAD`])
      .split('\x00')
      .filter((m) => m.trim().length > 0);
    const introduced = mergeIntroducedNumbers(root, `${tag}..HEAD`);

    const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const { unreleased } = parseChangelog(text);
    const verdict = evaluateChangelogDrift(subjects, unreleased, introduced);
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
