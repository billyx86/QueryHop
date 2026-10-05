#!/usr/bin/env node
//
// verify-signed-artifact.mjs
//
// Verification core for macOS release artifacts (issue #68).
//
// The Developer ID signing/notarisation chain in the release workflow
// (issue #63) could never be exercised on the shared GitHub runners —
// the five Apple secrets are not set, so every signing step was skipped
// and the "is this artifact really signed + notarised?" decision logic
// went untested. This module splits that logic out of the shell so it
// can be exercised on every CI run:
//
//   * `parseCodesignDv()` — parses the output of
//     `codesign -d -v --verbose=4` (the same output the gate captures
//     on a real build).
//   * `classifySignature()` — decides what a signature means:
//     Developer ID (with signer name + team id), ad-hoc, or unsigned.
//   * `gateExpectations()` — encodes which properties a release artifact
//     must satisfy in each mode (signed vs. unsigned fallback).
//
// The pure core (everything above `verifyArtifact`) has no child_process
// and no fs, so the full decision table is unit-tested on Linux in CI
// (tests/verify-signed-artifact.test.js). The `verifyArtifact()`
// orchestrator below is what the release workflow invokes on a real
// macOS runner: it unzips the SHIPPED zip (not the in-tree build) and
// applies this same logic to the actual bytes.
//
// Exit codes (CLI): 0 = artifact passes the gate, 1 = verification
// failed, 2 = tooling/environment problem (bad args, unreadable zip).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

// ---- pure core (unit-tested on every CI run) --------------------------

/**
 * Parse `codesign -d -v --verbose=4` output into fields.
 *
 * Developer ID signed app (macOS 14, Xcode 15):
 *
 *   Executable=.../QueryHop.app/Contents/MacOS/QueryHop
 *   Identifier=com.billyking.QueryHop
 *   Format=app bundle with Mach-O universal (x86_64 arm64)
 *   CodeDirectory v=20500 size=222076 flags=0x10000(runtime) Hash type=sha256 size=32
 *   Authority=Developer ID Application: Billy King (QHX23VWXYZ)
 *   Authority=Developer ID Certification Authority
 *   Authority=Apple Root CA
 *   TeamIdentifier=QHX23VWXYZ
 *   Sealed Resources version=2 rules=13 files=42
 *
 * Ad-hoc signed binary (verbatim `codesign -d -v --verbose=4` from a
 * macos-latest runner, Xcode 26.6, Darwin arm64 — the lipo-thinned arm64
 * slice of a signed universal binary, the exact shape the unsigned
 * fallback gate inspects):
 *
 *   Executable=/Users/runner/work/_temp/adhoc-diag/t-thin
 *   Identifier=t-fat-55554944f618c4ef94153916b244b09c725fb0c7
 *   Format=Mach-O thin (arm64)
 *   CodeDirectory v=20400 size=263 flags=0x2(adhoc) hashes=2+2 location=embedded
 *   Signature=adhoc
 *   Info.plist=not bound
 *   TeamIdentifier=not set
 *
 * Real codesign spells it "Signature=adhoc" (NO hyphen) and
 * "TeamIdentifier=not set" (not an empty value). isAdhocSignature()
 * accepts both the real "adhoc" spelling and the hyphenated "ad-hoc"
 * name so a correctly signed arm64 slice is never misfiled as "unsigned".
 *
 * An unsigned object makes codesign exit non-zero with e.g.
 * "code object is not signed at all" and no field output — the caller
 * passes that exit code through to classifySignature().
 */
export function parseCodesignDv(output) {
  const text = String(output ?? '');
  const fields = {
    executable: null,
    identifier: null,
    format: null,
    signature: null,
    teamIdentifier: null,
    authorities: [],
    hardenedRuntime: false,
  };
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9._-]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    switch (key) {
      case 'Executable':
        fields.executable = value;
        break;
      case 'Identifier':
        fields.identifier = value || null;
        break;
      case 'Format':
        fields.format = value || null;
        break;
      case 'Signature':
        fields.signature = value || null;
        break;
      case 'TeamIdentifier':
        // Real codesign prints "TeamIdentifier=not set" (and for
        // linker-signed code, nothing team-related at all) when there is
        // no team — normalise that to null, not the literal string.
        fields.teamIdentifier =
          value && value !== 'not set' ? value : null;
        break;
      case 'Authority':
        fields.authorities.push(value);
        break;
      default:
        break;
    }
  }
  // The CodeDirectory line carries "flags=0x…(runtime)" when the
  // hardened runtime is enabled; the hex value differs between builds,
  // so match the (runtime) marker, not the number.
  fields.hardenedRuntime = /flags=0x[0-9a-fA-F]*\(runtime\)/.test(text);
  return fields;
}

