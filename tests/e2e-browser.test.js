// Browser end-to-end smoke net (issue #75).
//
// Every other test in this repo is a Node unit/integration test that exercises
// the redirect logic through mocks and direct function imports. None of them
// load the extension in a real browser, so these regressions would ship
// silently:
//   * an MV3 service worker whose module graph (background.js + its bg*
//     imports) fails to boot in a real browser
//   * a chrome.storage key drifting between the popup and the background
//   * the webNavigation onBeforeNavigate -> tabs.update chain not firing
//   * a renamed popup element breaking the save flow
//
// What this net proves, and how it degrades
// -----------------------------------------
// Loading an unpacked MV3 extension in headless Chrome is environment-
// sensitive: some builds render extension pages, others land them on
// chrome-error://; some expose the extension's chrome.* API surface to an
// externally-attached DevTools session, others do not; and MV3 workers are
// lazy — an unpacked extension's service worker may not appear in the target
// list until an event (e.g. webNavigation.onBeforeNavigate) wakes it. Stock
// headless Chrome also lists BUILT-IN component-extension workers (e.g.
// "Google Network Speech"), so "first chrome-extension:// worker" is NOT
// QueryHop. Rather than flake on that variance, the net asserts in tiers:
//
//   HARD (always, in any environment where Chrome boots):
//     * Chrome launches and opens a DevTools debug port.
//     * popup.html exists on disk and still contains the DOM ids the save flow
//       wires (#enableExtension, #searchUrl, #debugLog, #save).
//     * IF QueryHop's service worker is discovered, it must be QueryHop's:
//       identified by the computed unpacked-extension ID (SHA-256 of the load
//       path — the algorithm Chrome uses) and, when the manifest is readable,
//       fingerprinted (webNavigation + storage permissions, background.js
//       worker). A worker that claims our ID but carries a different manifest
//       is a hard failure.
//     * IF the worker is NOT discovered after waking it, Chrome's own stderr
//       is checked: a logged load failure that mentions QueryHop (broken
//       manifest, unparseable module graph, missing import) is a HARD failure
//       — that is the boot regression this net exists to catch.
//
//   HARD (auto-activates only when the discovered worker exposes the full
//     chrome API surface — the behavioral net is only meaningful there):
//     * settings written the popup's way round-trip through the background's
//       own chrome.storage access (popup/background key agreement).
//     * navigating a real tab to a Google search URL makes the extension
//       record a 'redirect' debug-log entry for the custom search URL
//       (network-independent — the entry is written before tabs.update).
//     * with the extension disabled, the same navigation records none.
//
//   DEGRADED PASS (environmental limitation, reported in the CI log):
//     * worker never appears AND Chrome stderr shows no load failure for
//       QueryHop -> the build simply does not surface this MV3 worker; the
//       net passes with a clear "boot claim unverified" note instead of
//       failing a PR on the environment.
//   * DIAGNOSTIC (best-effort, never fail the test): an in-extension
//     fetch() of popup.html; the final tab URL after a navigation (the
//     network-dependent last mile).
//
// TIER OUTCOME (issue #80)
//   Because DEGRADED passes by design, the tier every run actually
//   achieved is recorded explicitly: an `e2e-tier=full|degraded|skipped`
//   line in the test log plus a machine-readable JSON file (default
//   ./e2e-tier.json, override with QHYOP_E2E_TIER_FILE). CI appends the
//   file to the step summary, and the weekly `e2e-full-tier` workflow
//   requires tier=full — so a runner image that degrades indefinitely
//   is visible in CI history and hard-fails a scheduled run instead of
//   masking a stale behavioral net forever.
//
// The test is deliberately dependency-free: the repo runs on `node --test`
// with zero npm packages, so instead of Puppeteer/Playwright we speak the
// Chrome DevTools Protocol directly over the Node 22 built-in WebSocket (plus
// plain HTTP for target discovery).
//
// WHEN IT RUNS
//   The browser phase only runs when CI opts in with QHYOP_E2E_BROWSER=1 AND a
//   working headless Chrome/Chromium can actually launch (verified by waiting
//   for its DevTools debug port). Anywhere a browser is unavailable — a laptop
//   without Chrome, a container whose Chromium crashes on startup — the test
//   resolves to PASS with a diagnostic. There is exactly ONE top-level test and
//   it never calls t.skip(), so the test-count-consistency guard stays happy in
//   every environment; the real assertions run in the dedicated CI job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(root, 'QueryHop Extension', 'Resources');

