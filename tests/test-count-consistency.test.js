// Drift guard (issue #48): the Testing section of README.md states how many
// tests the suite has ("The suite is N tests across M files"). That number
// rotted silently after PR #47 added 5 tests without touching the README, so
// it is now recomputed on every run: this test spawns the rest of the suite
// (every other tests/*.test.js file) with the same runner CI uses and fails
// if the README's stated count no longer matches reality.
//
// The README's count describes the WHOLE suite, i.e. this file's own single
// test plus everything it re-runs — hence the +1 on both axes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the README test count matches the real suite (\\#48)', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const declared = readme.match(/The suite is (\d+) tests across (\d+) files/);
  assert.ok(
    declared,
    'README Testing section must state "The suite is N tests across M files"'
  );
  const declaredTests = Number(declared[1]);
  const declaredFiles = Number(declared[2]);

  const allFiles = readdirSync(path.join(root, 'tests')).filter(
    (f) => f.endsWith('.test.js')
  );
  const otherFiles = allFiles.filter((f) => f !== path.basename(fileURLToPath(import.meta.url)));

  // Re-run the suite minus this guard, exactly like CI's `test` job does.
  // If any of those tests fail, execFileSync throws and this guard fails too
  // — a broken suite must never be able to certify its own count.
  // The outer runner sets NODE_TEST_CONTEXT for its child processes; the
  // nested `node --test` must run without it, or it goes silent.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_NAME;
  delete env.NODE_TEST_IS_CHILD;
  const out = execFileSync(
    process.execPath,
    ['--test', ...otherFiles.map((f) => path.join('tests', f))],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }
  );
  const pass = out.match(/^# pass (\d+)$/m);
  assert.ok(pass, 'could not find the TAP pass count in the nested run');

  assert.equal(
    Number(pass[1]) + 1,
    declaredTests,
    `README says "${declaredTests} tests" but the suite actually has ` +
      `${Number(pass[1]) + 1} (${pass[1]} in the other test files + this guard). ` +
      `Update the Testing section of README.md.`
  );
  assert.equal(
    otherFiles.length + 1,
    declaredFiles,
    `README says "${declaredFiles} files" but the suite actually spans ` +
      `${otherFiles.length + 1} tests/*.test.js files. ` +
      `Update the Testing section of README.md.`
  );
});
