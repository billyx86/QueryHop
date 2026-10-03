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

import {
  parseCodesignDv,
  classifySignature,
  gateExpectations,
} from '../scripts/verify-signed-artifact.mjs';

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