const LAUNCH_TIMEOUT_MS = 15_000;  // budget to get a debug port up
const SW_APPEAR_TIMEOUT_MS = 6_000; // budget for the SW target to show in /json/list
const WAKE_TIMEOUT_MS = 6_000;      // budget for a real navigation to wake the lazy SW
const SURFACE_TIMEOUT_MS = 5_000;  // budget for the chrome API surface to be reachable
const SETTLE_MS = 800;            // let storage calls land
const REDIRECT_SETTLE_MS = 3_000; // let the onBeforeNavigate debounce + tabs.update + page load run

const CUSTOM_SEARCH_URL = 'https://duckduckgo.com/?q=%s';
const SCENARIO1_QUERY = 'over the moon'; // -> https://duckduckgo.com/?q=over%20the%20moon
const SCENARIO1_TARGET = 'https://duckduckgo.com/?q=over%20the%20moon';
const SCENARIO2_QUERY = 'zzz no redirect';

// The DOM ids the popup save flow wires (popupSave.js reads exactly these).
const POPUP_REQUIRED_IDS = ['enableExtension', 'searchUrl', 'debugLog', 'save'];

// --- Tier outcome tracking (issue #80) ---------------------------------------
// The tiered design is right for a PR gate: when the runner image's headless
// Chrome never surfaces the MV3 service worker, the net passes with the boot
// claim marked unverified instead of failing on the environment. The cost is
// that a DEGRADED pass can go on indefinitely — the behavioral net (storage
// round-trip, redirect log entry, disabled -> no redirect) then only runs on
// whatever Chrome it last ran full on. To make that visible instead of silent,
// every run records the tier it actually achieved as a machine-readable JSON
// file plus an `e2e-tier=...` log line. CI appends it to the step summary, and
// the weekly `e2e-full-tier` workflow (schedule + workflow_dispatch) reads the
// file and requires tier=full — full-on-PR stays tolerant, scheduled runs
// demand the hard tier.
const TIER_FILE =
  process.env.QHYOP_E2E_TIER_FILE || path.join(root, 'e2e-tier.json');

// Record the tier this run achieved. tier: 'full' | 'degraded' | 'skipped'.
// Never throws — recording must not be able to fail a run that would
// otherwise pass; the JSON is a byproduct, the assertions are the test.
function writeTierFile(tier, browser, detail) {
  const payload = {
    tier,
    browser: browser || null,
    detail: String(detail || '').slice(0, 1000),
    generatedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(TIER_FILE, JSON.stringify(payload, null, 2) + '\n');
  } catch (e) {
    console.warn(`[e2e] could not write tier file ${TIER_FILE}: ${e.message}`);
  }
  console.log(`[e2e] e2e-tier=${tier} — ${payload.detail}`);
}

