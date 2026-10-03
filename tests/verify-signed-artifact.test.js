// Unit tests for scripts/verify-signed-artifact.mjs (issue #68): the
// pure decision logic behind the signed/unsigned release verification
// gate.
//
// Fixture provenance — a matter that actually cost one release:
// The ad-hoc / linker-signed fixtures below are VERBATIM `codesign
// -d -v --verbose=4` captures from a macos-latest runner (Darwin arm64,
// Xcode 26.6), recorded 2026-10-03 by the PR #73 diagnostic step, for
// three shapes the release gate really meets:
//
//   ADHOC_DV   — the lipo-thinned arm64 slice of a signed universal
//                binary (the exact procedure verifyArtifact() runs);
//   LINKER_SIGNED_DV — a freshly compiled arm64 binary (modern ld
//                always emits a linker-signed Mach-O);
//   DEV_ID_DV  — a Developer ID signed, hardened-runtime app.
//
// The first revision of this file's ad-hoc fixture was hand-written on
// a Linux host (where `codesign` does not exist) and claimed the output
// said "Signature=ad-hoc". Real codesign prints "Signature=adhoc" (no
// hyphen), "TeamIdentifier=not set" (not an empty value), and ad-hoc
// CodeDirectory flags read "flags=0x2(adhoc)" (no runtime marker).
// classifySignature() compared against the hyphenated string, so every
// correctly ad-hoc signed arm64 slice was misfiled as "unsigned" and
// the b1.0.2 release gate failed with
//   "arm64 slice: expected ad-hoc, got \"unsigned\"".
// Keep these fixtures byte-for-byte real: if a future codesign spells
// something differently, the classifier and its tests should change
// together.
//
// The macOS-only orchestration (verifyArtifact) is not exercised here;
// it is a thin wrapper over this tested logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseCodesignDv,
  classifySignature,
  isAdhocSignature,
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

// Verbatim `codesign -d -v --verbose=4` for the lipo-thinned arm64 slice
// of an ad-hoc signed universal binary — captured on a macos-latest
// runner (Xcode 26.6) on 2026-10-03 (PR #73 diagnostic, case C2). Note:
// "Signature=adhoc" (NO hyphen), "TeamIdentifier=not set", and
// "flags=0x2(adhoc)" — no runtime marker.
const ADHOC_DV = `Executable=/Users/runner/work/_temp/adhoc-diag/t-thin
Identifier=t-fat-55554944f618c4ef94153916b244b09c725fb0c7
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=263 flags=0x2(adhoc) hashes=2+2 location=embedded
VersionPlatform=1
VersionMin=1703936
VersionSDK=1705216
Hash type=sha256 size=32
CandidateCDHash sha256=8ea22d800e01e7fc7a922381340e99e4ea85fa61
CandidateCDHashFull sha256=8ea22d800e01e7fc7a922381340e99e4ea85fa6103c59d932d377d6eb9e55314
Hash choices=sha256
CMSDigest=8ea22d800e01e7fc7a922381340e99e4ea85fa6103c59d932d377d6eb9e55314
CMSDigestType=2
Executable Segment base=0
Executable Segment limit=16384
Executable Segment flags=0x1
Page size=16384
CDHash=8ea22d800e01e7fc7a922381340e99e4ea85fa61
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements count=0 size=12`;

// Verbatim `codesign -d -v --verbose=4` for a freshly compiled arm64
// binary that was never explicitly signed — modern ld emits a
// linker-signed Mach-O (Xcode 26.6, 2026-10-03, PR #73 diagnostic,
// case A1). It still reports "Signature=adhoc"; the kernel accepts it,
// which is why the unsigned-fallback gate treats linker-signed as
// satisfying the "at least ad-hoc" requirement.
const LINKER_SIGNED_DV = `Executable=/Users/runner/work/_temp/adhoc-diag/t-arm64
Identifier=t-arm64
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=256 flags=0x20002(adhoc,linker-signed) hashes=5+0 location=embedded
VersionPlatform=1
VersionMin=1703936
VersionSDK=1705216
Hash type=sha256 size=32
CandidateCDHash sha256=a46d125fd8807a0f4235d1edd513f03774035caf
CandidateCDHashFull sha256=a46d125fd8807a0f4235d1edd513f03774035caf9c75ef2023d286c9905f4c69
Hash choices=sha256
CMSDigest=a46d125fd8807a0f4235d1edd513f03774035caf9c75ef2023d286c9905f4c69
CMSDigestType=2
Executable Segment base=0
Executable Segment limit=20
Executable Segment flags=0x1
Page size=4096
CDHash=a46d125fd8807a0f4235d1edd513f03774035caf
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements=none`;

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

