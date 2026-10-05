// Import-graph resolution guard (issue #81).
//
// The CI validate job runs `node --check` on every shipped script — syntax
// per file, only. It cannot detect that background.js imports
// ./bgSettings.js while the file was renamed to ./bg-settings.js: every file
// still parses, but the service worker's module graph breaks at startup.
// Issue #59 is the lived example of this class (the hand-maintained file
// list missed the three bg* modules split out of background.js in #51).
//
// The only check that catches a missing shipped module today is the
// build-macos job's "extension bundle embedded and intact" step — but it
// runs on the most expensive runner, takes up to 30 minutes, and verifies
// FILE PRESENCE, not import resolution. This guard moves the class to Linux:
// a stdlib-only `node --test` file (zero npm deps, matching the repo
// philosophy) that walks every shipped script, extracts the relative
// `import ... from './x'` / `export ... from './x'` specifiers, and asserts
// each resolves to a real file — plus the reverse direction, so an
// orphaned module that still ships in the appex is flagged.
//
// Extraction is deliberately a strict pattern, not a parser: this codebase
// uses only relative, extension-bearing specifiers and no dynamic imports,
// so a comment/string-stripping pass plus a handful of regexes is exact
// here — and the extractor is pinned by fixture tests below, so a codebase
// change that would silently break the pattern fails the suite instead of
// the guard going quiet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(root, 'QueryHop Extension', 'Resources');
const HOST_SCRIPT = path.join(root, 'QueryHop', 'Resources', 'Script.js');
const MANIFEST_PATH = path.join(EXT_DIR, 'manifest.json');

assert.ok(existsSync(MANIFEST_PATH), 'manifest.json is missing');
assert.ok(existsSync(HOST_SCRIPT), 'host Script.js is missing');

// --- Source preprocessing ---------------------------------------------------

