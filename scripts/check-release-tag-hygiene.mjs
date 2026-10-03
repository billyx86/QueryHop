#!/usr/bin/env node
//
// check-release-tag-hygiene.mjs
//
// Guards against the legacy-tag hazard documented in issue #67: b1.0.2
// pointed at a pre-#65 commit for weeks, so re-pushing the tag would run
// the OLD release-macos.yml — GitHub Actions checks out the workflow file
// from the ref being run, so fixes on main never retroactively protect an
// old tag.
//
// Two invariants are enforced:
//
//   1. ORPHAN CHECK (every b* tag): the tag's commit must be reachable
//      from origin/main. A tag cut from a never-merged branch (or
//      re-pointed backwards) is exactly the shape that makes a tag
//      re-push execute stale workflow code from a fork/mirror.
//
//   2. WORKFLOW CHECK (the current version's tag only — the one matching
//      the manifest.json version, e.g. b1.0.2): that commit must contain
//      the latest commit on main that touched
//      .github/workflows/release-macos.yml. If the tag predates the
//      workflow's current version, re-running it executes an older
//      pipeline (no checksum sidecar, no artifact-verification gate, ...).
//
// Invariant 2 deliberately applies only to the current version's tag:
// historical tags (b1.0, b1.0-2) are grandfathered — demanding that
// every historical tag be re-pointed at the newest main on each workflow
// change would be pure churn. The current version's tag is the one
// people actually re-push, and the one whose stale code would ship.
//
// When invariant 2 fails, the fix is one command (README "Releasing",
// tag discipline): re-point the tag to a main commit at/after the last
// workflow change, e.g. `git tag -f b1.0.2 origin/main && git push -f
// origin b1.0.2`.
//
// Exit codes: 0 = no orphaned tags (a stale current tag is WARNED about
// but not fatal by default — see --strict), 1 = orphaned tag(s) found (or
// a stale current tag under --strict), 2 = tooling/environment problem
// (git failure).
//
// Why orphans fail but staleness only warns by default: a tag that is not
// reachable from main is an unambiguous error (a fork/mirror re-push would
// run code from a branch that never merged). "Stale" — the current tag
// predates the latest release-macos.yml change — is a normal transient
// state: every PR that touches the release workflow makes the tag stale
// until the tag is re-pointed after merge. Hard-failing CI on staleness
// would deadlock exactly the PRs that fix the workflow, so staleness is
// a warning in CI and a hard failure only under --strict (use it right
// before re-pointing a tag, to confirm the new target contains the
// current workflow).

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

// ---- pure core (unit-tested on every CI run) --------------------------

/**
 * Classify release tags given their ancestry status.
 *
 * @param {Array<{tag: string, onMain: boolean|null, hasCurrentWorkflow?: boolean|null}>} tags
 *   onMain: true/false from `git merge-base --is-ancestor <tag> origin/main`;
 *   null = undecidable (object missing after fetch) — fail closed.
 *   hasCurrentWorkflow: for the current version's tag, whether the last
 *   main commit that touched release-macos.yml is an ancestor of the
 *   tag; null = undecidable.
 * @param {{currentTag?: string|null}} opts the tag expected for the
 *   manifest version (e.g. "b1.0.2"); invariant 2 applies to it only.
 * @returns {{ok: boolean, orphaned: string[], stale: string|null}}
 */
export function evaluateTags(tags, { currentTag = null } = {}) {
  const orphaned = [];
  let stale = null;
  for (const t of tags) {
    if (!t.tag || !/^b/.test(t.tag)) continue; // only release tags
    if (t.onMain !== true) {
      orphaned.push(t.tag);
      continue;
    }
    if (
      currentTag &&
      t.tag === currentTag &&
      t.hasCurrentWorkflow !== true
    ) {
      stale = t.tag;
    }
  }
  return { ok: orphaned.length === 0 && stale === null, orphaned, stale };
}

// ---- git layer (CI / manual) ------------------------------------------

const WORKFLOW = '.github/workflows/release-macos.yml';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Evaluate every b* tag against origin/main. Fetches first (deepening a
 * shallow CI checkout so `merge-base --is-ancestor` is exact — on a
 * shallow history it can report a false negative).
 */
