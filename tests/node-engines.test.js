// Unit tests for scripts/check-node-engines.mjs (issue #115): the Node
// contract guard. The decision core (range parsing, the decidable-only
// posture, the pin-vs-range math, and the workflow-pin extraction) is pure
// and exercised without touching the filesystem or the real package.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNodeVersion,
  parseNodeRange,
  versionInRange,
  pinSatisfiesRange,
  checkEngines,
  workflowNodePins,
} from '../scripts/check-node-engines.mjs';

// ---------------------------------------------------------------------------
// parseNodeVersion
// ---------------------------------------------------------------------------
test('parseNodeVersion: major / minor / patch, missing components become 0', () => {
  assert.deepEqual(parseNodeVersion('22'), [22, 0, 0]);
  assert.deepEqual(parseNodeVersion('22.1'), [22, 1, 0]);
  assert.deepEqual(parseNodeVersion('22.23.1'), [22, 23, 1]);
});

test('parseNodeVersion: rejects non-versions and junk', () => {
  assert.equal(parseNodeVersion(''), null);
  assert.equal(parseNodeVersion('latest'), null);
  assert.equal(parseNodeVersion('22.x'), null);
  assert.equal(parseNodeVersion('v22'), null, 'the v prefix is stripped by callers, not here');
  assert.equal(parseNodeVersion('22.1.2.3'), null, 'no fourth component');
  assert.equal(parseNodeVersion('22..1'), null);
  assert.equal(parseNodeVersion('abc'), null);
});

// ---------------------------------------------------------------------------
// parseNodeRange — only ">=A <B" is decidable
// ---------------------------------------------------------------------------
test('parseNodeRange: accepts exactly the ">=A <B" form', () => {
  const r = parseNodeRange('>=22 <23');
  assert.ok(r);
  assert.deepEqual(r.lo, [22, 0, 0]);
  assert.deepEqual(r.hi, [23, 0, 0]);
});

test('parseNodeRange: fails closed on any undecidable form', () => {
  // The whole point of the guard: it will not guess at a range it cannot
  // decide on, matching check-release-tag-hygiene.mjs's undecidable posture.
  assert.equal(parseNodeRange(''), null);
  assert.equal(parseNodeRange('22'), null, 'bare version, no bounds');
  assert.equal(parseNodeRange('>=22'), null, 'open upper bound');
  assert.equal(parseNodeRange('<23'), null, 'open lower bound');
  assert.equal(parseNodeRange('^22'), null);
  assert.equal(parseNodeRange('>=22 <23 <24'), null, 'too many comparators');
  assert.equal(parseNodeRange('>=22 <=23'), null, '<= is not the decidable form');
  assert.equal(parseNodeRange('>= 22 < 23'), null, 'whitespace inside a comparator');
  assert.equal(parseNodeRange('latest'), null);
});

// ---------------------------------------------------------------------------
// versionInRange — inclusive lower, exclusive upper
// ---------------------------------------------------------------------------
test('versionInRange: inclusive lower, exclusive upper', () => {
  const range = parseNodeRange('>=22 <23');
  assert.equal(versionInRange([21, 9, 9], range), false, 'just below the floor');
  assert.equal(versionInRange([22, 0, 0], range), true, 'exactly the floor is in');
  assert.equal(versionInRange([22, 23, 1], range), true, 'a minor/patch inside');
  assert.equal(versionInRange([23, 0, 0], range), false, 'exactly the ceiling is out');
  assert.equal(versionInRange([24, 0, 0], range), false, 'above the ceiling');
});

// ---------------------------------------------------------------------------
// pinSatisfiesRange — full pin vs major-line pin
// ---------------------------------------------------------------------------
test('pinSatisfiesRange: a full version pin must land inside the range', () => {
  const range = parseNodeRange('>=22 <23');
  assert.equal(pinSatisfiesRange('22.23.1', range), true);
  assert.equal(pinSatisfiesRange('22.0.0', range), true);
  assert.equal(pinSatisfiesRange('23.0.0', range), false, 'past the ceiling');
  assert.equal(pinSatisfiesRange('21.9.9', range), false, 'below the floor');
});

test('pinSatisfiesRange: a major-line pin floats and is judged by its line bounds', () => {
  // A bare "22" floats across all of 22.x. It is inside ">=22 <23" because
  // its floor 22.0.0 >= the range floor and its ceiling 23.0.0 <= the range
  // ceiling.
  assert.equal(pinSatisfiesRange('22', parseNodeRange('>=22 <23')), true);
  // A 22 line is NOT inside a narrower range that starts at 22.5: the line
  // floor 22.0.0 is below the range floor, so part of the float is out.
  assert.equal(pinSatisfiesRange('22', parseNodeRange('>=22.5 <23')), false);
  // A 23 line floats past a range that stops at 23.
  assert.equal(pinSatisfiesRange('23', parseNodeRange('>=22 <23')), false);
});

// ---------------------------------------------------------------------------
// checkEngines — the whole decision
// ---------------------------------------------------------------------------
test('checkEngines: passes when the contract is declared, in-range, and pins agree', () => {
  const pkg = { engines: { node: '>=22 <23' } };
  const res = checkEngines(pkg, {
    pins: [{ workflow: 'ci.yml', pin: '22' }],
    running: 'v22.23.1',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test('checkEngines: fails when the contract is missing entirely', () => {
  assert.equal(checkEngines({}).ok, false);
  assert.equal(checkEngines({ engines: {} }).ok, false);
  assert.equal(checkEngines({ engines: { node: '' } }).ok, false);
});

test('checkEngines: fails closed on an undecidable range', () => {
  const res = checkEngines({ engines: { node: '^22' } });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /fails closed/);
});

test('checkEngines: rejects a running version outside the range', () => {
  const pkg = { engines: { node: '>=22 <23' } };
  const res = checkEngines(pkg, { running: 'v21.7.0' });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /running Node/);
  // A running version at exactly the ceiling is also out (exclusive upper).
  const res2 = checkEngines(pkg, { running: '23.0.0' });
  assert.equal(res2.ok, false);
});

test('checkEngines: rejects a workflow pin that falls outside the range', () => {
  const pkg = { engines: { node: '>=22 <23' } };
  const res = checkEngines(pkg, {
    pins: [{ workflow: 'ci.yml', pin: '20' }, { workflow: 'release.yml', pin: '22' }],
    running: 'v22.23.1',
  });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /ci\.yml/);
  assert.match(res.errors[0], /node-version 20/);
  assert.equal(res.errors.length, 1, 'the good pin is not flagged');
});

test('checkEngines: the running version is optional (null skips that check)', () => {
  const pkg = { engines: { node: '>=22 <23' } };
  const res = checkEngines(pkg, { pins: [{ workflow: 'ci.yml', pin: '22' }] });
  assert.equal(res.ok, true);
});

// ---------------------------------------------------------------------------
// workflowNodePins — YAML extraction
// ---------------------------------------------------------------------------
test('workflowNodePins: extracts every node-version pin, in order', () => {
  const text = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    '  b:',
    '    steps:',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: "22.23.1"',
    '          # a comment pin is not a pin',
    '          node-version: 20',
  ].join('\n');
  assert.deepEqual(workflowNodePins(text), ['22', '22.23.1', '20']);
});

test('workflowNodePins: ignores non-pinning lines and empty input', () => {
  assert.deepEqual(workflowNodePins(''), []);
  assert.deepEqual(workflowNodePins('name: CI\non: push\n'), []);
});
