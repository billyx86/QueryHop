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

function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        setText('state-on', "QueryHop is currently enabled. Enjoy!");
        setText('state-off', "QueryHop is currently disabled. You can turn it on in the Extensions section of Safari Settings.");
        setText('state-unknown', "You can turn on QueryHop's extension in the Extensions section of Safari Settings.");
        setText('open-preferences', "Quit and Open Safari Settings\u2026");
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

// Called from the native side (ViewController.swift) when Safari Settings
// could not be opened. Shows the error inline instead of silently quitting.
function showError(message) {
    var el = document.getElementById('native-error');
    if (!el) {
        el = document.createElement('p');
        el.id = 'native-error';
        el.className = 'state-unknown';
        document.body.appendChild(el);
    }
    el.innerText = message || "Something went wrong.";
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

var openPrefsButton = document.querySelector("button.open-preferences");
if (openPrefsButton) {
    openPrefsButton.addEventListener("click", openPreferences);
}