/**
 * True when a parsed `Signature=` value denotes an ad-hoc signature.
 *
 * Real macOS `codesign -d` prints "Signature=adhoc" (no hyphen) —
 * captured verbatim from a macos-latest runner (Xcode 26.6) for a
 * linker-signed binary, an ad-hoc signed binary, and the lipo-thinned
 * arm64 slice of a signed universal binary (see PR #73 diagnostic).
 * The hyphenated "ad-hoc" form is the common name for the same
 * signature class and is accepted too, so neither spelling can be
 * misfiled as "unsigned" and fail the unsigned-fallback release gate
 * (the b1.0.2 failure: "arm64 slice: expected ad-hoc, got unsigned").
 */
export function isAdhocSignature(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase().replace(/[\s_-]/g, '');
  return v === 'adhoc' || v === 'adhocsigned';
}

/**
 * Classify a parsed `codesign -d` result (plus the process exit code)
 * into exactly one of: 'developer-id', 'ad-hoc', 'other', 'unsigned'.
 *
 * `dvExitCode` is the exit status of the codesign invocation: a nonzero
 * status means the object is not signed at all (or unreadable), and no
 * field output can be trusted.
 */
export function classifySignature(parsed, dvExitCode = 0) {
  if (dvExitCode !== 0) return { kind: 'unsigned' };
  if (!parsed || !parsed.executable) return { kind: 'unsigned' };

  const devId = parsed.authorities.find((a) =>
    a.startsWith('Developer ID Application:')
  );
  if (devId) {
    // "Developer ID Application: <Name> (<TEAMID>)" — the parenthesised
    // 6-10 char uppercase team id is present for real certificates;
    // fall back to the TeamIdentifier field if the format ever shifts.
    const m = devId.match(/^Developer ID Application: (.+?) \(([A-Z0-9]{1,10})\)$/);
    return {
      kind: 'developer-id',
      signer: m ? m[1] : devId.replace(/^Developer ID Application:\s*/, ''),
      teamId: m ? m[2] : parsed.teamIdentifier ?? null,
      authorities: parsed.authorities,
      hardenedRuntime: parsed.hardenedRuntime,
    };
  }
  if (isAdhocSignature(parsed.signature)) return { kind: 'ad-hoc' };
  if (parsed.authorities.length > 0) {
    // Signed with a non-Developer ID identity (e.g. Apple Development) —
    // not an error to classify, but a release gate must reject it.
    return {
      kind: 'other',
      authorities: parsed.authorities,
      teamId: parsed.teamIdentifier ?? null,
      hardenedRuntime: parsed.hardenedRuntime,
    };
  }
  return { kind: 'unsigned' };
}

/**
 * What a release artifact must satisfy in each mode.
 *
 * signed:   the app must carry a Developer ID Application signature
 *           (optionally pinned to a specific team id), the hardened
 *           runtime flag, a passing `codesign --verify --deep --strict`,
 *           and a stapled notarisation receipt (stapler validate).
 *
 * unsigned: the fallback build is unsigned on purpose (no Apple secrets
 *           on shared runners). The x86_64 slice may be unsigned — and
 *           an unsigned slice makes `codesign --verify --deep --strict`
 *           fail by design — so the gate only asserts the universal
 *           layout and that the arm64 slice is at least ad-hoc signed
 *           (the Apple Silicon kernel refuses to run unsigned code).
 */
export function gateExpectations(mode, { expectedTeamId } = {}) {
  if (mode !== 'signed' && mode !== 'unsigned') {
    throw new Error(`unknown gate mode "${mode}" (expected signed|unsigned)`);
  }
  if (mode === 'signed') {
    return {
      mode,
      signatureKind: 'developer-id',
      teamId: expectedTeamId || null, // null = any Developer ID team
      hardenedRuntime: true,
      requireDeepStrictVerify: true,
      requireStaplerValidate: true,
    };
  }
  return {
    mode,
    arm64SliceKind: 'ad-hoc',
    requireDeepStrictVerify: false,
    requireStaplerValidate: false,
  };
}

// ---- orchestration (macOS only, invoked by the release workflow) ------

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function codesignInspect(target) {
  const dv = run('codesign', ['-d', '-v', '--verbose=4', target]);
  const parsed = parseCodesignDv(dv.stdout + '\n' + dv.stderr);
  return { parsed, cls: classifySignature(parsed, dv.status), raw: dv.stdout + dv.stderr };
}

/**
 * Verify the exact zip that is about to be uploaded. Returns
 * { ok, errors, detail } — never throws for verification failures.
 *
 * @param {string} zipPath path to the release zip
 * @param {object} opts { mode: 'signed'|'unsigned', teamId?: string, appName?: string }
 */
