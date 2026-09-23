// ContentPulse background: scheduling.
function normalizeExtensionPlatform(value) {
  return ContentPulsePlatformAdapters.normalizePlatform(value);
}

function scheduledTimestamp(article) {
  const raw = article?.scheduled_date || article?.scheduled_at || null;
  if (!raw) return null;
  const timestamp = new Date(raw).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function scheduledDateKey(value) {
  if (typeof value === 'string') {
    const dateOnly = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
    if (dateOnly) return dateOnly[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function countScheduledForToday(articles, now = new Date(), suppressedIds = null) {
  const today = scheduledDateKey(now);
  return (Array.isArray(articles) ? articles : []).filter((article) => {
    const platform = normalizeExtensionPlatform(article?.platform || article?.publish_channel);
    return (
      article?.status === 'scheduled' &&
      EXTENSION_PLATFORMS.includes(platform) &&
      (!suppressedIds || !suppressedIds.has(String(article?.id || ''))) &&
      scheduledDateKey(article?.scheduled_date || article?.scheduled_at) === today
    );
  }).length;
}

function scheduledAutoFillEntries(articles, nowMs = Date.now()) {
  return (Array.isArray(articles) ? articles : [])
    .map((article) => {
      const platform = normalizeExtensionPlatform(article?.platform || article?.publish_channel);
      const timestamp = scheduledTimestamp(article);
      if (article?.status !== 'scheduled' || !article?.id || !EXTENSION_PLATFORMS.includes(platform) || timestamp === null) {
        return null;
      }
      return {
        id: String(article.id),
        platform,
        timestamp,
        when: timestamp <= nowMs ? nowMs + 1000 : timestamp,
        key: `${article.id}:${timestamp}`,
      };
    })
    .filter(Boolean);
}

function scheduledAutoFillAlarmName(contentId) {
  return `${AUTO_FILL_ALARM_PREFIX}${encodeURIComponent(String(contentId))}`;
}

async function isScheduledAutoFillEnabled() {
  const stored = await getStored([AUTO_FILL_SCHEDULED_KEY]);
  return stored[AUTO_FILL_SCHEDULED_KEY] === true;
}

async function updateScheduledBadge(articles) {
  if (!chrome.action?.setBadgeText) return;
  const currentArticles = Array.isArray(articles) ? articles : [];
  scheduledBadgeArticles = currentArticles;
  const currentScheduledIds = new Set(
    currentArticles
      .filter((article) => article?.status === 'scheduled' && article?.id)
      .map((article) => String(article.id)),
  );
  for (const id of locallyPublishedScheduledIds) {
    if (!currentScheduledIds.has(id)) locallyPublishedScheduledIds.delete(id);
  }
  const count = countScheduledForToday(currentArticles, new Date(), locallyPublishedScheduledIds);
  const text = count > 99 ? '99+' : count > 0 ? String(count) : '';
  try {
    await chrome.action.setBadgeText({ text });
    if (count > 0 && chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
    }
  } catch (e) {
    warn('[ContentPulse][bg] badge update failed', e);
  }
}

function getAllAlarms() {
  return new Promise((resolve) => {
    if (!chrome.alarms?.getAll) return resolve([]);
    chrome.alarms.getAll((alarms) => resolve(Array.isArray(alarms) ? alarms : []));
  });
}

function clearAlarm(name) {
  return new Promise((resolve) => {
    if (!chrome.alarms?.clear) return resolve(false);
    chrome.alarms.clear(name, (cleared) => resolve(cleared));
  });
}

async function getAutoFillFired() {
  const stored = await getLocalStored([AUTO_FILL_FIRED_KEY]);
  return stored[AUTO_FILL_FIRED_KEY] && typeof stored[AUTO_FILL_FIRED_KEY] === 'object'
    ? stored[AUTO_FILL_FIRED_KEY]
    : {};
}

async function markAutoFillFired(key) {
  const fired = await getAutoFillFired();
  const cutoff = Date.now() - 32 * 24 * 60 * 60 * 1000;
  const fresh = Object.fromEntries(Object.entries(fired).filter(([, value]) => Number(value) >= cutoff));
  fresh[key] = Date.now();
  await setLocalStored({ [AUTO_FILL_FIRED_KEY]: fresh });
}

async function syncScheduledAutoFillAlarms(articles, enabled) {
  const fired = enabled ? await getAutoFillFired() : {};
  const entries = enabled
    ? scheduledAutoFillEntries(articles).filter((entry) => !fired[entry.key])
    : [];
  const activeNames = new Set(entries.map((entry) => scheduledAutoFillAlarmName(entry.id)));

  for (const alarm of await getAllAlarms()) {
    if (alarm.name.startsWith(AUTO_FILL_ALARM_PREFIX) && !activeNames.has(alarm.name)) {
      await clearAlarm(alarm.name);
    }
  }

  if (!enabled || !chrome.alarms?.create) return;
  for (const entry of entries) {
    chrome.alarms.create(scheduledAutoFillAlarmName(entry.id), { when: entry.when });
  }
}

let scheduledAutomationRefresh = null;

async function refreshScheduledAutomation(force = false) {
  if (scheduledAutomationRefresh && !force) return scheduledAutomationRefresh;
  const request = (async () => {
    const result = await getArticles();
    if (!result?.ok) return result;
    await updateScheduledBadge(result.articles || []);
    await syncScheduledAutoFillAlarms(result.articles || [], await isScheduledAutoFillEnabled());
    return result;
  })().catch((e) => {
    warn('[ContentPulse][bg] scheduled automation refresh failed', e);
    return { ok: false, error: e.message };
  });
  scheduledAutomationRefresh = request;
  request.then(
    () => {
      if (scheduledAutomationRefresh === request) scheduledAutomationRefresh = null;
    },
    () => {
      if (scheduledAutomationRefresh === request) scheduledAutomationRefresh = null;
    },
  );
  return request;
}

async function setScheduledAutoFillEnabled(enabled) {
  const value = enabled === true;
  await new Promise((resolve) => chrome.storage.sync.set({ [AUTO_FILL_SCHEDULED_KEY]: value }, resolve));
  await refreshScheduledAutomation();
  return { ok: true, enabled: value };
}

async function runScheduledAutoFillAlarm(alarmName) {
  const encodedId = alarmName.slice(AUTO_FILL_ALARM_PREFIX.length);
  let contentId = '';
  try {
    contentId = decodeURIComponent(encodedId);
  } catch (e) {
    return;
  }
  if (!contentId || !(await isScheduledAutoFillEnabled())) return;

  const result = await getArticles();
  if (!result?.ok) return;
  const article = (result.articles || []).find((item) => String(item.id) === contentId);
  const platform = normalizeExtensionPlatform(article?.platform || article?.publish_channel);
  if (!article || article.status !== 'scheduled' || !EXTENSION_PLATFORMS.includes(platform)) return;

  const timestamp = scheduledTimestamp(article);
  if (timestamp === null) return;
  await markAutoFillFired(`${article.id}:${timestamp}`);
  log('[ContentPulse][bg] scheduled auto-fill ->', article.title, platform);
  openAndFill({ ...article, platform });
  await updateScheduledBadge(result.articles || []);
}
