// ESLint flat config (issue #79) — the static-analysis floor that
// `node --check` cannot provide: parse errors are caught in CI's validate
// job; this catches the drift classes the guards exist for (undeclared or
// dead names, sloppy equality, unawaited async, duplicate keys, for...in)
// across every JS file in the repo.
//
// ZERO-NPM-DEPS POLICY
//   This repo ships no node_modules and no lockfile (package.json is
//   "private" with a single `node --test` script). CI runs ESLint via
//   `npx -y -p eslint@9 eslint .`, so this config MUST NOT import any
//   third-party package — not even `@eslint/js` or `globals`, which are
//   not resolvable from the repo root. Everything is inline: rule set +
//   per-context global lists.
//
// DRIFT FLOOR, NOT A STYLE POLICE
//   Several shipped files are text-parsed by drift guards (bgCommon.js,
//   background.js, Script.js, popupI18n.js …) — a repo-wide reformat is
//   off the table. The correctness rules below are the gate; the few style
//   rules included are the ones the codebase ALREADY satisfies uniformly
//   (verified: zero findings), so they protect the house style on new code
//   without touching existing files. Anything style-ish the codebase does
//   not do uniformly (quotes, template literals, trailing commas) is
//   deliberately left out of the gate.
//
// LINT TARGETS
//   eslint.config.js                  — this file (ESM)
//   QueryHop Extension/Resources/*.js — MV3 service worker + popup modules
//   QueryHop/Resources/Script.js      — Safari host-window classic script
//   tests/*.js                        — node --test suite (Node 22+)
//   scripts/*.mjs                     — release/tag/checksum tooling

export default [
  // --- Correctness floor (every JS file) -------------------------------------
  {
    rules: {
      // Names: the drift classes guards exist for
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-else-if': 'error',
      'no-fallthrough': 'error',
      'no-prototype-builtins': 'error',
      'no-self-assign': 'error',

      // Correctness rules added in #84 — zero-finding bug classes the
      // original floor did not cover (verified: zero findings repo-wide on
      // eslint 9.39.5). Same drift-floor, not-style-police contract.
      'valid-typeof': 'error',
      'no-ex-assign': 'error',
      'no-unsafe-negation': 'error',
      'no-loss-of-precision': 'error',
      'no-unexpected-multiline': 'error',
      'no-const-assign': 'error',
      'no-class-assign': 'error',
      'no-dupe-class-members': 'error',
      'no-sparse-arrays': 'error',
      'getter-return': 'error',

      // Equality: == null stays allowed (the "absent" idiom), everything
      // else must be === / !==.
      'eqeqeq': ['error', 'smart'],

      // Async: an async function must actually await; return await is
      // redundant since the async/await rewrite.
      'require-await': 'error',
      'no-return-await': 'error',
      'no-async-promise-executor': 'error',

      // Values / prototypes
      'use-isnan': 'error',
      'no-new-wrappers': 'error',
      'no-iterator': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],

      // Legacy / footgun constructs
      'no-restricted-globals': [
        'error',
        'event', // window.event is uncatchable and never intentional here
        'fdescribe', // test-runner focus leaks into CI
        'fit',
        'xit',
        'xdescribe',
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'ForInStatement', message: 'Use for...of; for...in walks the prototype chain.' },
        { selector: 'LabeledStatement', message: 'Labels are unneeded with blocks and early returns.' },
      ],

      // House style the codebase already satisfies uniformly (verified
      // zero findings) — protect it on new code.
      'semi': ['error', 'always'],
      'no-trailing-spaces': 'error',
      'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 1 }],
      'eol-last': 'error',
    },
  },

  // --- This config file --------------------------------------------------------
  {
    files: ['eslint.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },

  // --- MV3 extension modules (service worker + popup) --------------------------
  {
    files: ['QueryHop Extension/Resources/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Injected by the extension runtime in every context.
        chrome: 'readonly',
        // Popup pages get the DOM; the service worker does not, but the
        // popup modules are the ones using it and no-undef is per-file.
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        self: 'readonly',
        // Web-platform globals (modern Chromium + Node 22 provide all).
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        structuredClone: 'readonly',
        console: 'readonly',
      },
    },
  },

  // --- Safari host-window script ------------------------------------------------
  // Classic (non-module) script evaluated in the Safari web-extension host
  // window; it reaches the native side through the webkit.messageHandlers
  // bridge that Safari injects.
  {
    files: ['QueryHop/Resources/Script.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        document: 'readonly',
        window: 'readonly',
        console: 'readonly',
        // Safari-injected native bridge (webkit.messageHandlers.controller).
        webkit: 'readonly',
      },
    },
    rules: {
      // `show` and `showError` are not dead code: the Swift host calls them
      // via webView.evaluateJavaScript("show(…)") / ("showError(…)") — see
      // Shared/HostBridge.swift and QueryHop/ViewController.swift. And
      // show()'s second parameter is deliberately retained in the signature
      // for the native caller's compatibility (its comment says so).
      'no-unused-vars': [
        'error',
        {
          args: 'none',
          varsIgnorePattern: '^(show|showError)$',
        },
      ],
    },
  },

  // --- Test suite (node --test, Node 22+) ----------------------------------------
  {
    files: ['tests/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
      },
    },
  },

  // --- Release/tag/checksum tooling ------------------------------------------------
  {
    files: ['scripts/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
];