// Remove // line comments, /* block comments */, and string literal
// contents without touching real import statements. This is a small
// character-walk, not a parser: it tracks the open quote, blanks string
// contents (so `const s = "import './x'"` can never be mistaken for an
// import), treats escaped quotes correctly, and drops comments entirely.
// The one class it cannot see is a regex literal containing a quote
// character — none exists in the shipped scripts (a guard fixture below
// pins the walker's behavior on the real source).
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  let keepMode = false; // true while inside a relative-specifier literal
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (quote) {
      if (c === '\\') {
        if (keepMode) out += c + c2;
        i += 2;
        continue;
      }
      if (c === quote) {
        out += quote; // close the literal
        quote = null;
        keepMode = false;
        i += 1;
        continue;
      }
      if (keepMode) out += c; // keep specifier contents
      i += 1; // blank other literal contents
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c; // open the literal
      i += 1;
      // Preserve the literal's contents ONLY when it looks like a relative
      // module specifier ('./x.js' / '../x.js') — import/export-from
      // specifiers are the only strings in the shipped scripts that start
      // that way, and blanking them would delete exactly what the
      // extractor needs to find. Everything else (logs, URLs, i18n keys)
      // is blanked, so no string can ever masquerade as an import.
      const two = src.slice(i, i + 2);
      const three = src.slice(i, i + 3);
      keepMode = two === './' || three === '../';
      continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Extract every relative import/export-from specifier from a source string.
// Handles the four static forms the codebase uses:
//   import defaultThing from './x.js'
//   import { one, two } from './x.js'      (multi-line OK)
//   import * as ns from './x.js'
//   import './x.js'
//   export { reexported } from './x.js'
// Returns a Set of specifier strings (e.g. './bgCommon.js').
function extractImportSpecifiers(src) {
  const specifiers = new Set();
  const patterns = [
    // `import ... from './x'` — the middle is the default/named/namespace
    // binding in any combination; lazy match, bounded, so it stops at the
    // first `from '...'` that actually follows the import.
    /\bimport\b[\s\S]{0,400}?\bfrom\s*(['"])(\.\.?\/[^'"]+)\1/g,
    // bare `import './x'`
    /\bimport\s*(['"])(\.\.?\/[^'"]+)\1/g,
    // `export { ... } from './x'` and `export * from './x'`
    /\bexport\s+(?:\{[^}]*\}|\*)\s+from\s*(['"])(\.\.?\/[^'"]+)\1/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) specifiers.add(m[2]);
  }
  return specifiers;
}

const specifiersOfFile = (file) =>
  extractImportSpecifiers(stripComments(readFileSync(file, 'utf8')));

// --- Fixture: the extractor is pinned ----------------------------------------

test('extractImportSpecifiers: real import forms only; comments and strings ignored (#81)', () => {
  const fixture = [
    "// import './comment-only.js' — a line comment, must be ignored",
    "/* import './block-comment.js' */",
    "const note = \"import './in-double-quotes.js'\";",
    "const note2 = 'import \'./in-single-quotes.js\'';",
    'const tmpl = `not ${\'real\'} either`;',
    "import defaultThing from './default-thing.js';",
    'import {\n  one,\n  two,\n} from \'./named.js\';',
    "import * as ns from './namespace.js';",
    "import './bare.js';",
    "export { reexported } from './reexport.js';",
    "export * from './star-reexport.js';",
    // the word 'from' inside a binding name must not fool the matcher
    "import { from_thing } from './safe-from-name.js';",
  ].join('\n');

  const found = extractImportSpecifiers(stripComments(fixture));
  assert.deepEqual(
    [...found].sort(),
    [
      './bare.js',
      './default-thing.js',
      './named.js',
      './namespace.js',
      './reexport.js',
      './safe-from-name.js',
      './star-reexport.js',
    ],
    'extractor must find exactly the real static import/export-from specifiers'
  );
});

// --- Forward: every specifier resolves to a real file ------------------------

test('every relative import in the shipped scripts resolves to a real file (#81)', () => {
  const files = [
    ...readdirSync(EXT_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(EXT_DIR, f)),
    HOST_SCRIPT,
  ];
  const broken = [];
  for (const file of files) {
    for (const spec of specifiersOfFile(file)) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (!existsSync(resolved)) {
        broken.push(`${path.relative(root, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(
    broken,
    [],
    'unresolvable import specifiers (the module graph breaks at startup even though every file parses): ' +
      broken.join('; ')
  );
});

// --- Reverse: no orphaned modules ship in the appex --------------------------

test('every non-popup extension module is reachable from background.js; manifest entries exist (#81)', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  // The manifest entry points must exist on disk.
  const bgScripts = (manifest.background && manifest.background.scripts) || [];
  assert.ok(bgScripts.includes('background.js'),
    'manifest background.scripts must include background.js');
  for (const entry of bgScripts) {
    assert.ok(existsSync(path.join(EXT_DIR, entry)),
      `manifest entry ${entry} does not exist next to manifest.json`);
  }
  const popupPage = manifest.action && manifest.action.default_popup;
  assert.ok(typeof popupPage === 'string' && existsSync(path.join(EXT_DIR, popupPage)),
    `manifest action.default_popup ${JSON.stringify(popupPage)} does not exist next to manifest.json`);

  // Build the import adjacency over the tracked extension modules (basename
  // space — the codebase imports only same-directory './x.js' specifiers).
  const tracked = readdirSync(EXT_DIR).filter((f) => f.endsWith('.js'));
  const adjacency = new Map();
  for (const name of tracked) {
    const targets = new Set();
    for (const spec of specifiersOfFile(path.join(EXT_DIR, name))) {
      const resolved = path.resolve(EXT_DIR, spec);
      const base = path.basename(resolved);
      if (tracked.includes(base)) targets.add(base);
    }
    adjacency.set(name, targets);
  }

  // BFS from background.js (the service-worker entry).
  const reachable = new Set();
  const queue = ['background.js'];
  while (queue.length) {
    const cur = queue.shift();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const next of adjacency.get(cur) || []) queue.push(next);
  }

  // popup*.js modules are entry-driven from popup.html (not from
  // background.js), so they are exempt — everything else that ships in the
  // appex must be reachable from the worker entry, or it is dead weight
  // (the #59 class: a split-out module no test imports and nothing guards).
  const orphans = tracked.filter(
    (f) => f !== 'background.js' && !f.startsWith('popup') && !reachable.has(f)
  );
  assert.deepEqual(
    orphans,
    [],
    `tracked extension modules unreachable from background.js (orphaned — they still ship in the appex): ${orphans.join(', ')}`
  );
});
