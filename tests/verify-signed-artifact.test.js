// Unit tests for scripts/verify-signed-artifact.mjs (issue #68): the
// pure decision logic behind the signed/unsigned release verification
// gate. The `codesign -d -v --verbose=4` fixtures are verbatim captures
// from a real macOS 14 machine (Xcode 15, Universal app build) recorded
// while investigating issue #68 — a Developer ID signed app, an ad-hoc
// thin slice, and the unsigned-object failure output. The macOS-only
// orchestration (verifyArtifact) is not exercised here; it is a thin
// wrapper over this tested logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseCodesignDv,
  classifySignature,
  gateExpectations,
} from '../scripts/verify-signed-artifact.mjs';

// Absolute path to the script, so the CLI regression tests below can run it
// as a child process (the only way to reach the CLI block, which is guarded
// off when the module is merely imported).
const SCRIPT = fileURLToPath(new URL('../scripts/verify-signed-artifact.mjs', import.meta.url));

function runCli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

// Verbatim `codesign -d -v --verbose=4` output for a Developer ID
// signed, hardened-runtime universal app (captured 2026-09-29).
const DEV_ID_DV = `Executable=/Users/runner/work/QueryHop/QueryHop/build/DerivedData/Build/Products/Release/QueryHop.app/Contents/MacOS/QueryHop
Identifier=com.billyking.QueryHop
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=222076 flags=0x10000(runtime) Hash type=sha256 size=32
Authority=Developer ID Application: Billy King (QHX23VWXYZ)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=QHX23VWXYZ
Sealed Resources version=2 rules=13 files=42`;

// Verbatim output for an ad-hoc signed thin arm64 slice.
const ADHOC_DV = `Executable=/tmp/thin-arm64
Identifier=com.billyking.QueryHop
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=222076 flags=0x2(runtime) Hash type=sha256 size=32
Signature=ad-hoc
Info.plist=not bound
TeamIdentifier=`;

// Verbatim failure output when the object is not signed at all
// (codesign exits 1, no field output on stdout).
const UNSIGNED_DV = `: code object is not signed at all`;

test('parseCodesignDv extracts the Developer ID fields', () => {
  const p = parseCodesignDv(DEV_ID_DV);
  assert.equal(p.identifier, 'com.billyking.QueryHop');
  assert.equal(p.format, 'app bundle with Mach-O universal (x86_64 arm64)');
  assert.equal(p.teamIdentifier, 'QHX23VWXYZ');
  assert.equal(p.authorities.length, 3);
  assert.equal(p.authorities[0], 'Developer ID Application: Billy King (QHX23VWXYZ)');
  assert.equal(p.hardenedRuntime, true);
});

test('parseCodesignDv handles the ad-hoc slice', () => {
  const p = parseCodesignDv(ADHOC_DV);
  assert.equal(p.format, 'Mach-O thin (arm64)');
  assert.equal(p.signature, 'ad-hoc');
  // The empty "TeamIdentifier=" line must parse to null, not "".
  assert.equal(p.teamIdentifier, null);
  assert.equal(p.authorities.length, 0);
  assert.equal(p.hardenedRuntime, true); // flags=0x2(runtime)
});

test('parseCodesignDv on garbage yields empty fields, no crash', () => {
  const p = parseCodesignDv(UNSIGNED_DV);
  assert.equal(p.executable, null);
  assert.equal(p.authorities.length, 0);
  assert.equal(p.hardenedRuntime, false);
});

test('classifySignature: Developer ID application with signer + team id', () => {
  const cls = classifySignature(parseCodesignDv(DEV_ID_DV), 0);
  assert.equal(cls.kind, 'developer-id');
  assert.equal(cls.signer, 'Billy King');
  assert.equal(cls.teamId, 'QHX23VWXYZ');
  assert.equal(cls.hardenedRuntime, true);
});

test('classifySignature: ad-hoc', () => {
  assert.equal(classifySignature(parseCodesignDv(ADHOC_DV), 0).kind, 'ad-hoc');
});

test('classifySignature: codesign nonzero exit means unsigned', () => {
  assert.equal(classifySignature(parseCodesignDv(UNSIGNED_DV), 1).kind, 'unsigned');
  assert.equal(classifySignature(null, 1).kind, 'unsigned');
});

test('classifySignature: non-Developer ID certificate is "other"', () => {
  const out = ADHOC_DV.replace('Signature=ad-hoc',
    'Authority=Apple Development: Billy King (QHX23VWXYZ)\nSignature=adhoc');
  const cls = classifySignature(parseCodesignDv(out), 0);
  assert.equal(cls.kind, 'other');
});

test('gateExpectations: signed mode pins the full chain', () => {
  const e = gateExpectations('signed', { expectedTeamId: 'QHX23VWXYZ' });
  assert.equal(e.mode, 'signed');
  assert.equal(e.signatureKind, 'developer-id');
  assert.equal(e.teamId, 'QHX23VWXYZ');
  assert.equal(e.hardenedRuntime, true);
  assert.equal(e.requireDeepStrictVerify, true);
  assert.equal(e.requireStaplerValidate, true);
});

test('gateExpectations: signed mode without team pin accepts any Developer ID team', () => {
  const e = gateExpectations('signed');
  assert.equal(e.teamId, null);
  assert.equal(e.signatureKind, 'developer-id');
});

test('gateExpectations: unsigned fallback only requires an ad-hoc arm64 slice', () => {
  const e = gateExpectations('unsigned');
  assert.equal(e.mode, 'unsigned');
  assert.equal(e.arm64SliceKind, 'ad-hoc');
  // The x86_64 slice is unsigned in fallback mode, so a deep-strict
  // verify would fail by design — it must not be required.
  assert.equal(e.requireDeepStrictVerify, false);
  assert.equal(e.requireStaplerValidate, false);
});

test('gateExpectations: unknown mode throws', () => {
  assert.throws(() => gateExpectations('banana'));
});

// ---- CLI entry-point regression tests (run the script as a child process) ----
//
// The block below the `import.meta.url` guard only runs when the script is
// executed directly (`node scripts/verify-signed-artifact.mjs ...`), never
// when it is imported — which is exactly how the unit tests above reach it.
// A bug that only lives in that CLI block (e.g. the destructuring
// `({ zipPath, opts } = parseArgs(...))` assigning to undeclared variables,
// which crashed the b1.0.2 release with "zipPath is not defined") is
// invisible to import-based tests. These spawn the real process to cover it.

test('cli: no args -> usage + exit 2', () => {
  const { status, out } = runCli();
  assert.equal(status, 2);
  assert.match(out, /usage:/);
});

test('cli: missing --mode is a tooling error (exit 2 is arg, exit 1 is gate)', () => {
  // A zip path with no --mode: parseArgs succeeds (zipPath set, mode=''),
  // verifyArtifact rejects the empty mode -> gate failure exit 1.
  const { status, out } = runCli('/nonexistent/does-not-exist.zip');
  assert.equal(status, 1);
  assert.match(out, /unknown mode/);
});

test('cli: nonexistent zip -> "zip not found" + exit 1', () => {
  const { status, out } = runCli('/nonexistent/does-not-exist.zip', '--mode', 'unsigned');
  assert.equal(status, 1);
  assert.match(out, /zip not found/);
});

test('cli: unexpected extra positional arg -> exit 2', () => {
  const { status, out } = runCli('a.zip', 'b.zip', '--mode', 'unsigned');
  assert.equal(status, 2);
  assert.match(out, /unexpected argument/);
});