test('parseCodesignDv handles the real ad-hoc slice output', () => {
  const p = parseCodesignDv(ADHOC_DV);
  assert.equal(p.format, 'Mach-O thin (arm64)');
  // Real codesign spells it "adhoc" — no hyphen.
  assert.equal(p.signature, 'adhoc');
  // Real codesign prints "TeamIdentifier=not set" — must parse to null.
  assert.equal(p.teamIdentifier, null);
  assert.equal(p.authorities.length, 0);
  // Ad-hoc CodeDirectory flags are "0x2(adhoc)" — NO runtime marker.
  assert.equal(p.hardenedRuntime, false);
});

test('parseCodesignDv handles the real linker-signed output', () => {
  const p = parseCodesignDv(LINKER_SIGNED_DV);
  assert.equal(p.format, 'Mach-O thin (arm64)');
  assert.equal(p.signature, 'adhoc');
  assert.equal(p.teamIdentifier, null);
  assert.equal(p.authorities.length, 0);
  assert.equal(p.hardenedRuntime, false);
});

test('parseCodesignDv on garbage yields empty fields, no crash', () => {
  const p = parseCodesignDv(UNSIGNED_DV);
  assert.equal(p.executable, null);
  assert.equal(p.authorities.length, 0);
  assert.equal(p.hardenedRuntime, false);
});

test('isAdhocSignature accepts the real and hyphenated spellings', () => {
  assert.equal(isAdhocSignature('adhoc'), true);
  assert.equal(isAdhocSignature('ad-hoc'), true);
  assert.equal(isAdhocSignature('Adhoc'), true);
  assert.equal(isAdhocSignature(' adhoc '), true);
  assert.equal(isAdhocSignature('cms'), false);
  assert.equal(isAdhocSignature(null), false);
  assert.equal(isAdhocSignature(undefined), false);
  assert.equal(isAdhocSignature(42), false);
  assert.equal(isAdhocSignature('not signed at all'), false);
});

test('classifySignature: Developer ID application with signer + team id', () => {
  const cls = classifySignature(parseCodesignDv(DEV_ID_DV), 0);
  assert.equal(cls.kind, 'developer-id');
  assert.equal(cls.signer, 'Billy King');
  assert.equal(cls.teamId, 'QHX23VWXYZ');
  assert.equal(cls.hardenedRuntime, true);
});

test('classifySignature: the real ad-hoc slice is ad-hoc (b1.0.2 regression)', () => {
  // This is the exact classification the unsigned-fallback gate makes on
  // the shipped zip's arm64 slice. Before the isAdhocSignature() fix the
  // real "Signature=adhoc" output fell through to "unsigned" and the
  // b1.0.2 release failed with:
  //   arm64 slice: expected ad-hoc, got "unsigned".
  assert.equal(classifySignature(parseCodesignDv(ADHOC_DV), 0).kind, 'ad-hoc');
});

test('classifySignature: a linker-signed slice also satisfies ad-hoc', () => {
  // Modern ld linker-signs every arm64 Mach-O; the Apple Silicon kernel
  // accepts it, so the "at least ad-hoc" gate requirement is met.
  assert.equal(
    classifySignature(parseCodesignDv(LINKER_SIGNED_DV), 0).kind,
    'ad-hoc'
  );
});

test('classifySignature: codesign nonzero exit means unsigned', () => {
  assert.equal(classifySignature(parseCodesignDv(UNSIGNED_DV), 1).kind, 'unsigned');
  assert.equal(classifySignature(null, 1).kind, 'unsigned');
});

test('classifySignature: non-Developer ID certificate is "other"', () => {
  // A CMS-signed binary with a non-Developer ID authority chain: real
  // output carries "Signature=cms" plus the Authority= lines. (The old
  // fixture paired an authority chain with "Signature=adhoc" — that
  // combination does not occur; ad-hoc signatures have no authority
  // chain, and with the isAdhocSignature() fix such a hybrid would now
  // classify as ad-hoc, which is the correct precedence anyway.)
  const out = LINKER_SIGNED_DV.replace(
    'Signature=adhoc',
    'Authority=Apple Development: Billy King (QHX23VWXYZ)\nAuthority=Apple Development CA\nAuthority=Apple Root CA\nSignature=cms'
  );
  const cls = classifySignature(parseCodesignDv(out), 0);
  assert.equal(cls.kind, 'other');
  assert.equal(cls.teamId, null);
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

test('cli: missing --mode is a gate error (exit 1, unknown mode)', () => {
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
