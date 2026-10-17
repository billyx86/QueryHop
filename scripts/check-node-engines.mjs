#!/usr/bin/env node
//
// check-node-engines.mjs
//
// The Node contract guard (issue #115). package.json declares the Node
// versions the repo's JavaScript (test suite, scripts, CI steps) is
// guaranteed to run on, and CI pins the version it actually runs. This
// guard closes the loop between the two: it fails when the contract is
// missing or malformed, when the running Node falls outside it, or when
// a workflow's node-version pin falls outside it — the same
// "pin the gate, range the rest" convention the repo already applies to
// Chrome (issue #108) and ruff.
//
// It is deliberately conservative: the only range form it can decide on
// is exactly `>=A <B` (inclusive lower, exclusive upper, versions of 1–3
// components). Anything else — `^22`, `latest`, `>=22`, a third
// comparator — is undecidable here and fails closed, the same posture
// check-release-tag-hygiene.mjs takes for an undecidable tag.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Parse a version like "22", "22.1", or "22.23.1" into a numeric
// [major, minor, patch] triple (missing components are 0). null when the
// input is not a version.
export function parseNodeVersion(input) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(input).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Parse the supported range form `>=A <B` into { lo, hi } (both version
// triples). null for anything it cannot decide on — callers fail closed.
export function parseNodeRange(range) {
  const tokens = String(range).trim().split(/\s+/);
  if (tokens.length !== 2) return null;
  const lo = /^>(=\d.*)?$/.test(tokens[0]) ? tokens[0].slice(2) : null;
  const hi = /^<\d.*$/.test(tokens[1]) ? tokens[1].slice(1) : null;
  if (tokens[0][0] !== '>' || tokens[0][1] !== '=' || tokens[1][0] !== '<') return null;
  const a = lo === null ? null : parseNodeVersion(lo);
  const b = hi === null ? null : parseNodeVersion(hi);
  if (!a || !b) return null;
  return { lo: a, hi: b };
}

// Inclusive lower, exclusive upper: lo <= v < hi.
export function versionInRange(version, range) {
  if (!Array.isArray(version) || !range) return false;
  return compareVersions(version, range.lo) >= 0 && compareVersions(version, range.hi) < 0;
}

// A workflow `node-version` pin can be a full version ("22.23.1") or a
// major line ("22"). A full pin must fall inside the range. A major-line
// pin floats across that whole major, so it is inside the range only when
// the line's floor (N.0.0) is at/above the range's floor and the line's
// ceiling (N+1.0.0, exclusive) is at/below the range's ceiling.
export function pinSatisfiesRange(pin, range) {
  const v = parseNodeVersion(pin);
  if (!v) return false;
  if (pin.trim().split('.').length === 1) {
    const floor = v;
    const ceiling = [v[0] + 1, 0, 0];
    return compareVersions(floor, range.lo) >= 0 && compareVersions(ceiling, range.hi) <= 0;
  }
  return versionInRange(v, range);
}

// The decision core, pure: takes the parsed package.json plus, optionally,
// a list of { workflow, pin } pairs and a running version to validate
// against. Returns { ok, errors }.
export function checkEngines(pkg, { pins = [], running = null } = {}) {
  const errors = [];
  const nodeRange = pkg && pkg.engines && typeof pkg.engines.node === 'string'
    ? pkg.engines.node
    : null;
  if (nodeRange === null || nodeRange.trim() === '') {
    errors.push('package.json declares no engines.node contract');
    return { ok: false, errors };
  }
  const range = parseNodeRange(nodeRange);
  if (!range) {
    errors.push(
      `engines.node "${nodeRange}" is not in the decidable form ">=A <B"; ` +
      'the guard fails closed rather than guess'
    );
    return { ok: false, errors };
  }
  if (running !== null) {
    const v = parseNodeVersion(String(running).replace(/^v/, ''));
    if (!v) {
      errors.push(`could not parse the running Node version "${running}"`);
    } else if (!versionInRange(v, range)) {
      errors.push(`the running Node ${running} is outside the declared range ${nodeRange}`);
    }
  }
  for (const { workflow, pin } of pins) {
    if (!pinSatisfiesRange(pin, range)) {
      errors.push(`${workflow} pins node-version ${pin}, which falls outside the declared range ${nodeRange}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Extract every `node-version: X` pin from workflow text (YAML), in
// order of appearance.
export function workflowNodePins(workflowText) {
  const pins = [];
  for (const line of String(workflowText).split('\n')) {
    const m = /^\s*node-version:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (m) pins.push(m[1]);
  }
  return pins;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const range = parseNodeRange(pkg.engines && pkg.engines.node ? pkg.engines.node : '');
  const wfDir = path.join(ROOT, '.github', 'workflows');
  const pins = [];
  // Tolerate a missing workflows dir (the guard's job is the contract, not
  // the presence of CI): no pins, not a crash.
  const wfFiles = existsSync(wfDir)
    ? readdirSync(wfDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort()
    : [];
  for (const name of wfFiles) {
    const text = readFileSync(path.join(wfDir, name), 'utf8');
    for (const pin of workflowNodePins(text)) {
      pins.push({ workflow: `.github/workflows/${name}`, pin });
    }
  }
  const result = checkEngines(pkg, { pins, running: process.version });
  const runningOk = parseNodeRange(pkg.engines && pkg.engines.node ? pkg.engines.node : '')
    && versionInRange(parseNodeVersion(String(process.version).replace(/^v/, '')), parseNodeRange(pkg.engines && pkg.engines.node ? pkg.engines.node : ''));
  if (!range) {
    const declared = pkg.engines && pkg.engines.node ? JSON.stringify(pkg.engines.node) : '(none)';
    console.log(`node contract: package.json declares engines.node = ${declared}`);
  } else {
    console.log(
      `node contract: engines.node = ${pkg.engines.node}; running Node ${process.version} ` +
      `${runningOk ? 'is in range' : 'is OUT of range'}`
    );
  }
  for (const { workflow, pin } of pins) {
    console.log(`  ${workflow}: node-version ${pin}`);
  }
  if (result.ok) {
    console.log('node contract: OK');
  } else {
    for (const e of result.errors) console.error(`node contract: FAIL — ${e}`);
    process.exit(1);
  }
}
