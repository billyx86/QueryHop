// Integration tests for scripts/check-node-engines.mjs (issue #115): the
// CLI path CI actually runs. The unit suite (node-engines.test.js) covers
// the pure decision core in-process; these drive the real entrypoint as a
// subprocess against a fixture tree, because that is the code path the
// validate job invokes — it reads package.json, walks .github/workflows for
// node-version pins, and reports a pass/fail exit code. The script resolves
// its root relative to its own location (.. from scripts/), so the fixture
// copies the script into a temp scripts/ dir next to a fake package.json and
// workflow set; running it then reads the fixture, not the real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-node-engines.mjs');

// Build a fixture repo with the real script plus a package.json and a set
// of workflow files, returning the path to the fixture's script.
function makeFixture({ engines, workflows }) {
  const base = mkdtempSync(path.join(tmpdir(), 'node-engines-ci-'));
  mkdirSync(path.join(base, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, path.join(base, 'scripts', 'check-node-engines.mjs'));
  writeFileSync(
    path.join(base, 'package.json'),
    JSON.stringify(
      engines === null
        ? { name: 'fixture' }
        : { name: 'fixture', engines: { node: engines } },
      null,
      2
    )
  );
  if (workflows) {
    const wfDir = path.join(base, '.github', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    for (const [name, text] of Object.entries(workflows)) {
      writeFileSync(path.join(wfDir, name), text);
    }
  }
  return { base, script: path.join(base, 'scripts', 'check-node-engines.mjs') };
}

// Run the fixture's script as a subprocess; return { code, out, err }.
function runFixture(script) {
  try {
    const out = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}

const TWO_JOBS = {
  'a.yml': 'jobs:\n  x:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n',
  'b.yml': 'jobs:\n  y:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22.23.1\n',
};

test('the guard passes end-to-end on a compliant fixture', () => {
  const fx = makeFixture({ engines: '>=22 <23', workflows: TWO_JOBS });
  try {
    const r = runFixture(fx.script);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /node contract: OK/);
    // Both workflow files are discovered and reported.
    assert.match(r.out, /\.github\/workflows\/a\.yml/);
    assert.match(r.out, /\.github\/workflows\/b\.yml/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the guard fails end-to-end when the contract is missing', () => {
  const fx = makeFixture({ engines: null, workflows: TWO_JOBS });
  try {
    const r = runFixture(fx.script);
    assert.equal(r.code, 1);
    assert.match(r.err, /no engines\.node contract/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the guard fails end-to-end on a workflow pin outside the range', () => {
  const fx = makeFixture({
    engines: '>=22 <23',
    workflows: { 'bad.yml': 'jobs:\n  x:\n    steps:\n      - with:\n          node-version: 20\n' },
  });
  try {
    const r = runFixture(fx.script);
    assert.equal(r.code, 1);
    assert.match(r.err, /bad\.yml/);
    assert.match(r.err, /node-version 20/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the guard fails closed end-to-end on an undecidable range', () => {
  const fx = makeFixture({ engines: '^22', workflows: TWO_JOBS });
  try {
    const r = runFixture(fx.script);
    assert.equal(r.code, 1);
    assert.match(r.err, /fails closed/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the guard tolerates a fixture with no workflows directory', () => {
  const fx = makeFixture({ engines: '>=22 <23', workflows: null });
  try {
    const r = runFixture(fx.script);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /node contract: OK/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("the real repo's own contract is self-consistent (meta)", () => {
  // The guard's job is to protect THIS repo, so the real entrypoint run
  // against the real tree must pass — a self-check that the committed
  // contract and pins actually agree, not just that the fixture logic does.
  const r = (() => {
    try {
      const out = execFileSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, err: '' };
    } catch (e) {
      return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
    }
  })();
  assert.equal(r.code, 0, `real repo guard failed: ${r.err}`);
  assert.match(r.out, /node contract: OK/);
  // And the committed engines range is the one this test suite pins to.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=22 <23');
});