export function checkRepo(root) {
  try {
    try {
      git(root, ['fetch', '--unshallow', 'origin']);
    } catch {
      // Already a complete repository.
    }
    git(root, ['fetch', '--tags', '--prune', 'origin']);
    git(root, ['fetch', 'origin', 'main']);

    // The tag expected for the current manifest version (invariant 2).
    const manifestPath = path.join(
      root,
      'QueryHop Extension/Resources/manifest.json'
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const currentTag = `b${manifest.version}`;

    const lastWorkflowCommit =
      git(root, ['log', '-1', '--format=%H', 'origin/main', '--', WORKFLOW]).trim() ||
      null;

    const tagLines = git(root, ['tag', '-l', 'b*']).trim().split('\n');
    const tags = [];
    for (const tag of tagLines.filter(Boolean)) {
      let onMain = null;
      let tagCommit = null;
      try {
        // Peel annotated tags to their commit.
        tagCommit = git(root, ['rev-parse', `${tag}^{commit}`]).trim();
        git(root, ['merge-base', '--is-ancestor', tagCommit, 'FETCH_HEAD']);
        onMain = true;
      } catch {
        onMain = false; // missing object or not an ancestor — fail closed
      }
      let hasCurrentWorkflow = null;
      if (onMain === true && tag === currentTag && lastWorkflowCommit) {
        try {
          git(root, ['merge-base', '--is-ancestor', lastWorkflowCommit, tagCommit]);
          hasCurrentWorkflow = true;
        } catch {
          hasCurrentWorkflow = false;
        }
      }
      tags.push({ tag, onMain, hasCurrentWorkflow });
    }
    return { ...evaluateTags(tags, { currentTag }), tags, lastWorkflowCommit };
  } catch (e) {
    return {
      ok: false,
      orphaned: [],
      stale: null,
      tags: [],
      error: String(e.stderr || e.message || e),
    };
  }
}

// ---- CLI ----------------------------------------------------------------

// Run as a CLI (node scripts/check-release-tag-hygiene.mjs [--strict] [root])
// — the pure core is imported by the tests, so guard on the real file path
// rather than argv[1] (unset when the module is imported).
if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const [root = process.cwd()] = args.filter((a) => a !== '--strict');
  const result = checkRepo(root);
  if (result.error) {
    console.error(`FAIL: could not evaluate release tags: ${result.error}`);
    process.exit(2);
  }
  if (result.tags.length === 0) {
    console.log('OK: no b* release tags to check.');
    process.exit(0);
  }
  for (const t of result.tags) {
    let state = 'ok';
    if (t.onMain !== true) state = 'ORPHANED';
    else if (t.tag === result.stale) state = 'STALE';
    console.log(`${state}: ${t.tag}${t.onMain === false ? ' (commit not reachable from origin/main)' : ''}`);
  }
  if (result.stale && !strict) {
    console.log('');
    console.log(`WARN: ${result.stale} predates the current ${WORKFLOW} (last changed at ${String(result.lastWorkflowCommit).slice(0, 7)}); re-running this tag would execute the old pipeline.`);
    console.log('Re-point it before the next release re-run (see README "Releasing", tag discipline). Not fatal in CI — staleness is the normal state between a workflow change and the tag re-point.');
    process.exit(0);
  }
  if (!result.ok) {
    console.error('');
    if (result.orphaned.length > 0) {
      console.error(`FAIL: ${result.orphaned.length} release tag(s) do not point at a commit reachable from origin/main:`);
      for (const t of result.orphaned) console.error(`  ${t}`);
    }
    if (result.stale) {
      console.error(`FAIL (--strict): ${result.stale} predates the current ${WORKFLOW} (last changed at ${String(result.lastWorkflowCommit).slice(0, 7)}); re-running this tag would execute the old pipeline.`);
    }
    console.error('');
    console.error('GitHub Actions checks out the workflow from the ref being run, so a bad tag re-push runs bad code (issue #67).');
    console.error('Fix: re-point the tag to a main commit at/after the last workflow change:');
    console.error('  git tag -f <tag> origin/main && git push -f origin <tag>');
    console.error('See the README "Releasing" section (tag discipline).');
    process.exit(1);
  }
  console.log(`OK: ${result.tags.length} release tag(s) healthy.`);
  process.exit(0);
}
