#!/usr/bin/env node
//
// release-checksum.mjs
//
// SHA-256 checksums for macOS release assets (issue #69).
//
// The b1.0.2 release shipped a binary zip with no integrity check — anyone
// re-downloading (or re-using offline) the asset had no way to detect a
// corrupt or tampered artifact. This module computes a shasum-compatible
// `.sha256` sidecar for the release zip so it can be verified with the
// stock tools:
//
//   shasum -a 256 -c QueryHop-1.0.3-macos-universal-unsigned.zip.sha256   # macOS
//   sha256sum -c QueryHop-1.0.3-macos-universal-unsigned.zip.sha256      # Linux
//
// Node's crypto is used instead of shasum/sha256sum so the pure core runs
// (and is unit-tested) on every platform CI uses; the checksum file
// format is the stock "hex  filename" text-mode line (two spaces) that
// both tools accept.
//
// Exit codes (CLI): 0 = OK, 1 = checksum mismatch / bad file,
// 2 = tooling/environment problem (bad args).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---- pure core (unit-tested on every CI run) --------------------------

/**
 * Compute the SHA-256 hex digest of a file's contents.
 *
 * Streaming in 1 MiB chunks so a multi-GB asset (future notarised
 * universal zip) never holds the whole file in memory.
 */
export function sha256OfFile(content) {
  // Accepts a Buffer/Uint8Array directly so the digest logic is testable
  // without touching the filesystem; the CLI path reads the file first.
  const hash = createHash('sha256');
  for (let i = 0; i < content.length; i += 1024 * 1024) {
    hash.update(content.subarray(i, i + 1024 * 1024));
  }
  return hash.digest('hex');
}

/**
 * Build one checksum-file line in shasum/sha256sum text mode:
 * "<hex>  <filename>" — two spaces mark text mode, which both tools
 * accept on any platform.
 */
export function checksumLine(hex, filename) {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`not a SHA-256 hex digest: ${hex}`);
  }
  return `${hex}  ${filename}\n`;
}

/**
 * Parse a .sha256 file into {filename, hex} entries.
 * Returns {ok, entries, errors}. Tolerates leading/trailing blank lines
 * and comments (lines starting with #), matching sha256sum behaviour.
 */
export function parseChecksumFile(content) {
  const entries = [];
  const errors = [];
  const lines = String(content ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    // "<hex>  <name>" (text mode, two spaces) or "<hex> <name>" or
    // "<hex> *<name>" (binary mode marker). The name may contain spaces,
    // so split on the FIRST whitespace run after the hex.
    const m = line.match(/^([0-9a-fA-F]{64})[ \t]+(\*)?(\S.*?)\s*$/);
    if (!m) {
      errors.push(`line ${i + 1}: not a "<hex>  <filename>" checksum line: ${line}`);
      continue;
    }
    entries.push({ hex: m[1].toLowerCase(), binary: Boolean(m[2]), filename: m[3] });
  }
  if (entries.length === 0 && errors.length === 0) {
    errors.push('checksum file is empty');
  }
  return { ok: errors.length === 0, entries, errors };
}

/**
 * Verify expected digests against a map of filename -> actual hex digest.
 * Pure function (no fs): the CLI resolves paths and digests the files
 * itself, so the matching logic is testable with in-memory data.
 */
export function verifyDigests(entries, actual) {
  const errors = [];
  for (const e of entries) {
    const have = Object.prototype.hasOwnProperty.call(actual, e.filename)
      ? actual[e.filename]
      : null;
    if (have === null) {
      errors.push(`no file to verify: ${e.filename}`);
    } else if (have.toLowerCase() !== e.hex) {
      errors.push(`MISMATCH: ${e.filename} (expected ${e.hex}, got ${have})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---- orchestration (CLI) ----------------------------------------------

function fileDigest(filePath) {
  return sha256OfFile(readFileSync(filePath));
}

/**
 * Write <zipPath>.sha256 next to the artifact and re-read + verify it,
 * so a broken write is caught immediately instead of at download time.
 */
export function writeChecksum(zipPath) {
  if (!existsSync(zipPath)) {
    return { ok: false, errors: [`artifact not found: ${zipPath}`] };
  }
  const outPath = `${zipPath}.sha256`;
  const line = checksumLine(fileDigest(zipPath), path.basename(zipPath));
  writeFileSync(outPath, line, 'utf8');
  // Round-trip: parse what was just written and verify against the file.
  const parsed = parseChecksumFile(readFileSync(outPath, 'utf8'));
  const result = verifyDigests(
    parsed.entries,
    { [path.basename(zipPath)]: fileDigest(zipPath) }
  );
  return {
    ok: parsed.ok && result.ok,
    errors: [...parsed.errors, ...result.errors],
    outPath,
    hex: line.trim().split(' ')[0],
  };
}

/**
 * Verify an artifact against its .sha256 sidecar (the download-side
 * operation, `shasum -a 256 -c` equivalent).
 */
export function checkChecksum(sha256Path) {
  if (!existsSync(sha256Path)) {
    return { ok: false, errors: [`checksum file not found: ${sha256Path}`] };
  }
  const dir = path.dirname(sha256Path);
  const parsed = parseChecksumFile(readFileSync(sha256Path, 'utf8'));
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const actual = {};
  for (const e of parsed.entries) {
    const p = path.join(dir, e.filename);
    if (!existsSync(p)) continue; // reported by verifyDigests
    actual[e.filename] = fileDigest(p);
  }
  return verifyDigests(parsed.entries, actual);
}

// ---- CLI ----------------------------------------------------------------

function parseArgs(argv) {
  const opts = { mode: '' };
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write' || a === '--check') opts.mode = a.slice(2);
    else files.push(a);
  }
  return { files, mode: opts.mode };
}

// Run as a CLI (node scripts/release-checksum.mjs ...) — imported by the
// tests, so guard on the real file path rather than argv[1] (unset when
// the module is imported).
if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(2);
  }
  if (parsed.files.length !== 1 || (parsed.mode !== 'write' && parsed.mode !== 'check')) {
    console.error('usage: node scripts/release-checksum.mjs --write <artifact.zip> | --check <artifact.zip.sha256>');
    process.exit(2);
  }
  const target = parsed.files[0];
  const result = parsed.mode === 'write' ? writeChecksum(target) : checkChecksum(target);
  if (result.ok) {
    if (parsed.mode === 'write') {
      console.log(`OK: wrote ${result.outPath}`);
      console.log(result.hex);
    } else {
      console.log('OK: checksum verified');
    }
    process.exit(0);
  }
  for (const e of result.errors) console.error(`FAIL: ${e}`);
  process.exit(1);
}
