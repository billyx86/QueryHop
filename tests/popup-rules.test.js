// Unit tests for the pure rules/validation/formatting logic in
// QueryHop Extension/Resources/popupRules.js (extracted from popup.js in
// issue #14).
//
// Run with `node --test` (see package.json). popupRules.js is deliberately
// free of DOM and chrome.* access, so no mocking is needed — this suite
// imports the module directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCKED_SCHEMES,
  DEBUG_LOG_VIEW_LIMIT,
  DEBUG_LOG_EMPTY_TEXT,
  DEBUG_LOG_COPY_NOTE,
  isBlockedScheme,
  validateSearchUrl,
  formatDebugLogEntry,
  formatDebugLogViewLines,
  formatDebugLogViewText,
  formatDebugLogForCopy,
} from '../QueryHop Extension/Resources/popupRules.js';

// ---------------------------------------------------------------------------
// isBlockedScheme
// ---------------------------------------------------------------------------
test('isBlockedScheme: rejects every denylisted scheme', () => {
  for (const scheme of BLOCKED_SCHEMES) {
    assert.equal(isBlockedScheme(`${scheme}alert(1)`), true, `should block ${scheme}`);
  }
});

test('isBlockedScheme: is case- and whitespace-insensitive', () => {
  assert.equal(isBlockedScheme('JAVASCRIPT:alert(1)'), true);
  assert.equal(isBlockedScheme('  JavaScript:alert(1)'), true);
  assert.equal(isBlockedScheme('  DATA:text/html,x'), true);
  assert.equal(isBlockedScheme('View-Source:https://example.com'), true);
});

test('isBlockedScheme: allows ordinary http/https and unknown schemes', () => {
  assert.equal(isBlockedScheme('https://example.com'), false);
  assert.equal(isBlockedScheme('http://example.com'), false);
  assert.equal(isBlockedScheme('ftp://example.com'), false);
});

test('isBlockedScheme: only matches a leading scheme, not a substring', () => {
  assert.equal(isBlockedScheme('myjavascript:foo'), false);
  assert.equal(isBlockedScheme('https://example.com/?x=javascript:alert(1)'), false);
});

test('isBlockedScheme: null / empty / non-string input are not blocked', () => {
  assert.equal(isBlockedScheme(null), false);
  assert.equal(isBlockedScheme(''), false);
  assert.equal(isBlockedScheme(undefined), false);
  assert.equal(isBlockedScheme(123), false);
});

test('isBlockedScheme: stays in sync with background.js (manual check target)', () => {
  // The popup must not be able to *configure* a scheme the background
  // worker would refuse to apply. background.js keeps the same list — if
  // the two drift, this test documents what to compare against.
  assert.deepEqual(BLOCKED_SCHEMES, [
    'javascript:',
    'vbscript:',
    'data:',
    'file:',
    'chrome-extension:',
    'safari-web-extension:',
    'about:',
    'view-source:'
  ]);
});

// ---------------------------------------------------------------------------
// validateSearchUrl — empty / safe mode
// ---------------------------------------------------------------------------
test('validateSearchUrl: empty URL is valid with the info-empty message', () => {
  const r = validateSearchUrl('', false);
  assert.equal(r.isValid, true);
  assert.equal(r.type, 'info-empty');
  assert.match(r.message, /disable redirection/);
});

test('validateSearchUrl: whitespace-only URL behaves like empty', () => {
  assert.equal(validateSearchUrl('   ', false).type, 'info-empty');
  assert.equal(validateSearchUrl(null, false).type, 'info-empty');
  assert.equal(validateSearchUrl(undefined, false).type, 'info-empty');
});

test('validateSearchUrl (safe): rejects a URL without the %s placeholder', () => {
  const r = validateSearchUrl('https://duckduckgo.com/', false);
  assert.equal(r.isValid, false);
  assert.equal(r.type, 'invalid');
  assert.match(r.message, /%s/);
});

