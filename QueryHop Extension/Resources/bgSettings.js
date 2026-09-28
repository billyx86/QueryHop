//
//  bgSettings.js
//  QueryHop Extension
//
// Settings access for the background service worker (#50). A tiny TTL-cached
// wrapper over chrome.storage.local: the navigation handler reads the
// settings on every top-frame navigation, so the 15 s cache keeps the hot
// path to at most one storage read per burst of navigations.
//
// The cache also feeds the debug log: getSettings() syncs the module-level
// `debugLogEnabled` flag that bgDebugLog.js checks before persisting
// entries. Call invalidateSettingsCache() after the popup saves settings
// (the UPDATE_RULES message) so the next navigation sees fresh values.

import { DEFAULT_SEARCH_URL, ERROR_TYPES, logMessage } from './bgCommon.js';

const SETTINGS_DEFAULTS = {
  customSearchUrl: DEFAULT_SEARCH_URL,
  allowUnsafeMode: false,
  extensionEnabled: false,
  debugLogEnabled: false
};
export const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS);

let settingsCache = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 15000;

let debugLogEnabled = false;

export function isDebugLogEnabled() {
  return debugLogEnabled;
}

function chromeStorageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(items);
      }
    });
  });
}

async function getSettings() {
  const now = Date.now();
  if (settingsCache && (now - settingsCacheTime < SETTINGS_CACHE_TTL)) {
    return settingsCache;
  }

  try {
    const items = await chromeStorageGet(SETTINGS_DEFAULTS);

    if (typeof items === 'object' && items !== null) {
      settingsCache = items;
      settingsCacheTime = now;
      debugLogEnabled = Boolean(items.debugLogEnabled);
      return items;
    }

    logMessage('error', `${ERROR_TYPES.STORAGE}: Unexpected return value from storage.local.get`);
    return null;
  } catch (error) {
    logMessage('error', `${ERROR_TYPES.STORAGE}: Failed to get settings from storage`, error);
    return null;
  }
}

export function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheTime = 0;
}

export { getSettings };
