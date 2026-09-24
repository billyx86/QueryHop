// Safely set the text of the first element matching a class name.
// Returns false (and no-ops) when the element is missing, so a DOM shape
// change can no longer throw and silently break the whole state update.
function setText(className, text) {
    var node = document.getElementsByClassName(className)[0];
    if (!node) {
        console.warn("QueryHop: could not find element with class '" + className + "'");
        return false;
    }
    node.innerText = text;
    return true;
}

// Localized strings for the host window (issue #26). AppKit picks the
// locale directory (Base.lproj vs de.lproj) for Main.html; the dynamic
// strings set from here follow the same locale via <html lang>. English is
// the fallback for unknown locales — the same pattern as t(key,
// englishFallback) in the popup's popupI18n.js. Keep this table
// strict-JSON-compatible: tests/host-window-i18n.test.js parses it as text
// and enforces en/de parity.
var MESSAGES = {
    "en": {
        "state_on": "QueryHop is currently enabled. Enjoy!",
        "state_off": "QueryHop is currently disabled. You can turn it on in the Extensions section of Safari Settings.",
        "state_unknown": "You can turn on QueryHop's extension in the Extensions section of Safari Settings.",
        "open_preferences": "Quit and Open Safari Settings\u2026",
        "native_error_prefix": "Could not open Safari Settings:",
        "native_error_fallback": "Something went wrong."
    },
    "de": {
        "state_on": "QueryHop ist derzeit aktiviert. Viel Spa\u00df!",
        "state_off": "QueryHop ist derzeit deaktiviert. Sie k\u00f6nnen es im Bereich \u201eErweiterungen\u201c der Safari-Einstellungen aktivieren.",
        "state_unknown": "Sie k\u00f6nnen die QueryHop-Erweiterung im Bereich \u201eErweiterungen\u201c der Safari-Einstellungen aktivieren.",
        "open_preferences": "Beenden und Safari-Einstellungen \u00f6ffnen\u2026",
        "native_error_prefix": "Safari-Einstellungen konnten nicht ge\u00f6ffnet werden:",
        "native_error_fallback": "Etwas ist schiefgelaufen."
    }
};

function detectLocale() {
    var lang = (document.documentElement.lang || "").toLowerCase();
    var base = lang.split("-")[0];
    return MESSAGES[base] ? base : "en";
}

function t(key) {
    var table = MESSAGES[detectLocale()];
    if (table && table[key] != null) return table[key];
    return MESSAGES["en"][key];
}

// MESSAGES is the single source of truth for every visible state string
// (#29): the static locale HTML ships the state elements empty, and they
// are filled from here on every OS version, so the copy can no longer
// drift between the two sources.
function populateStateText() {
    setText('state-on', t('state_on'));
    setText('state-off', t('state_off'));
    setText('state-unknown', t('state_unknown'));
    setText('open-preferences', t('open_preferences'));

    // Stable, localized accessible name for the button (#31): mirrors its
    // visible text so assistive tech and the DOM agree across state
    // changes.
    var openPrefsButton = document.querySelector("button.open-preferences");
    if (openPrefsButton) {
        openPrefsButton.setAttribute('aria-label', t('open_preferences'));
    }
}

function show(enabled, useSettingsInsteadOfPreferences) {
    // useSettingsInsteadOfPreferences is retained in the signature for the
    // native caller's compatibility; the settings-vs-preferences wording
    // already lives in MESSAGES.
    populateStateText();

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

// Called from the native side (ViewController.swift) when Safari Settings
// could not be opened. The native side passes only the system error
// description (already localized by AppKit); the "Could not open Safari
// Settings:" prefix comes from MESSAGES, so the whole sentence follows the
// host-window locale. Shows the error inline instead of silently quitting.
function showError(message) {
    var el = document.getElementById('native-error');
    if (!el) {
        el = document.createElement('p');
        el.id = 'native-error';
        el.className = 'state-unknown';
        // Live region so screen readers announce the error text — same
        // treatment as the state paragraphs in Main.html (#31, #33).
        el.setAttribute('role', 'status');
        // Prepend to the top of the body, above the icon
        document.body.insertBefore(el, document.body.firstChild);
    }
    el.innerText = message ? t('native_error_prefix') + " " + message : t('native_error_fallback');
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

var openPrefsButton = document.querySelector("button.open-preferences");
if (openPrefsButton) {
    openPrefsButton.addEventListener("click", openPreferences);
}

// Pre-populate the state copy at load time: if the native side cannot fetch
// the extension state (SFSafariExtensionManager errors out) show() is never
// called, and the window must still say something instead of showing an
// empty paragraph (#29).
populateStateText();