export function verifyArtifact(zipPath, opts) {
  const { mode, teamId = '', appName = 'QueryHop.app' } = opts || {};
  if (mode !== 'signed' && mode !== 'unsigned') {
    return { ok: false, errors: [`unknown mode "${mode}" (expected signed|unsigned)`] };
  }
  if (!existsSync(zipPath)) {
    return { ok: false, errors: [`zip not found: ${zipPath}`] };
  }
  const errors = [];
  const work = mkdtempSync(path.join(tmpdir(), 'queryhop-verify-'));
  try {
    const x = run('unzip', ['-q', zipPath, '-d', work]);
    if (x.status !== 0) {
      return { ok: false, errors: [`unzip failed: ${x.stderr.trim() || x.stdout.trim()}`] };
    }
    const app = path.join(work, appName);
    if (!existsSync(path.join(app, 'Contents', 'MacOS'))) {
      return {
        ok: false,
        errors: [`${appName}/Contents/MacOS not present in the shipped zip`],
      };
    }
    const exeName = appName.replace(/\.app$/, '');
    const exe = path.join(app, 'Contents', 'MacOS', exeName);

    // The binary must really be universal — the release promise.
    const lipo = run('lipo', ['-archs', exe]);
    const archs = lipo.stdout.trim().split(/\s+/).filter(Boolean);
    if (lipo.status !== 0 || !archs.includes('arm64') || !archs.includes('x86_64')) {
      errors.push(
        `executable is not a universal (arm64 + x86_64) binary: ${lipo.stdout.trim() || lipo.stderr.trim()}`
      );
    }

    const expect = gateExpectations(mode, { expectedTeamId: teamId });
    const appInspect = codesignInspect(app);

    if (mode === 'signed') {
      const cls = appInspect.cls;
      if (cls.kind !== 'developer-id') {
        errors.push(`expected a Developer ID Application signature, got "${cls.kind}"`);
      } else {
        if (expect.teamId && cls.teamId !== expect.teamId) {
          errors.push(`team id ${cls.teamId} does not match expected ${expect.teamId}`);
        }
        if (expect.hardenedRuntime && !cls.hardenedRuntime) {
          errors.push('hardened runtime flag missing from the Developer ID signature');
        }
      }
      const verify = run('codesign', ['--verify', '--deep', '--strict', app]);
      if (verify.status !== 0) {
        errors.push(
          `codesign --verify --deep --strict failed: ${verify.stderr.trim() || verify.stdout.trim()}`
        );
      }
      const staple = run('xcrun', ['stapler', 'validate', zipPath]);
      if (staple.status !== 0) {
        errors.push(
          `stapler validate failed (no stapled notarisation receipt): ${(staple.stdout + staple.stderr).trim()}`
        );
      }
      return {
        ok: errors.length === 0,
        errors,
        detail: { archs, classification: cls },
      };
    }

    // Unsigned fallback: thin the arm64 slice and require ad-hoc.
    const thin = path.join(work, 'thin-arm64');
    const t = run('lipo', ['-thin', 'arm64', exe, '-output', thin]);
    if (t.status !== 0) {
      errors.push(`could not thin the arm64 slice: ${t.stderr.trim() || t.stdout.trim()}`);
    } else {
      const slice = codesignInspect(thin);
      if (slice.cls.kind !== expect.arm64SliceKind) {
        errors.push(`arm64 slice: expected ${expect.arm64SliceKind}, got "${slice.cls.kind}"`);
      }
      return {
        ok: errors.length === 0,
        errors,
        detail: { archs, appClassification: appInspect.cls, arm64Slice: slice.cls },
      };
    }
    return { ok: errors.length === 0, errors, detail: { archs } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- CLI ----------------------------------------------------------------

function parseArgs(argv) {
  const opts = { mode: '', teamId: '', appName: 'QueryHop.app' };
  let zipPath = '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode') opts.mode = argv[++i] ?? '';
    else if (a === '--team-id') opts.teamId = argv[++i] ?? '';
    else if (a === '--app') opts.appName = argv[++i] ?? 'QueryHop.app';
    else if (!zipPath) zipPath = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return { zipPath, opts };
}

// Run as a CLI (node scripts/verify-signed-artifact.mjs ...) — imported
// by the tests, so guard on the real file path rather than argv[1]
// (which is unset when the module is imported).
if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(2);
  }
  const { zipPath, opts } = parsed;
  if (!zipPath) {
    console.error('usage: node scripts/verify-signed-artifact.mjs <zip> --mode signed|unsigned [--team-id TEAMID] [--app QueryHop.app]');
    process.exit(2);
  }
  const result = verifyArtifact(zipPath, opts);
  if (result.detail) {
    const d = result.detail;
    console.log(`archs: ${d.archs.join(' ') || '(none)'}`);
    if (d.classification) console.log(`signature: ${d.classification.kind} (${d.classification.signer || 'n/a'}${d.classification.teamId ? ` / ${d.classification.teamId}` : ''})`);
    if (d.arm64Slice) console.log(`arm64 slice: ${d.arm64Slice.kind}`);
  }
  if (result.ok) {
    console.log(`OK: artifact passes the ${opts.mode} verification gate`);
    process.exit(0);
  }
  for (const e of result.errors) console.error(`FAIL: ${e}`);
  process.exit(1);
}
