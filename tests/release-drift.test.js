// Unit tests for scripts/check-release-drift.mjs (issue #186): the
// decision core that keeps the manifest version and the GitHub releases
// in sync, so "main is ahead of the newest release" (#54) cannot silently
// accumulate again.
//
// Only the pure classification is unit-tested in-process; the manifest +
// `gh` layer is exercised for real by the CLI tests below, which drive the
// entrypoint as a subprocess against a fixture tree — the same shape
// tests/node-engines-ci.test.js uses for check-node-engines.mjs — because
// that is the code path CI's validate job invokes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateReleaseDrift,
  checkReleaseDrift,
} from '../scripts/check-release-drift.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-release-drift.mjs');

const rel = (tagName, publishedAt, extra = {}) => ({
  tagName,
  publishedAt,
  isDraft: false,
  isPrerelease: false,
  ...extra,
});

// ---- pure core ----------------------------------------------------------

test('evaluateReleaseDrift: a full release for the manifest version is in sync', () => {
  const r = evaluateReleaseDrift('1.0.3', [
    rel('b1.0.2', '2026-01-01T00:00:00Z'),
    rel('b1.0.3', '2026-02-01T00:00:00Z'),
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'in-sync');
  assert.equal(r.expectedTag, 'b1.0.3');
  assert.equal(r.current.tagName, 'b1.0.3');
  assert.equal(r.newest, null);
});

test('evaluateReleaseDrift: a malformed manifest version cannot derive a tag', () => {
  for (const bad of ['1.0', 'v1.0.3', '', '1.0.3.4', '1.0.x', '1.0.3-beta']) {
    const r = evaluateReleaseDrift(bad, [rel('b1.0.3', '2026-02-01T00:00:00Z')]);
    assert.equal(r.ok, false, bad);
    assert.equal(r.reason, 'bad-version', bad);
    assert.equal(r.expectedTag, null, bad);
  }
});

test('evaluateReleaseDrift: no release for the version is drift, newest by date', () => {
  // Newest first in the list on purpose: the sort must use publishedAt,
  // not list order.
  const r = evaluateReleaseDrift('1.0.3', [
    rel('b1.0.2', '2026-02-01T00:00:00Z'),
    rel('b1.0.1', '2026-01-01T00:00:00Z'),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'drift');
  assert.equal(r.expectedTag, 'b1.0.3');
  assert.equal(r.current, null);
  assert.equal(r.newest.tagName, 'b1.0.2');
});

test('evaluateReleaseDrift: an empty release list is drift with no newest', () => {
  const r = evaluateReleaseDrift('1.0.3', []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'drift');
  assert.equal(r.newest, null);
});

test('evaluateReleaseDrift: a draft with the expected tag does not satisfy it', () => {
  const r = evaluateReleaseDrift('1.0.3', [
    rel('b1.0.3', '2026-02-01T00:00:00Z', { isDraft: true }),
    rel('b1.0.2', '2026-01-01T00:00:00Z'),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'drift');
  assert.equal(r.current, null);
  assert.equal(r.newest.tagName, 'b1.0.2');
});

test('evaluateReleaseDrift: a prerelease with the expected tag does not satisfy it', () => {
  const r = evaluateReleaseDrift('1.0.3', [
    rel('b1.0.3', '2026-02-01T00:00:00Z', { isPrerelease: true }),
    rel('b1.0.2', '2026-01-01T00:00:00Z'),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'drift');
  assert.equal(r.current, null);
  // The prerelease is not the newest published release either.
  assert.equal(r.newest.tagName, 'b1.0.2');
});

test('evaluateReleaseDrift: drafts and prereleases never count as newest', () => {
  const r = evaluateReleaseDrift('1.0.3', [
    rel('b1.0.3-draft', '2026-03-01T00:00:00Z', { isDraft: true }),
    rel('b1.0.4-rc', '2026-02-15T00:00:00Z', { isPrerelease: true }),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'drift');
  assert.equal(r.newest, null);
});

// ---- CLI end-to-end (fixture tree + fake gh) ---------------------------

// Build a fixture repo with the real script plus a manifest.json and a
// fake `gh` on PATH; running the fixture script then reads the fixture,
// not the real repo, and never touches the network.
function makeFixture({ version, gh }) {
  const base = mkdtempSync(path.join(tmpdir(), 'release-drift-ci-'));
  mkdirSync(path.join(base, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, path.join(base, 'scripts', 'check-release-drift.mjs'));
  const manifestDir = path.join(base, 'QueryHop Extension', 'Resources');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    path.join(manifestDir, 'manifest.json'),
    JSON.stringify({ name: 'fixture', version }, null, 2)
  );
  const binDir = path.join(base, 'bin');
  mkdirSync(binDir, { recursive: true });
  const ghPath = path.join(binDir, 'gh');
  writeFileSync(ghPath, gh);
  chmodSync(ghPath, 0o755);
  return { base, script: path.join(base, 'scripts', 'check-release-drift.mjs'), binDir };
}

// A fake `gh release list` that prints canned JSON (or fails, for the
// tooling-error path). The marker variant records whether it was called.
const ghJson = (releases) =>
  `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(releases)}\nEOF\n`;
const ghFailing = `#!/bin/sh\nexit 1\n`;
const ghMarker = (marker) =>
  `#!/bin/sh\necho called > ${JSON.stringify(marker)}\nexit 0\n`;

// Run the fixture's script as a subprocess; return { code, out, err }.
function runFixture(script, binDir) {
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  // The outer runner sets NODE_TEST_CONTEXT for its child processes; the
  // nested `node` run must not inherit it, or it goes silent.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_NAME;
  delete env.NODE_TEST_IS_CHILD;
  try {
    const out = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}

test('CLI: exits 0 when a full release exists for the manifest version', () => {
  const fx = makeFixture({
    version: '1.0.3',
    gh: ghJson([rel('b1.0.2', '2026-01-01T00:00:00Z'), rel('b1.0.3', '2026-02-01T00:00:00Z')]),
  });
  try {
    const r = runFixture(fx.script, fx.binDir);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /OK: release b1\.0\.3 exists/);
    assert.match(r.out, /matches manifest version 1\.0\.3/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('CLI: exits 1 with the newest release named when the version has no release', () => {
  const fx = makeFixture({
    version: '1.0.3',
    gh: ghJson([rel('b1.0.2', '2026-01-01T00:00:00Z')]),
  });
  try {
    const r = runFixture(fx.script, fx.binDir);
    assert.equal(r.code, 1);
    assert.match(r.err, /no GitHub release for manifest version 1\.0\.3 \(expected tag b1\.0\.3\)/);
    assert.match(r.err, /Newest published release: b1\.0\.2/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('CLI: a bad manifest version exits 1 before ever calling gh', () => {
  const fx = makeFixture({ version: '1.0', gh: '' });
  const marker = path.join(fx.base, 'gh-called');
  // Rewrite the fake gh after the fixture exists so it can record a call.
  writeFileSync(path.join(fx.binDir, 'gh'), ghMarker(marker));
  chmodSync(path.join(fx.binDir, 'gh'), 0o755);
  try {
    const r = runFixture(fx.script, fx.binDir);
    assert.equal(r.code, 1);
    assert.match(r.err, /not three-part semver/);
    assert.equal(existsSync(marker), false, 'gh must not be called for a bad version');
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('CLI: a gh failure exits 2 (tooling problem, not drift)', () => {
  const fx = makeFixture({ version: '1.0.3', gh: ghFailing });
  try {
    const r = runFixture(fx.script, fx.binDir);
    assert.equal(r.code, 2);
    assert.match(r.err, /could not list GitHub releases via gh/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('CLI: a prerelease alone does not satisfy the expected tag', () => {
  const fx = makeFixture({
    version: '1.0.3',
    gh: ghJson([
      rel('b1.0.3', '2026-02-01T00:00:00Z', { isPrerelease: true }),
      rel('b1.0.2', '2026-01-01T00:00:00Z'),
    ]),
  });
  try {
    const r = runFixture(fx.script, fx.binDir);
    assert.equal(r.code, 1);
    assert.match(r.err, /expected tag b1\.0\.3/);
    assert.match(r.err, /Newest published release: b1\.0\.2/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('checkReleaseDrift: the imported layer reports the same result without exiting', () => {
  // Same fixture shape, but through the imported function: a manifest
  // version with no matching release is drift, not a process exit.
  const fx = makeFixture({
    version: '1.0.3',
    gh: ghJson([rel('b1.0.2', '2026-01-01T00:00:00Z')]),
  });
  const origPath = process.env.PATH;
  process.env.PATH = `${fx.binDir}:${origPath}`;
  try {
    const r = checkReleaseDrift(fx.base);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'drift');
    assert.equal(r.version, '1.0.3');
    assert.equal(r.expectedTag, 'b1.0.3');
    assert.equal(r.newest.tagName, 'b1.0.2');
  } finally {
    process.env.PATH = origPath;
    rmSync(fx.base, { recursive: true, force: true });
  }
});