test('validateSearchUrl (safe): rejects a URL that does not start with http(s)://', () => {
  const r = validateSearchUrl('ftp://example.com/?q=%s', false);
  assert.equal(r.isValid, false);
  assert.equal(r.type, 'invalid');
  assert.match(r.message, /http\(s\)?:\/\//);
});

test('validateSearchUrl (safe): is case-insensitive about the scheme', () => {
  assert.equal(validateSearchUrl('HTTPS://Example.com/?q=%s', false).isValid, true);
});

test('validateSearchUrl (safe): accepts a well-formed http(s) URL with %s', () => {
  const r = validateSearchUrl('https://search.brave.com/search?q=%s', false);
  assert.equal(r.isValid, true);
  assert.equal(r.type, 'valid');
  assert.equal(r.message, 'URL format valid');
});

test('validateSearchUrl (safe): accepts localhost presets (SearXNG)', () => {
  const r = validateSearchUrl('http://localhost:8080/search?q=%s', false);
  assert.equal(r.isValid, true);
  assert.equal(r.type, 'valid');
});

test('validateSearchUrl (safe): rejects a URL that fails to parse after %s substitution', () => {
  // "http://" with no host: parsing "http://testQuery" with a space in it
  // is still parseable, so use a genuinely malformed host.
  const r = validateSearchUrl('https://bad host/%s', false);
  assert.equal(r.isValid, false);
  assert.equal(r.type, 'invalid');
  assert.equal(r.message, 'Invalid URL format');
});

test('validateSearchUrl (safe): substitutes every %s occurrence, not just the first', () => {
  const r = validateSearchUrl('https://example.com/a=%s&b=%s', false);
  assert.equal(r.isValid, true);
});

// ---------------------------------------------------------------------------
// validateSearchUrl — unsafe mode
// ---------------------------------------------------------------------------
test('validateSearchUrl (unsafe): bypasses http(s) and %s requirements', () => {
  const noPlaceholder = validateSearchUrl('https://example.com/static', true);
  assert.equal(noPlaceholder.isValid, true);
  assert.equal(noPlaceholder.type, 'info-bypass');
  assert.equal(noPlaceholder.message, 'URL validation is disabled');

  const nonHttp = validateSearchUrl('myapp://open?q=1', true);
  assert.equal(nonHttp.isValid, true);
  assert.equal(nonHttp.type, 'info-bypass');
});

test('validateSearchUrl (unsafe): still rejects every denylisted scheme', () => {
  for (const scheme of BLOCKED_SCHEMES) {
    const r = validateSearchUrl(`${scheme}evil`, true);
    assert.equal(r.isValid, false, `${scheme} must stay blocked in unsafe mode`);
    assert.equal(r.type, 'invalid');
    assert.match(r.message, /not allowed, even in unsafe mode/);
  }
});

test('validateSearchUrl (unsafe): empty URL still yields info-empty, not info-bypass', () => {
  assert.equal(validateSearchUrl('', true).type, 'info-empty');
});

// ---------------------------------------------------------------------------
// formatDebugLogEntry
// ---------------------------------------------------------------------------
test('formatDebugLogEntry: formats redirect entries with engine, query and target', () => {
  const line = formatDebugLogEntry({
    time: '2026-09-19T01:23:45.123Z',
    event: 'redirect',
    engine: 'Google',
    query: 'n=12,fp=ab12cd34',
    targetUrl: 'https://search.brave.com/search?q=%s',
  });
  assert.equal(
    line,
    '[2026-09-19 01:23:45 UTC] Google: n=12,fp=ab12cd34 → https://search.brave.com/search?q=%s'
  );
});

test('formatDebugLogEntry: marks unsafe redirects with the validation-disabled note', () => {
  const line = formatDebugLogEntry({
    time: '2026-09-19T01:23:45Z',
    event: 'redirect',
    engine: 'DuckDuckGo',
    query: 'n=3,fp=ff00ee11',
    targetUrl: 'https://example.com/x',
    unsafeMode: true,
  });
  assert.ok(line.endsWith('[validation disabled]'));
});

test('formatDebugLogEntry: formats blocked_scheme entries', () => {
  const line = formatDebugLogEntry({
    time: '2026-09-19T01:23:45.123Z',
    event: 'blocked_scheme',
    targetUrl: 'javascript:alert(1)',
    originalUrl: 'https://google.com/search?q=javascript:alert(1)',
  });
  assert.ok(line.startsWith('[2026-09-19 01:23:45 UTC] BLOCKED'));
  assert.ok(line.includes('javascript:alert(1)'));
  assert.ok(line.includes('(from https://google.com/search?q=javascript:alert(1))'));
});

test('formatDebugLogEntry: time normalization depends on millisecond presence', () => {
  // Preserved quirk: a timestamp WITH milliseconds gets a " UTC" suffix;
  // one WITHOUT keeps its literal "Z". (Documented, not "fixed" — the
  // refactor is behavior-preserving.)
  const withMs = formatDebugLogEntry({ time: '2026-09-19T01:23:45.123Z', event: 'redirect', engine: 'A', query: 'q', targetUrl: 'u' });
  assert.ok(withMs.startsWith('[2026-09-19 01:23:45 UTC]'));
  const withoutMs = formatDebugLogEntry({ time: '2026-09-19T01:23:45Z', event: 'redirect', engine: 'A', query: 'q', targetUrl: 'u' });
  assert.ok(withoutMs.startsWith('[2026-09-19 01:23:45Z]'));
});

test('formatDebugLogEntry: falls back for blocked entries missing URLs', () => {
  const line = formatDebugLogEntry({ time: '2026-09-19T00:00:00Z', event: 'blocked_scheme' });
  assert.ok(line.includes('(no target)'));
  assert.ok(line.includes('(from unknown)'));
});

test('formatDebugLogEntry: falls back for unknown events to JSON', () => {
  const line = formatDebugLogEntry({ time: '2026-09-19T00:00:00Z', event: 'weird_event', x: 1 });
  assert.ok(line.includes('weird_event'));
  assert.ok(line.includes(JSON.stringify({ time: '2026-09-19T00:00:00Z', event: 'weird_event', x: 1 })));
});

test('formatDebugLogEntry: tolerates missing optional fields', () => {
  const line = formatDebugLogEntry({ time: '', event: 'redirect' });
  assert.ok(line.startsWith('[]'));
  assert.ok(line.includes('engine: q=(none)'));
});

// ---------------------------------------------------------------------------
// formatDebugLogViewLines / formatDebugLogViewText
// ---------------------------------------------------------------------------
test('formatDebugLogViewLines: newest first, capped at DEBUG_LOG_VIEW_LIMIT', () => {
  const entries = Array.from({ length: 80 }, (_, i) => ({
    time: `2026-09-19T00:0${Math.floor(i / 10)}:${String(i % 60).padStart(2, '0')}Z`,
    event: 'redirect',
    engine: 'Google',
    query: `n=${i},fp=${i}`,
    targetUrl: `https://example.com/${i}`,
  }));
  const lines = formatDebugLogViewLines(entries);
  assert.equal(lines.length, DEBUG_LOG_VIEW_LIMIT);
  // Newest (index 79) renders first, oldest of the capped window (index 30) last.
  assert.ok(lines[0].includes('https://example.com/79'));
  assert.ok(lines[lines.length - 1].includes('https://example.com/30'));
});

test('formatDebugLogViewLines: short logs pass through unchanged in order', () => {
  const entries = [
    { time: '2026-09-19T00:00:00Z', event: 'redirect', engine: 'A', query: 'q1', targetUrl: 'u1' },
    { time: '2026-09-19T00:00:01Z', event: 'redirect', engine: 'B', query: 'q2', targetUrl: 'u2' },
  ];
  const lines = formatDebugLogViewLines(entries);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('u2'));
  assert.ok(lines[1].includes('u1'));
});

