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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(
  readFileSync(path.join(root, 'QueryHop Extension/Resources/manifest.json'), 'utf8')
);
const version = manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`FAIL: manifest.json version "${version}" is not three-part semver; cannot derive the release tag.`);
  process.exit(1);
}

const expectedTag = `b${version}`;

let releases;
try {
  releases = JSON.parse(execFileSync('gh', [
    'release', 'list', '--limit', '25',
    '--json', 'tagName,publishedAt,isDraft,isPrerelease',
  ], { encoding: 'utf8' }));
} catch (error) {
  console.error(`FAIL: could not list GitHub releases via gh: ${error.message || error}`);
  console.error('       (is gh installed and authenticated?)');
  process.exit(2);
}

const published = releases.filter((r) => !r.isDraft);
const current = published.find((r) => r.tagName === expectedTag);

if (current) {
  console.log(`OK: release ${expectedTag} exists (published ${current.publishedAt}); matches manifest version ${version}.`);
  process.exit(0);
}

const newest = [...published].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))[0];
const newestDesc = newest ? `${newest.tagName} (published ${newest.publishedAt})` : 'none';
console.error(`FAIL: no GitHub release for manifest version ${version} (expected tag ${expectedTag}).`);
console.error(`       Newest published release: ${newestDesc}.`);
console.error(`       Cut it per the README "Releasing" section: git tag ${expectedTag}, push it, then create/upload the release.`);
process.exit(1);
