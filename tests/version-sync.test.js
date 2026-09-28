// Drift guard (issue #49): the release version lives in two places —
// "version" in QueryHop Extension/Resources/manifest.json and
// MARKETING_VERSION in QueryHop.xcodeproj/project.pbxproj (one entry per
// build configuration across the app + extension targets). They used to
// rot independently (manifest said 1.0 while the live App Store listing
// was 1.0-2). This guard fails if the two disagree, if the manifest
// version is not three-part semver, or if some pbxproj config still
// carries a stale value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(
  readFileSync(path.join(root, 'QueryHop Extension/Resources/manifest.json'), 'utf8')
);
const pbxproj = readFileSync(path.join(root, 'QueryHop.xcodeproj/project.pbxproj'), 'utf8');

test('manifest version is three-part semver (\\#49)', () => {
  assert.match(
    manifest.version,
    /^\d+\.\d+\.\d+$/,
    `manifest.json "version" must be MAJOR.MINOR.PATCH, got "${manifest.version}" ` +
      '(the App Store review requires a full semver higher than the live listing)'
  );
});

test('every MARKETING_VERSION in project.pbxproj matches manifest.json (\\#49)', () => {
  const versions = [...pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(versions.length >= 3, `expected at least 3 MARKETING_VERSION entries, found ${versions.length}`);
  for (const v of versions) {
    assert.equal(
      v,
      manifest.version,
      `project.pbxproj has MARKETING_VERSION = ${v} but manifest.json has version ${manifest.version} — bump both in one commit (see README → Releasing)`
    );
  }
});