test('formatDebugLogViewLines: non-array and empty input yield no lines', () => {
  assert.deepEqual(formatDebugLogViewLines([]), []);
  assert.deepEqual(formatDebugLogViewLines(null), []);
  assert.deepEqual(formatDebugLogViewLines('nope'), []);
});

test('formatDebugLogViewText: empty placeholder and joined lines', () => {
  assert.equal(formatDebugLogViewText([]), DEBUG_LOG_EMPTY_TEXT);
  const text = formatDebugLogViewText([
    { time: '2026-09-19T00:00:00Z', event: 'redirect', engine: 'A', query: 'q1', targetUrl: 'u1' },
  ]);
  assert.ok(text.includes('A: q1 → u1'));
  assert.notEqual(text, DEBUG_LOG_EMPTY_TEXT);
});

// ---------------------------------------------------------------------------
// formatDebugLogForCopy (#15)
// ---------------------------------------------------------------------------
test('formatDebugLogForCopy: empty / non-array input yields an empty string', () => {
  assert.equal(formatDebugLogForCopy([]), '');
  assert.equal(formatDebugLogForCopy(null), '');
  assert.equal(formatDebugLogForCopy(undefined), '');
  assert.equal(formatDebugLogForCopy('nope'), '');
});

test('formatDebugLogForCopy: single entry uses singular "entry"', () => {
  const text = formatDebugLogForCopy([
    { time: '2026-09-19T00:00:00Z', event: 'redirect', engine: 'A', query: 'q1', targetUrl: 'u1' },
  ]);
  assert.ok(text.startsWith('QueryHop debug log — 1 entry'));
  assert.ok(text.includes('A: q1 → u1'));
  assert.ok(text.trimEnd().endsWith(DEBUG_LOG_COPY_NOTE));
});

