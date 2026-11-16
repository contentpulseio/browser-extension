// ContentPulse background: core.
const API_BASE = 'https://contentpulse.io/api/v1';
const APP_BASE_URL = 'https://app.contentpulse.io';

const PENDING_STATUSES = ['draft', 'review', 'scheduled'];

// Scheduled browser-editor publishing is deliberately opt-in. The setting is
// stored in sync storage so it follows the user's Chrome profile, while the
// fired markers below stay local to this browser profile.
const AUTO_FILL_SCHEDULED_KEY = 'cp_auto_fill_scheduled_enabled';
const AUTO_FILL_FIRED_KEY = 'cp_auto_fill_scheduled_fired';
const BADGE_ALARM_NAME = 'cp-refresh-scheduled-badge';
const AUTO_FILL_ALARM_PREFIX = 'cp-auto-fill-scheduled:';
const EXTENSION_PLATFORMS = ContentPulsePlatformAdapters.platforms;
const SCHEDULED_BADGE_REFRESH_MINUTES = 5;
const POPUP_CACHE_KEY = 'cp_popup_state_v1';
const directFillTabs = new Map();
const backgroundFillTabs = new Map();
const clipboardTokenResults = new Map();
const clipboardTokenWaiters = new Map();
const locallyPublishedScheduledIds = new Set();
const articleRequests = new Map();
let websitesRequest = null;
let scheduledBadgeArticles = [];

const CP_DEBUG = false;
const log = (...args) => {
  if (CP_DEBUG) console.log(...args);
};
const warn = (...args) => {
  if (CP_DEBUG) console.warn(...args);
};
const err = (...args) => {
  if (CP_DEBUG) console.error(...args);
};

log('[ContentPulse][bg] service worker booted');

function getStored(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, (items) => resolve(items)));
}

function getLocalStored(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (items) => resolve(items)));
}

function setLocalStored(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function recordClipboardPrepared(token, prepared) {
  const key = String(token || '').trim();
  if (!key) return { ok: false, error: 'Missing clipboard token.' };

  const value = prepared === true;
  const waiter = clipboardTokenWaiters.get(key);
  if (waiter) {
    clearTimeout(waiter.timer);
    clipboardTokenWaiters.delete(key);
    waiter.resolve(value);
  } else {
    clipboardTokenResults.set(key, value);
    setTimeout(() => clipboardTokenResults.delete(key), 10_000);
  }
  return { ok: true, prepared: value };
}

function waitForClipboardPrepared(token, timeoutMs = 3000) {
  const key = String(token || '').trim();
  if (!key) return Promise.resolve(false);
  if (clipboardTokenResults.has(key)) {
    const value = clipboardTokenResults.get(key);
    clipboardTokenResults.delete(key);
    return Promise.resolve(value);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clipboardTokenWaiters.delete(key);
      resolve(false);
    }, timeoutMs);
    clipboardTokenWaiters.set(key, { resolve, timer });
  });
}