// --- Unpacked-extension ID --------------------------------------------------
// Chrome derives an unpacked extension's ID from the absolute load path:
// SHA-256 of the path, first 16 bytes, each byte -> two chars a-p (high then
// low nibble). This is exact — a worker target whose URL host matches one of
// these IDs is, by construction, this extension's worker. We also hash the
// realpath'd path in case the runner's path involves symlinks.
function computeUnpackedExtensionId(absPath) {
  const digest = crypto.createHash('sha256').update(absPath).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

const EXPECTED_EXT_IDS = (() => {
  const set = new Set([computeUnpackedExtensionId(EXTENSION_DIR)]);
  try { set.add(computeUnpackedExtensionId(realpathSync(EXTENSION_DIR))); } catch { /* best effort */ }
  return [...set];
})();

// --- Chrome discovery + CDP helpers ----------------------------------------

// Common locations for a headless-capable Chrome/Chromium.
function candidateChromeBinaries() {
  const cands = [];
  if (process.env.CHROME_BIN) cands.push(process.env.CHROME_BIN);
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  cands.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  );
  return cands;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Talks to a single CDP endpoint (a browser or a target) over a WebSocket,
// with id-correlated request/response.
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const eventHandlers = new Map(); // method -> [fn]
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`CDP error: ${msg.error.message} (${wsUrl})`));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of eventHandlers.get(msg.method) || []) {
          try { fn(msg.params); } catch { /* diagnostic only */ }
        }
      }
    };
    ws.onopen = () => resolve(api);
    ws.onerror = (e) => reject(new Error(`CDP websocket error for ${wsUrl}: ${e?.message || 'open failed'}`));
    const api = {
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP ${method} timed out (${wsUrl})`)); }
          }, 20_000);
          pending.set(id, {
            res: (v) => { clearTimeout(timer); res(v); },
            rej: (e) => { clearTimeout(timer); rej(e); },
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      onEvent(method, fn) {
        if (!eventHandlers.has(method)) eventHandlers.set(method, []);
        eventHandlers.get(method).push(fn);
      },
      close() { try { ws.close(); } catch { /* already closed */ } },
    };
  });
}

// Poll the DevToolsActivePort file for the (random) debug port the browser
// picked, then wait until /json/version answers. Returns { port, version }.
async function waitForDevtools(userDataDir, deadline) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    await sleep(100);
    let port = null;
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, 'utf8').trim().split('\n')[0];
      if (/^\d+$/.test(first)) port = Number(first);
    }
    if (port == null) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { port, version: await r.json() };
    } catch { /* not answering yet */ }
  }
  throw new Error('headless browser did not open a DevTools port in time');
}

async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`/json/list responded ${r.status}`);
  return r.json();
}

// Evaluate an expression in a connected target and return its value. Throws a
// descriptive error if the page-side expression throws (used only where a
// failure is a real, expected-to-surface regression).
async function evalValue(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`eval exception: ${JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)}`);
  }
  return r.result?.value;
}

// Probe a service worker: what chrome API surface is reachable from CDP, AND
// the manifest fingerprint (permissions + background worker script). ALWAYS
// resolves to an object (never throws) — the page-side expression is
// self-contained and wrapped in try/catch. The manifest is the fingerprint
// used to verify a worker is really QueryHop's (webNavigation + storage
// permissions, background.js); component extensions do not carry it.
async function probeWorker(cdp) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      try {
        const has = (k) => (typeof chrome !== 'undefined' && !!chrome[k]);
        let manifest = null;
        try {
          if (has('runtime') && typeof chrome.runtime.getManifest === 'function') {
            const m = chrome.runtime.getManifest();
            const bg = m.background && m.background.service_worker;
            manifest = {
              name: m.name || null,
              permissions: Array.isArray(m.permissions) ? m.permissions : [],
              bgScript: typeof bg === 'string' ? bg : (bg && Array.isArray(bg.scripts) ? bg.scripts.join(',') : null),
              hostPerms: Array.isArray(m.host_permissions) ? m.host_permissions.length : null
            };
          }
        } catch (e) { manifest = { error: String(e) }; }
        return JSON.stringify({
          ok: true,
          chrome: (typeof chrome === 'undefined') ? 'undefined' : 'object',
          runtime: has('runtime') ? 'object' : 'missing',
          storage: (has('storage') && !!chrome.storage.local) ? 'object' : 'missing',
          webNavigation: has('webNavigation') ? 'object' : 'missing',
          manifest: manifest
        });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e) });
      }
    })()`,
    returnByValue: true,
  });
  if (r.exceptionDetails) return { ok: false, error: 'eval-exception' };
  try {
    return JSON.parse(r.result?.value ?? 'null') || { ok: false, error: 'parse-failed' };
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
}

// Does this /json/list target look like QueryHop's service worker? Matched by
// the computed unpacked-extension ID (authoritative — see above), so built-in
// component-extension workers can never be mistaken for it.
function isQueryHopWorker(t) {
  if (!t || t.type !== 'service_worker' || !t.webSocketDebuggerUrl) return false;
  if (!String(t.url).startsWith('chrome-extension://')) return false;
  try { return EXPECTED_EXT_IDS.includes(new URL(t.url).host); } catch { return false; }
}