test('formatDebugLogForCopy: multiple entries use plural "entries"', () => {
  const text = formatDebugLogForCopy([
    { time: '2026-09-19T00:00:00Z', event: 'redirect', engine: 'A', query: 'q1', targetUrl: 'u1' },
    { time: '2026-09-19T00:00:01Z', event: 'redirect', engine: 'B', query: 'q2', targetUrl: 'u2' },
  ]);
  assert.ok(text.startsWith('QueryHop debug log — 2 entries'));
});

test('formatDebugLogForCopy: is NOT capped by the view limit', () => {
  // 80 entries: the view pane shows only the newest 50, but the export must
  // carry all of them — that is the whole point of the copy button.
  const entries = Array.from({ length: 80 }, (_, i) => ({
    time: `2026-09-19T00:0${Math.floor(i / 10)}:${String(i % 60).padStart(2, '0')}Z`,
    event: 'redirect',
    engine: 'Google',
    query: `n=${i},fp=${i}`,
    targetUrl: `https://example.com/${i}`,
  }));
  const text = formatDebugLogForCopy(entries);
  assert.ok(text.startsWith('QueryHop debug log — 80 entries'));
  assert.ok(text.includes('https://example.com/0'));  // oldest entry kept
  assert.ok(text.includes('https://example.com/79')); // newest entry kept
  // The view text for the same input is capped, the export is not.
  assert.equal(formatDebugLogViewLines(entries).length, DEBUG_LOG_VIEW_LIMIT);
  assert.notEqual(text, formatDebugLogViewText(entries));
});

test('formatDebugLogForCopy: chronological (not reversed) order', () => {
  const text = formatDebugLogForCopy([
    { time: '2026-09-19T00:00:00Z', event: 'redirect', engine: 'A', query: 'q1', targetUrl: 'u1' },
    { time: '2026-09-19T00:00:01Z', event: 'redirect', engine: 'B', query: 'q2', targetUrl: 'u2' },
  ]);
  assert.ok(text.indexOf('u1') < text.indexOf('u2'));
});

test('formatDebugLogForCopy: documents the redaction guarantee (#12)', () => {
  const text = formatDebugLogForCopy([
    { time: '2026-09-19T00:00:00Z', event: 'redirect', engine: 'A', query: 'q1', targetUrl: 'u1' },
  ]);
  assert.ok(text.includes(DEBUG_LOG_COPY_NOTE));
  assert.match(text, /redacted/);
  assert.match(text, /fingerprint/);
});