// --- Browser phase ----------------------------------------------------------

async function runBrowserPhase(chromeBin) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'queryhop-e2e-'));
  let child;
  let swCdp = null;
  let webCdp = null;
  let browserCdp = null;
  try {
    // --enable-logging=stderr routes Chrome's own extension-load diagnostics
    // to stderr, where we can distinguish "the extension failed to load"
    // (a real regression) from "the worker is just not surfaced" (environment).
    child = spawn(
      chromeBin,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        `--load-extension=${EXTENSION_DIR}`,
        `--disable-extensions-except=${EXTENSION_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--enable-logging=stderr',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let chromeStderr = '';
    child.stderr.on('data', (d) => {
      chromeStderr = (chromeStderr + d.toString()).slice(-200_000);
    });

    const { port, version } = await waitForDevtools(userDataDir, Date.now() + LAUNCH_TIMEOUT_MS);
    const browserWs = version.webSocketDebuggerUrl;
    if (!browserWs) throw new Error(`no browser webSocketDebuggerUrl in /json/version: ${JSON.stringify(version)}`);
    browserCdp = await cdpConnect(browserWs);

    // ---- 1. Popup wiring (HARD, host-side — deterministic).
    // Headless Chrome in this environment cannot open a chrome-extension page
    // as a target (Page.navigate -> ERR_FILE_NOT_FOUND; Target.createTarget ->
    // chrome-error://), so the wiring is asserted against the file on disk,
    // which is exactly what the packaged extension ships.
    const popupPath = path.join(EXTENSION_DIR, 'popup.html');
    assert.ok(existsSync(popupPath), `popup.html missing from the extension at ${popupPath}`);
    const popupHtml = readFileSync(popupPath, 'utf8');
    const hostMissing = POPUP_REQUIRED_IDS.filter((id) => !popupHtml.includes('id="' + id + '"'));
    assert.deepEqual(hostMissing, [],
      'popup.html is missing DOM ids required by the save flow: ' + hostMissing.join(', '));
    let popupNote = 'wiring verified host-side (file + ids on disk)';

    // A real web tab, created early: it is also what wakes the lazy MV3
    // service worker (a top-frame navigation fires webNavigation.onBefore
    // Navigate before any network I/O, which instantiates the worker).
    let webTarget = (await listTargets(port)).find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('chrome-extension://'),
    );
    if (!webTarget) {
      const blank = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
      await sleep(400);
      webTarget = (await listTargets(port)).find((t) => t.targetId === blank.targetId && t.webSocketDebuggerUrl);
    }
    if (!webTarget) {
      throw new Error(`no web page target available. targets=${JSON.stringify((await listTargets(port)).map((t) => [t.url, t.type]))}`);
    }
    webCdp = await cdpConnect(webTarget.webSocketDebuggerUrl);
    await webCdp.send('Page.enable');
    await webCdp.send('Runtime.enable');

    // ---- 2. Find QueryHop's service worker, identified by its computed
    // unpacked-extension ID (never "first extension worker" — stock headless
    // Chrome lists built-in component-extension workers like Google Network
    // Speech, and one of those is what older versions of this test latched
    // onto, silently testing the wrong extension).
    let sw = null;
    const firstDeadline = Date.now() + SW_APPEAR_TIMEOUT_MS;
    while (Date.now() < firstDeadline && !sw) {
      sw = (await listTargets(port)).find(isQueryHopWorker) || null;
      if (!sw) await sleep(400);
    }

    // MV3 workers are lazy: if the worker has not appeared yet, wake it with a
    // real top-frame navigation and give it another window to show up. The
    // navigation itself is diagnostic (the extension is disabled by default,
    // so nothing is rewritten); only the EVENT matters here.
    if (!sw) {
      try {
        await webCdp.send('Page.navigate', { url: 'https://www.google.com/search?q=queryhop+wake' });
      } catch { /* rejected navigation is fine — onBeforeNavigate already fired */ }
      const wakeDeadline = Date.now() + WAKE_TIMEOUT_MS;
      while (Date.now() < wakeDeadline && !sw) {
        sw = (await listTargets(port)).find(isQueryHopWorker) || null;
        if (!sw) await sleep(400);
      }
    }

    if (!sw) {
      // The worker never surfaced, even after a real navigation to wake it.
      // Distinguish a real regression from an environmental limitation using
      // Chrome's own logs (captured via --enable-logging=stderr).
      //
      // A Chrome log line "references us" if it carries our computed extension
      // ID, or the distinctive words of our load path (the space in "QueryHop
      // Extension" may be URL-encoded to %20, but the words themselves remain).
      // Web-page console noise (e.g. Google's CAPTCHA "sorry" page) references
      // an http(s) source and neither our ID nor our path, so it is excluded by
      // construction — that noise is what previously caused a false hard-fail.
      const referencesUs = (l) =>
        EXPECTED_EXT_IDS.some((id) => l.includes(id)) ||
        (/QueryHop/.test(l) && /Resources/.test(l));
      const extensionLines = chromeStderr.split('\n').filter(referencesUs);

      // A real regression (broken manifest, a missing bg* import, or a top-level
      // throw in background.js) shows up as an extension line that is clearly a
      // failure: a load/registration error, an ERROR-level Chrome line, or an
      // uncaught JS error thrown by our own extension code.
      const FAILURE_SIG =
        /Failed to load (extension|script|package)|Manifest file is missing|service worker.{0,40}fail|fail.{0,40}service worker|Could not register|Uncaught|SyntaxError|ReferenceError|TypeError|:ERROR:|\bERROR\b/;
      const hardFailLines = extensionLines.filter((l) => FAILURE_SIG.test(l));
      if (hardFailLines.length) {
        throw new Error(`QueryHop's service worker never appeared AND Chrome logged an extension error — the manifest or module graph is broken: ${hardFailLines.slice(0, 5).map((l) => l.slice(0, 200)).join(' | ')}`);
      }

      // Environmental: this headless build does not expose the MV3 service
      // worker as a CDP target (a known headless limitation) and logged no
      // extension error. Surface the ground-truth extension lines so the
      // environment's behavior is inspectable, and pass with the boot claim
      // honestly marked unverified — the deterministic popup-wiring assert
      // above already ran.
      const truth = extensionLines.length
        ? ` Chrome logged ${extensionLines.length} line(s) about the extension (none fatal): ${extensionLines.slice(0, 3).map((l) => l.slice(0, 160)).join(' | ')}`
        : ' Chrome logged no lines about the extension (neither load success nor failure)';
      const detail = `${version.Browser || 'unknown'} — QueryHop SW not exposed as a CDP target by this headless build (even after a real navigation); boot claim UNVERIFIED (environmental) — popup wiring verified host-side.${truth} ${popupNote}`;
      writeTierFile('degraded', version.Browser, detail);
      return detail;
    }

    console.log(`[e2e] QueryHop service worker found: ${sw.url} (id ${EXPECTED_EXT_IDS.join('/')} computed from ${EXTENSION_DIR})`);
    swCdp = await cdpConnect(sw.webSocketDebuggerUrl);

    // Fingerprint check: the worker claims our ID (authoritative), but if the
    // manifest is readable it must actually be QueryHop's manifest. A mismatch
    // means something is deeply wrong and is worth failing on loudly.
    let probe = await probeWorker(swCdp);
    if (probe.manifest && !probe.manifest.error) {
      const isQueryHop =
        Array.isArray(probe.manifest.permissions) &&
        probe.manifest.permissions.includes('webNavigation') &&
        probe.manifest.permissions.includes('storage') &&
        typeof probe.manifest.bgScript === 'string' &&
        /background\.js/.test(probe.manifest.bgScript);
      assert.ok(isQueryHop,
        `worker at our extension ID carries an unexpected manifest: ${JSON.stringify(probe.manifest)}`);
    }

    // Poll the API surface briefly in case it is still binding right after
    // the wake. Never throws (probeWorker is bulletproof).
    const surfaceDeadline = Date.now() + SURFACE_TIMEOUT_MS;
    while (probe.storage !== 'object' || probe.webNavigation !== 'object') {
      if (Date.now() >= surfaceDeadline) break;
      await sleep(300);
      probe = await probeWorker(swCdp);
    }
    console.log(`[e2e] SW chrome API surface: ${JSON.stringify({ chrome: probe.chrome, runtime: probe.runtime, storage: probe.storage, webNavigation: probe.webNavigation, manifest: probe.manifest })}`);

    // Best-effort: an in-extension fetch() of popup.html — proves the file is
    // reachable through the extension's own resource resolver. Diagnostic
    // only (a missing storage-less SW context is not a regression).
    try {
      const popupFetch = JSON.parse(String(await evalValue(swCdp, `new Promise((res) => {
        const u = chrome.runtime.getURL('popup.html');
        fetch(u).then(r => r.text())
          .then(html => res(JSON.stringify({ ok: true, len: html.length, hasSave: html.includes('id="save"') })))
          .catch((e) => res(JSON.stringify({ ok: false, error: String(e) })));
      })()`)));
      popupNote += popupFetch.ok
        ? `; in-extension fetch OK (${popupFetch.len} bytes, hasSave=${popupFetch.hasSave})`
        : `; in-extension fetch unavailable (${popupFetch.error})`;
    } catch (e) {
      popupNote += `; in-extension fetch threw (${e.message}) — host-side check stands`;
    }

    // ---- 3. Behavioral net: full or degraded, depending on the surface.
    // The storage + redirect assertions are only meaningful where the SW
    // exposes chrome.storage and chrome.webNavigation to CDP.
    const fullSurface = probe.runtime === 'object' && probe.storage === 'object' && probe.webNavigation === 'object';

    if (!fullSurface) {
      const surface = { chrome: probe.chrome, runtime: probe.runtime, storage: probe.storage, webNavigation: probe.webNavigation };
      const detail = `${version.Browser || 'unknown'} — QueryHop SW booted and verified (manifest fingerprint OK); behavioral net DEGRADED (chrome surface ${JSON.stringify(surface)} not reachable from CDP in this headless build); ${popupNote}`;
      writeTierFile('degraded', version.Browser, detail);
      return detail;
    }

    const swGetSettings = () => evalValue(swCdp, `new Promise((res) => chrome.storage.local.get(
      ['extensionEnabled','customSearchUrl','debugLogEnabled','allowUnsafeMode'],
      (i) => res(JSON.stringify(i))
    ))`).then(JSON.parse);
    const swGetDebugLog = () => evalValue(swCdp, `new Promise((res) => chrome.storage.session.get(
      ['queryhopDebugLog'], (i) => res(JSON.stringify(i.queryhopDebugLog || []))
    ))`).then(JSON.parse);
    const webUrl = async () => {
      const r = await webCdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      return r.result?.value;
    };

    // ---- 3a. Write settings the popup's way; read them back through the
    // background's own storage access. If the popup and background disagreed on
    // a key, extensionEnabled would not round-trip as true.
    const written = JSON.parse(String(await evalValue(swCdp, `new Promise((res) => chrome.storage.local.set({
      customSearchUrl: ${JSON.stringify(CUSTOM_SEARCH_URL)},
      allowUnsafeMode: false,
      extensionEnabled: true,
      debugLogEnabled: true
    }, () => res(JSON.stringify({ err: chrome.runtime.lastError?.message || null }))))`)));
    assert.equal(written.err, null, `chrome.storage.local.set failed: ${written.err}`);
    await sleep(SETTLE_MS); // let storage.onChanged invalidate the background's 15s settings cache

    const settings = await swGetSettings();
    assert.equal(settings.extensionEnabled, true,
      `background read extensionEnabled=${settings.extensionEnabled} (expected true) — popup/background storage-key drift?`);
    assert.equal(settings.customSearchUrl, CUSTOM_SEARCH_URL,
      `background read customSearchUrl=${settings.customSearchUrl} (expected ${CUSTOM_SEARCH_URL})`);
    assert.equal(settings.debugLogEnabled, true, 'background read debugLogEnabled (expected true)');

    // ---- 3b. Scenario 1: extension enabled -> a Google search navigation is
    // rewritten to the custom engine and a 'redirect' entry is logged.
    // Note: once the extension's tabs.update replaces the navigation, the
    // original Page.navigate CDP call typically REJECTS (navigation aborted) —
    // that is expected and is exactly what we want to observe, so capture it.
    let navError1 = null;
    try {
      await webCdp.send('Page.navigate', { url: `https://www.google.com/search?q=${encodeURIComponent(SCENARIO1_QUERY)}` });
    } catch (e) {
      navError1 = e.message;
    }
    await sleep(REDIRECT_SETTLE_MS);

    // The load-bearing, network-independent proof is the debug-log entry: it is
    // written by the extension (appendDebugLog) BEFORE tabs.update, so it
    // records the full onBeforeNavigate -> handleNavigation -> engine-match ->
    // target-compute chain regardless of whether the tab actually reaches the
    // network. The final tab URL (the live last mile) is observed, not
    // hard-asserted — a live page load is network-dependent and would flake.
    const entries1 = await swGetDebugLog();
    const redirectEntry = entries1.find((e) => e?.event === 'redirect');
    assert.ok(redirectEntry,
      `expected a 'redirect' debug-log entry, but the log was ${JSON.stringify(entries1)}`);
    assert.match(String(redirectEntry.originalUrl), /google\.com\/search/,
      `redirect entry originalUrl=${redirectEntry.originalUrl} did not match the Google search navigation`);
    // The log redacts the q param (q -> [REDACTED]), so the exact target URL
    // can't be exact-matched from the log; confirm the redirect went to the
    // right engine's host instead. The EXACT redirected URL is observed below.
    let tu = null;
    try { tu = new URL(String(redirectEntry.targetUrl)); } catch { /* unparseable */ }
    assert.ok(tu && tu.hostname === 'duckduckgo.com',
      `redirect entry targetUrl=${redirectEntry.targetUrl} — expected the DuckDuckGo host (the custom search engine)`);
    assert.equal(String(redirectEntry.engine), 'Google',
      `redirect entry engine=${redirectEntry.engine} — expected the Google engine to match`);

    // #100: the full-tier e2e is the ONLY net that exercises the real
    // redaction path in a real browser (the unit redaction tests pin the
    // helpers but run on Node 22, not in the browser). So this gate must
    // actually check the #12 contract it exists to protect — that the raw
    // search term is ABSENT from the persisted entry. `query` is
    // fingerprinted (n=<len>,fp=<hash>), and both URLs are stripped of
    // credential/query params before the ring buffer (redactDebugEntry). A
    // regression that put the plaintext term back into the buffer / console
    // mirror — exactly the #12 contract re-hardened by #91–#97 — would
    // otherwise sail through this gate green, because the assertions above
    // only checked hosts. The term is a fixed literal, so the check is
    // cheap and deterministic. (The URL-encoded form over%20the%20moon does
    // not match the spaced literal, so a redacted URL cannot false-positive.)
    assert.ok(!JSON.stringify(redirectEntry).includes(SCENARIO1_QUERY),
      `raw search term present in debug-log entry — #12 violation: ${JSON.stringify(redirectEntry)}`);

    const finalUrl1 = String(await webUrl());
    const u1 = (() => { try { return new URL(finalUrl1); } catch { return null; } })();
    const q1 = u1 && u1.searchParams ? u1.searchParams.get('q') : null;
    if (!(u1 && u1.hostname === 'duckduckgo.com' && q1 === SCENARIO1_QUERY)) {
      console.log(`[e2e] note: tab is at ${finalUrl1}${navError1 ? `, Page.navigate rejected: ${navError1}` : ''} — expected the live redirect to ${SCENARIO1_TARGET}; the redirect LOGIC fired (see debug-log assertions).`);
    }

    // ---- 3c. Scenario 2: extension disabled -> the same navigation is NOT
    // rewritten (no new 'redirect' entry).
    const logLenBefore = entries1.length;
    const written2 = JSON.parse(String(await evalValue(swCdp, `new Promise((res) => chrome.storage.local.set({
      extensionEnabled: false
    }, () => res(JSON.stringify({ err: chrome.runtime.lastError?.message || null }))))`)));
    assert.equal(written2.err, null, `chrome.storage.local.set (disable) failed: ${written2.err}`);
    await sleep(SETTLE_MS);
    let navError2 = null;
    try {
      await webCdp.send('Page.navigate', { url: `https://www.google.com/search?q=${encodeURIComponent(SCENARIO2_QUERY)}` });
    } catch (e) {
      navError2 = e.message;
    }
    await sleep(REDIRECT_SETTLE_MS);

    const finalUrl2 = String(await webUrl());
    if (!/^https:\/\/www\.google\.com\/search\?q=/.test(finalUrl2)) {
      console.log(`[e2e] note: with the extension disabled the tab is at ${finalUrl2}${navError2 ? `, Page.navigate rejected: ${navError2}` : ''} — expected it to stay on Google (network-dependent last mile).`);
    }
    const entries2 = await swGetDebugLog();
    assert.equal(entries2.length, logLenBefore,
      `with the extension disabled, navigating to a Google search should NOT add a redirect entry (log grew ${logLenBefore} -> ${entries2.length}): ${JSON.stringify(entries2.slice(logLenBefore))}`);

    const detail = `${version.Browser || 'unknown'} — full behavioral net passed against QueryHop's own SW (redirect fired toward ${SCENARIO1_TARGET}, no redirect when disabled); ${popupNote}`;
    writeTierFile('full', version.Browser, detail);
    return detail;
  } finally {
    for (const cdp of [swCdp, webCdp, browserCdp]) {
      if (cdp) { try { cdp.close(); } catch { /* already closed */ } }
    }
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      await sleep(400);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// --- The single top-level test ---------------------------------------------

test('browser e2e: extension boots, popup wired, redirect fires (#75)', async (t) => {
  // Graceful degradation: only run the browser phase when CI opts in AND a
  // working headless browser is actually launchable. Otherwise pass with a
  // clear diagnostic so the test count stays deterministic everywhere.
  if (process.env.QHYOP_E2E_BROWSER !== '1') {
    t.diagnostic('QHYOP_E2E_BROWSER not set — skipping the real browser phase (the dedicated CI e2e job exercises it).');
    writeTierFile('skipped', null, 'QHYOP_E2E_BROWSER not set — real browser phase not run.');
    return;
  }

  const chromeBin = candidateChromeBinaries().find((b) => b && existsSync(b));
  if (!chromeBin) {
    t.diagnostic(`no Chrome/Chromium binary found among: ${candidateChromeBinaries().join(', ')} — skipping the browser phase.`);
    writeTierFile('skipped', null, `no Chrome/Chromium binary found among: ${candidateChromeBinaries().join(', ')}`);
    return;
  }

  // Best-effort launchability probe: try to bring a browser up. If it cannot
  // (e.g. a container whose Chromium crashes on startup), degrade to a pass
  // rather than a false failure — the net still runs in CI where it works.
  const probe = mkdtempSync(path.join(tmpdir(), 'queryhop-e2e-probe-'));
  const probeChild = spawn(
    chromeBin,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${probe}`,
     '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let probeOk = false;
  try {
    await waitForDevtools(probe, Date.now() + LAUNCH_TIMEOUT_MS);
    probeOk = true;
  } catch {
    probeOk = false;
  } finally {
    try { probeChild.kill('SIGKILL'); } catch { /* gone */ }
    try { rmSync(probe, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (!probeOk) {
    t.diagnostic(`${chromeBin} could not open a DevTools port within ${LAUNCH_TIMEOUT_MS}ms in this environment — skipping the browser phase (it will run in CI where headless Chrome works).`);
    writeTierFile('skipped', null, `${chromeBin} could not open a DevTools port within ${LAUNCH_TIMEOUT_MS}ms (launch probe failed).`);
    return;
  }

  const detail = await runBrowserPhase(chromeBin);
  t.diagnostic(`browser e2e OK: ${detail}`);
});
