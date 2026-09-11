const API_BASE = 'https://contentpulse.io/api/v1';

const PENDING_STATUSES = ['draft', 'review', 'scheduled'];

// Scheduled browser-editor publishing is deliberately opt-in. The setting is
// stored in sync storage so it follows the user's Chrome profile, while the
// fired markers below stay local to this browser profile.
const AUTO_FILL_SCHEDULED_KEY = 'cp_auto_fill_scheduled_enabled';
const AUTO_FILL_FIRED_KEY = 'cp_auto_fill_scheduled_fired';
const BADGE_ALARM_NAME = 'cp-refresh-scheduled-badge';
const AUTO_FILL_ALARM_PREFIX = 'cp-auto-fill-scheduled:';
const EXTENSION_PLATFORMS = ['linkedin_pulse', 'medium', 'substack'];
const SCHEDULED_BADGE_REFRESH_MINUTES = 5;
const directFillTabs = new Map();
const clipboardTokenResults = new Map();
const clipboardTokenWaiters = new Map();
const locallyPublishedScheduledIds = new Set();
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

function normalizeExtensionPlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  if (platform === 'linkedin' || platform === 'linkedin_pulse') return 'linkedin_pulse';
  if (platform === 'medium') return 'medium';
  if (platform === 'substack') return 'substack';
  return platform;
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

async function validateKey(apiKey) {
  log('[ContentPulse][bg] validating API key via /auth/me');
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });

    if (res.status === 200) {
      const body = await res.json();
      log('[ContentPulse][bg] key valid, user:', body?.user?.email);
      return { ok: true, status: 200, user: body.user ?? null, tenant: body.tenant ?? null };
    }

    warn('[ContentPulse][bg] key validation failed, status', res.status);
    return { ok: false, status: res.status, error: 'Invalid API key, please check your ContentPulse settings' };
  } catch (e) {
    log('[ContentPulse][bg] key validation network error', e);
    return { ok: false, status: 0, error: `Network error: ${e.message}` };
  }
}

async function getWebsites() {
  const { apiKey } = await getStored(['apiKey']);
  if (!apiKey) {
    return { ok: false, status: 401, error: 'No API key stored. Please connect first.' };
  }

  try {
    const url = `${API_BASE}/websites?per_page=100`;
    log('[ContentPulse][bg] GET', url);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `Failed to load websites (${res.status})` };
    }
    const body = await res.json();
    const list = Array.isArray(body?.data?.data)
      ? body.data.data
      : Array.isArray(body?.data)
        ? body.data
        : [];
    // linkedin_author is the connected profile/page name - it drives the
    // automatic "Publish as" check in the LinkedIn editor.
    const websites = list.map((w) => ({
      id: w.id,
      name: w.name || 'Untitled site',
      linkedin_author: w.linkedin_token?.author_name || null,
      linkedin_author_urn: w.linkedin_token?.author_urn || null,
    }));
    log('[ContentPulse][bg] fetched', websites.length, 'websites');
    return { ok: true, status: 200, websites };
  } catch (e) {
    log('[ContentPulse][bg] getWebsites error', e);
    return { ok: false, status: 0, error: e.message };
  }
}

async function fetchByStatus(apiKey, status, websiteId) {
  let url = `${API_BASE}/content?status=${encodeURIComponent(status)}&per_page=100&sort=scheduled_at&direction=asc&render_mode=extension`;
  if (websiteId) {
    url += `&website_id=${encodeURIComponent(websiteId)}`;
  }
  log('[ContentPulse][bg] GET', url);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Request failed (${res.status}) for status=${status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return Array.isArray(body?.data) ? body.data : [];
}

async function getArticles(websiteId) {
  const { apiKey } = await getStored(['apiKey']);
  if (!apiKey) {
    return { ok: false, status: 401, error: 'No API key stored. Please connect first.' };
  }

  try {
    const pages = await Promise.all(PENDING_STATUSES.map((status) => fetchByStatus(apiKey, status, websiteId)));
    const merged = [];
    const seen = new Set();
    for (const list of pages) {
      for (const item of list) {
        if (item && item.id && !seen.has(item.id)) {
          seen.add(item.id);
          merged.push(normalizeArticle(item));
        }
      }
    }

    merged.sort((a, b) => {
      const da = a.scheduled_date ? Date.parse(a.scheduled_date) : Infinity;
      const db = b.scheduled_date ? Date.parse(b.scheduled_date) : Infinity;
      return da - db;
    });

    log('[ContentPulse][bg] fetched', merged.length, 'pending/scheduled articles');
    return { ok: true, status: 200, articles: merged };
  } catch (e) {
    log('[ContentPulse][bg] getArticles error', e);
    return { ok: false, status: 0, error: e.message };
  }
}

// Resolve one article directly for the popup deep-link flow. The queue only
// contains pending/scheduled content, while a browser editor can carry
// ?cp=<content ULID> for a published or otherwise explicitly targeted article.
async function getArticle(contentId) {
  const { apiKey } = await getStored(['apiKey']);
  const id = String(contentId || '').trim();
  if (!apiKey) {
    return { ok: false, status: 401, error: 'No API key stored. Please connect first.' };
  }
  if (!id) {
    return { ok: false, status: 422, error: 'Missing ContentPulse article id.' };
  }

  try {
    const url = `${API_BASE}/content/${encodeURIComponent(id)}?render_mode=extension`;
    log('[ContentPulse][bg] GET direct article', url);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.data) {
      return { ok: false, status: res.status, error: body?.message || `Article request failed (${res.status})` };
    }
    return { ok: true, status: res.status, article: normalizeArticle(body.data) };
  } catch (e) {
    log('[ContentPulse][bg] direct article request failed', e);
    return { ok: false, status: 0, error: e.message };
  }
}

// Report the public URL of an article published on an extension-only channel
// (LinkedIn Pulse / Medium). These platforms have no publish API, so the URL is
// either auto-captured from the editor tab once it lands on the live article, or
// pasted manually in the popup.
async function recordPublication(contentId, platform, remoteUrl) {
  const { apiKey } = await getStored(['apiKey']);
  if (!apiKey) {
    return { ok: false, status: 401, error: 'No API key stored. Please connect first.' };
  }
  if (!contentId || !platform || !remoteUrl) {
    return { ok: false, status: 0, error: 'Missing content, platform or URL.' };
  }

  try {
    const url = `${API_BASE}/content/${encodeURIComponent(contentId)}/publications`;
    log('[ContentPulse][bg] POST', url, platform, remoteUrl);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ platform, remote_url: remoteUrl }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message =
        body?.errors?.remote_url?.[0] || body?.message || `Failed to save publish link (${res.status})`;
      warn('[ContentPulse][bg] recordPublication failed', res.status, message);
      return { ok: false, status: res.status, error: message };
    }

    log('[ContentPulse][bg] publication recorded for content', contentId);
    // Update the visible badge immediately after a share is recorded. The
    // forced refresh below then reconciles the optimistic count with the
    // backend's current scheduled queue.
    locallyPublishedScheduledIds.add(String(contentId));
    await updateScheduledBadge(scheduledBadgeArticles);
    await refreshScheduledAutomation(true);
    return { ok: true, status: res.status, publication: body?.data ?? null };
  } catch (e) {
    err('[ContentPulse][bg] recordPublication network error', e);
    return { ok: false, status: 0, error: `Network error: ${e.message}` };
  }
}

async function redditIngest(payload) {
  const { apiKey } = await getStored(['apiKey']);
  if (!apiKey) {
    return { ok: false, status: 401, error: 'No API key stored. Please connect first.' };
  }
  if (!payload) {
    return { ok: false, status: 0, error: 'No data to send.' };
  }

  try {
    const url = `${API_BASE}/reddit/ingest`;
    log('[ContentPulse][bg] POST', url);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = body?.message || `Failed to ingest Reddit data (${res.status})`;
      warn('[ContentPulse][bg] redditIngest failed', res.status, message);
      return { ok: false, status: res.status, error: message };
    }

    log('[ContentPulse][bg] Reddit data ingested', body?.data);
    return { ok: true, status: res.status, data: body?.data ?? null };
  } catch (e) {
    err('[ContentPulse][bg] redditIngest network error', e);
    return { ok: false, status: 0, error: `Network error: ${e.message}` };
  }
}

async function markCommentSent(oppId, commentUrl) {
  const { apiKey } = await getStored(['apiKey']);
  if (!apiKey) return { ok: false, error: 'Not connected' };
  if (!oppId) return { ok: false, error: 'No opportunity ID' };

  try {
    const payload = { status: 'replied' };
    if (commentUrl) payload.comment_posted_url = commentUrl;
    const res = await fetch(`${API_BASE}/reddit/opportunities/${oppId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body?.message || `Failed (${res.status})` };
  } catch (e) {
    return { ok: false, error: e.message || 'Network error' };
  }
}

function extractHeroDescription(item) {
  const version = item?.current_version || {};
  const explicit = [item?.hero_description, version.hero_description].find(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  if (explicit) return explicit.trim();

  // API responses with structured-body access expose the hero as the first
  // section. Keep this extraction tolerant of both the current {type, data}
  // shape and the older {type, description} shape.
  const sections = Array.isArray(version.body)
    ? version.body
    : Array.isArray(item?.body)
      ? item.body
      : [];
  const hero = sections.find((section) => String(section?.type || section?.block || '').toLowerCase() === 'hero');
  if (!hero || typeof hero !== 'object') return '';
  const data = hero.data && typeof hero.data === 'object' ? hero.data : hero;
  return typeof data.description === 'string' ? data.description.trim() : '';
}

function normalizeArticle(item) {
  const version = item.current_version || {};
  const title = item.title || version.title || 'Untitled';
  const bodyHtml = version.rendered_html || '';
  const heroDescription = extractHeroDescription(item);

  const scheduledDate = item.linkedin_scheduled_at || item.scheduled_at || null;
  const platform = normalizeExtensionPlatform(item.publish_channel || item.platform || '');
  const substackPublication = Array.isArray(item.publications)
    ? item.publications.find((publication) => String(publication?.platform || '').toLowerCase() === 'substack')
    : null;
  const substackDomain = [
    item.substack_domain,
    item.publish_options?.substack_domain,
    substackPublication?.remote_url,
    item.external_url,
    item.article_url,
    item.website?.substack_domain,
    item.website?.domain,
  ].map(normalizeSubstackDomain).find(Boolean) || '';

  const imageUrl = typeof version.featured_image_url === 'string' ? version.featured_image_url : null;

  const seo = {
    meta_title: typeof version.meta_title === 'string' ? version.meta_title : '',
    meta_description: typeof version.meta_description === 'string' ? version.meta_description : '',
    meta_keywords: Array.isArray(version.meta_keywords) ? version.meta_keywords : [],
    slug: typeof item.slug === 'string' ? item.slug : '',
  };

  // Prepared LinkedIn share copy (commentary + hashtags). LinkedIn forces a
  // share post when a Pulse article is published, so the popup offers this
  // text ready to paste into that dialog.
  const rawShare = item.linkedin_share_post;
  const sharePost =
    rawShare && typeof rawShare.commentary === 'string' && rawShare.commentary.trim() !== ''
      ? {
          commentary: rawShare.commentary,
          hashtags: typeof rawShare.hashtags === 'string' ? rawShare.hashtags : '',
        }
      : null;

  // Tags and categories from the API (used by Medium for "Reader Interests").
  const tags = Array.isArray(item.tags) ? item.tags.map((t) => t.name || t).filter(Boolean) : [];
  const categories = Array.isArray(item.categories) ? item.categories.map((c) => c.name || c).filter(Boolean) : [];

  return {
    id: item.id,
    title,
    status: item.status || 'draft',
    platform,
    publish_channel: item.publish_channel || null,
    scheduled_date: scheduledDate,
    excerpt: typeof version.excerpt === 'string' ? version.excerpt : '',
    hero_description: heroDescription,
    body_html: bodyHtml,
    image_url: imageUrl,
    external_url: typeof item.external_url === 'string' ? item.external_url : null,
    article_url: typeof item.article_url === 'string' ? item.article_url : null,
    share_post: sharePost,
    seo,
    tags,
    categories,
    substack_domain: substackDomain,
  };
}

function normalizeSubstackDomain(reference) {
  const value = String(reference || '').trim();
  if (!value) return '';

  // The API returns the publication slug for new articles before a remote
  // Substack URL exists.
  if (/^[a-z0-9][a-z0-9-]*$/i.test(value)) return value.toLowerCase();

  let url;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return '';
  }

  const host = String(url.hostname || '').toLowerCase();
  if (host === 'open.substack.com') {
    const match = url.pathname.match(/^\/pub\/([a-z0-9][a-z0-9-]*)\/p(?:\/|$)/i);
    return match ? match[1].toLowerCase() : '';
  }
  if (host === 'substack.com' || !host.endsWith('.substack.com')) return '';
  return host.replace(/\.substack\.com$/i, '');
}

// The article API puts charts, table renders, and other inline artwork inside
// rendered_html. LinkedIn cannot persist those remote <img src="..."> URLs in
// an article body; each image has to go through LinkedIn's own image uploader.
// Keep this parser DOM-free because it also runs in the extension service
// worker, where DOMParser is not available.
function findHeadingTextBefore(source, position) {
  const headingRe = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let heading;
  let last = '';
  while ((heading = headingRe.exec(source))) {
    if (headingRe.lastIndex > position) break;
    last = String(heading[1] || '')
      .replace(/<br\s*\/?>(\s*)/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return last;
}

function extractInlineImagePlacements(html) {
  const source = typeof html === 'string' ? html : '';
  const images = [];
  const seen = new Set();

  const decode = (value) =>
    String(value || '')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .trim();
  const text = (value) =>
    decode(String(value || '').replace(/<br\s*\/?>(\s*)/gi, ' ').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  const attr = (tag, name) => {
    const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return match ? decode(match[1]) : '';
  };
  const add = (tag, context, position) => {
    const url = attr(tag, 'src') || attr(tag, 'data-src');
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    const caption =
      text(context?.caption) ||
      attr(tag, 'data-caption') ||
      attr(tag, 'title') ||
      attr(tag, 'alt');
    const alt = attr(tag, 'alt') || text(caption);
    seen.add(url);
    const placement = { url, caption: text(caption).slice(0, 250), alt: text(alt).slice(0, 500) };
    const anchorText = findHeadingTextBefore(source, position);
    if (anchorText) placement.anchorText = anchorText;
    images.push(placement);
  };

  const figureRanges = [];
  const figureRe = /<figure\b[^>]*>([\s\S]*?)<\/figure>/gi;
  let figureMatch;
  while ((figureMatch = figureRe.exec(source))) {
    const inner = figureMatch[1] || '';
    const captionMatch = inner.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
    const context = { caption: captionMatch ? captionMatch[1] : '' };
    const imageRe = /<img\b[^>]*>/gi;
    let imageMatch;
    while ((imageMatch = imageRe.exec(inner))) add(imageMatch[0], context, figureMatch.index);
    figureRanges.push([figureMatch.index, figureRe.lastIndex]);
  }

  const imageRe = /<img\b[^>]*>/gi;
  let imageMatch;
  while ((imageMatch = imageRe.exec(source))) {
    if (!figureRanges.some(([start, end]) => imageMatch.index >= start && imageMatch.index < end)) {
      add(imageMatch[0], {}, imageMatch.index);
    }
  }
  return images;
}

function extractInlineImages(html) {
  return extractInlineImagePlacements(html).map(({ anchorText, ...image }) => image);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeLinkedInHashtags(tags) {
  const values = Array.isArray(tags) ? tags : [];
  const seen = new Set();
  const hashtags = [];

  for (const value of values) {
    const raw = String(value?.name || value || '')
      .trim()
      .replace(/^#+/, '')
      .replace(/[^\p{L}\p{N}_]+/gu, '');
    if (!raw) continue;
    const key = raw.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hashtags.push(`#${raw}`);
  }

  return hashtags;
}

// The extension renderer can receive legacy tag markup where the tag names
// are concatenated after a final "Tags" heading. LinkedIn has no article tag
// field, so keep the section in the body but make every tag a separate,
// readable hashtag. This is intentionally LinkedIn-only; Medium uses the
// tags as Reader Interests and other platforms keep their own taxonomy.
function formatLinkedInTagsHtml(bodyHtml, tags) {
  const hashtags = normalizeLinkedInHashtags(tags);
  if (!hashtags.length) return bodyHtml || '';

  const source = typeof bodyHtml === 'string' ? bodyHtml : '';
  const tagBlock = `<h2>Tags</h2>\n<p>${escapeHtml(hashtags.join(' '))}</p>\n`;
  const headingPattern = /<h[1-6]\b[^>]*>\s*(?:<[^>]+>\s*)*Tags\s*(?:<\/[^>]+>\s*)*<\/h[1-6]>[\s\S]*$/i;
  if (headingPattern.test(source)) return source.replace(headingPattern, tagBlock);

  const paragraphPattern = /<p\b[^>]*>\s*(?:<strong\b[^>]*>\s*)?Tags\s*(?:<\/strong>\s*)?<\/p>[\s\S]*$/i;
  if (paragraphPattern.test(source)) return source.replace(paragraphPattern, tagBlock);

  return `${source}${source && !/\n$/.test(source) ? '\n' : ''}${tagBlock}`;
}

function addLinkedInTitleSpacing(bodyHtml) {
  const source = typeof bodyHtml === 'string' ? bodyHtml : '';
  return `<p><br></p>${source}`;
}

function addLinkedInHeroDescription(bodyHtml, heroDescription) {
  const source = typeof bodyHtml === 'string' ? bodyHtml : '';
  const description = typeof heroDescription === 'string' ? heroDescription.trim() : '';
  if (!description) return source;

  const normalized = (value) => String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<br\s*\/?>(\s*)/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
  const heroText = normalized(description);
  if (!heroText || normalized(source).includes(heroText)) return source;

  return `<p>${escapeHtml(description)}</p>\n${source}`;
}

function cpPageFill(titleText, bodyHtml, bodyText, isFreshTab, useSystemClipboard) {
  return new Promise((resolve) => {
    const CP_DEBUG = false;
    const log = (...args) => {
      if (CP_DEBUG) console.log(...args);
    };
    const warn = (...args) => {
      if (CP_DEBUG) console.warn(...args);
    };
    const MAX_ATTEMPTS = 30;
    const INTERVAL_MS = 500;
    let attempts = 0;

    // Singleton corner toast shared across every injected step (#cp-toast):
    // each step UPDATES it in place, so notifications never stack on top of
    // each other. Progress states persist until replaced; ok/error auto-hide.
    const setToast = (msg, state) => {
      try {
        let el = document.getElementById('cp-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'cp-toast';
          el.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px;transition:background .2s;display:flex;align-items:center;gap:9px';
          document.body.appendChild(el);
        }
        if (!document.getElementById('cp-spin-style')) {
          const s = document.createElement('style');
          s.id = 'cp-spin-style';
          s.textContent = '@keyframes cp-spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(s);
        }
        el.style.background = state === 'ok' ? '#0a7d33' : state === 'error' ? '#b3261e' : '#1f2937';
        const spinner =
          state === 'progress'
            ? '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:cp-spin .7s linear infinite"></span>'
            : '';
        el.innerHTML = spinner + '<span></span>';
        el.lastChild.textContent = msg;
        if (el._cpHide) clearTimeout(el._cpHide);
        if (state !== 'progress') {
          el._cpHide = setTimeout(() => el.remove(), 3000);
        }
      } catch (e) {}
    };
    const showToast = (msg, ok) => setToast(msg, ok ? 'ok' : 'error');

    const htmlToDoc = (html) => {
      const dp = new DOMParser().parseFromString(html || '', 'text/html');
      const out = [];

      const inline = (node) => {
        const res = [];
        const walk = (n, marks) => {
          if (n.nodeType === 3) {
            const t = (n.nodeValue || '').replace(/\s+/g, ' ');
            if (t.trim() !== '') res.push(Object.assign({ type: 'text', text: t }, marks.length ? { marks: marks.slice() } : {}));
            else if (t === ' ' && res.length) res.push({ type: 'text', text: ' ' });
            return;
          }
          if (n.nodeType !== 1) return;
          const tag = n.tagName.toLowerCase();
          const m = marks.slice();
          if (tag === 'strong' || tag === 'b') m.push({ type: 'bold' });
          else if (tag === 'em' || tag === 'i') m.push({ type: 'italic' });
          else if (tag === 'code') m.push({ type: 'code' });
          else if (tag === 'a') {
            const href = n.getAttribute('href');
            if (href) m.push({ type: 'link', attrs: { href } });
          } else if (tag === 'br') {
            return;
          }
          for (const c of n.childNodes) walk(c, m);
        };
        for (const c of node.childNodes) walk(c, []);
        return res;
      };

      const para = (el) => {
        const c = inline(el);
        return c.length ? { type: 'paragraph', content: c } : { type: 'paragraph' };
      };

      const pushBlock = (el) => {
        const tag = el.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
          const lvl = Math.min(6, Math.max(1, parseInt(tag[1], 10)));
          const c = inline(el);
          out.push(Object.assign({ type: 'heading', attrs: { level: lvl } }, c.length ? { content: c } : {}));
        } else if (tag === 'p') {
          const c = inline(el);
          out.push(c.length ? { type: 'paragraph', content: c } : { type: 'paragraph' });
        } else if (tag === 'ul' || tag === 'ol') {
          const items = [];
          el.querySelectorAll(':scope > li').forEach((li) => items.push({ type: 'listItem', content: [para(li)] }));
          if (items.length) out.push({ type: tag === 'ul' ? 'bulletList' : 'orderedList', content: items });
        } else if (tag === 'blockquote') {
          out.push({ type: 'blockquote', content: [para(el)] });
        } else if (tag === 'pre') {
          out.push({ type: 'codeBlock', content: [{ type: 'text', text: el.textContent || '' }] });
        } else if (tag === 'hr') {
          out.push({ type: 'horizontalRule' });
        } else if (tag === 'figure' || tag === 'img') {
          // LinkedIn's editor cannot import remote inline images through the
          // TipTap document. Keep an empty paragraph at the original image
          // position so the later native uploader has a valid block/caret to
          // replace instead of falling through to the end of the article.
          out.push({ type: 'paragraph' });

        } else if (tag === 'table') {
          const t = (el.textContent || '').trim();
          if (t) out.push({ type: 'paragraph', content: [{ type: 'text', text: t }] });
        } else {
          const kids = Array.from(el.children);
          if (kids.length) kids.forEach(pushBlock);
          else {
            const c = inline(el);
            if (c.length) out.push({ type: 'paragraph', content: c });
          }
        }
      };

      try {
        Array.from(dp.body.children).forEach(pushBlock);
      } catch (err) {
        warn('[ContentPulse][page] htmlToDoc parse error', err);
      }
      if (!out.length) {
        const t = (dp.body.textContent || '').trim();
        if (t) out.push({ type: 'paragraph', content: [{ type: 'text', text: t }] });
      }
      return { type: 'doc', content: out.length ? out : [{ type: 'paragraph' }] };
    };

    const findQuill = (container) => {
      if (!container) return null;
      if (container.__quill && typeof container.__quill.setText === 'function') {
        return container.__quill;
      }
      for (const key of Object.keys(container)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          let fiber = container[key];
          let depth = 0;
          while (fiber && depth < 60) {
            const q = (fiber.memoizedProps && fiber.memoizedProps.quill) || (fiber.stateNode && fiber.stateNode.quill);
            if (q && typeof q.setText === 'function') return q;
            fiber = fiber.return;
            depth += 1;
          }
        }
      }
      return null;
    };

    const setViaQuill = (quill, text) => {
      try {
        quill.setText((text || '') + '\n', 'api');
        return true;
      } catch (err) {
        warn('[ContentPulse][page] quill.setText failed', err);
        return false;
      }
    };

    const setNative = (el, text) => {
      try {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        el.focus();
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (err) {
        warn('[ContentPulse][page] native set failed', err);
        return false;
      }
    };

    const selectAll = (el) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    const pasteInto = (el, text) => {
      try {
        el.focus();
        selectAll(el);
        const before = (el.textContent || '').trim().length;
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        return (el.textContent || '').trim().length > before;
      } catch (err) {
        warn('[ContentPulse][page] paste failed', err);
        return false;
      }
    };

    const setRichText = (el, text) => {
      if (pasteInto(el, text)) return true;
      el.focus();
      selectAll(el);
      try {
        if (document.execCommand('insertText', false, text) && (el.textContent || '').trim().length > 0) {
          return true;
        }
      } catch (err) {

      }
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    };

    const findTitle = () =>
      document.querySelector('#article-editor-headline__textarea, textarea.article-editor-headline__textarea') ||
      document.querySelector(
        'textarea[aria-label*="title" i], textarea[placeholder*="title" i], textarea[name*="title" i], textarea[name*="headline" i]',
      ) ||
      document.querySelector('input[aria-label*="title" i], input[placeholder*="title" i]') ||
      document.querySelector(
        '[contenteditable="true"][aria-label*="title" i], [contenteditable="true"][data-placeholder*="title" i], h1[contenteditable="true"]',
      );

    const findBodyEditor = () => {

      const explicit = document.querySelector(
        '[data-test-article-editor-content-textbox], div.ProseMirror[contenteditable="true"], .ql-editor[contenteditable="true"], .ql-editor',
      );
      if (explicit) return explicit;
      const title = findTitle();
      const candidates = Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]')).filter(
        (el) => el !== title,
      );
      let best = null;
      let bestArea = 0;
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
      return best;
    };

    const getEditorText = (tiptap, el) => {
      try {
        if (tiptap && typeof tiptap.getText === 'function') return (tiptap.getText() || '').trim();
      } catch (e) {}
      return (el && el.textContent ? el.textContent : '').trim();
    };

    const fillTitle = () => {
      const titleEl = findTitle();
      if (!titleEl) return false;
      if (titleEl.tagName === 'TEXTAREA' || titleEl.tagName === 'INPUT') {
        return setNative(titleEl, titleText || '');
      }
      const tq = findQuill(titleEl.closest('.ql-container'));
      return tq ? setViaQuill(tq, titleText || '') : setRichText(titleEl, titleText || '');
    };

    const applyTiptap = (tiptap) => {
      // JSON first: our htmlToDoc conversion matches LinkedIn's TipTap schema
      // (headings, paragraphs, lists, inline marks). Raw HTML is not parsed
      // correctly by LinkedIn's editor (it strips formatting).
      try {
        tiptap.commands.setContent(htmlToDoc(bodyHtml || ''), true);
        if (typeof tiptap.commands.focus === 'function') tiptap.commands.focus('start');
        return true;
      } catch (e1) {
        warn('[ContentPulse][page] tiptap setContent(json) failed, trying html', e1);
      }
      try {
        tiptap.commands.setContent(bodyHtml || '', true);
        if (typeof tiptap.commands.focus === 'function') tiptap.commands.focus('start');
        return true;
      } catch (e2) {
        warn('[ContentPulse][page] tiptap setContent(html) failed', e2);
        return false;
      }
    };

    const pasteHtml = (el) => {
      try {
        el.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
        const dt = new DataTransfer();
        dt.setData('text/html', bodyHtml || '');
        dt.setData('text/plain', bodyText || '');

        // ProseMirror v1.33+ uses beforeinput for paste handling
        try {
          const bi = new InputEvent('beforeinput', {
            inputType: 'insertFromPaste',
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          el.dispatchEvent(bi);
        } catch (biErr) {
          warn('[ContentPulse][page] beforeinput paste threw', biErr);
        }

        // Also dispatch legacy ClipboardEvent as fallback
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return true;
      } catch (err) {
        warn('[ContentPulse][page] paste simulation failed', err);
        return false;
      }
    };

    // LinkedIn's trusted paste handler is the path that preserves block
    // structure (headings, lists, quotes) in the current editor. A synthetic
    // ClipboardEvent is untrusted and is ignored by some LinkedIn builds, so
    // first try the browser's native paste command after the popup has placed
    // the rich HTML payload on the system clipboard. This is also the same
    // route that works when the user clicks "Copy formatted" and presses
    // Cmd/Ctrl+V manually.
    const pasteFromSystemClipboard = (el) => {
      try {
        el.focus();
        selectAll(el);
        const before = (el.textContent || '').trim().length;
        const inserted = document.execCommand('paste', false, null);
        const after = (el.textContent || '').trim().length;
        return !!inserted && after > before;
      } catch (err) {
        warn('[ContentPulse][page] native clipboard paste failed', err);
        return false;
      }
    };

    // LinkedIn's current editor is ProseMirror. It ignores the synthetic
    // ClipboardEvent above in some builds because the event is not trusted,
    // even though the same HTML works when the user clicks "Copy formatted"
    // and pastes manually. Insert the formatted fragment into the live
    // contenteditable instead; ProseMirror's DOMObserver sees the mutation
    // and imports it into its document state, just like a native rich paste.
    const insertFormattedHtml = (el) => {
      try {
        el.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);

        const fragment = range.createContextualFragment(bodyHtml || '');
        range.deleteContents();
        range.insertNode(fragment);

        const endRange = document.createRange();
        endRange.selectNodeContents(el);
        endRange.collapse(false);
        selection.removeAllRanges();
        selection.addRange(endRange);
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertFromPaste',
          data: bodyText || '',
        }));
        return true;
      } catch (err) {
        warn('[ContentPulse][page] native formatted HTML insertion failed', err);
        return false;
      }
    };

    const fillBodyNonTiptap = (bodyEl) => {
      const bodyContainer = bodyEl.closest('.ql-container');
      const bq = bodyContainer ? findQuill(bodyContainer) : null;
      if (bq && setViaQuill(bq, bodyText || '')) return 'quill';
      if (setRichText(bodyEl, bodyText || '')) return 'rich';
      return 'none';
    };

    const wipedThreshold = 20;

    let lastBodyEl = null;

    const findTiptapEditor = (el) => {
      if (!el) return null;
      if (el.editor && el.editor.commands) return el.editor;
      let parent = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.editor && parent.editor.commands) return parent.editor;
        parent = parent.parentElement;
      }
      return null;
    };

    const bodyFilled = (el) => {
      return getEditorText(findTiptapEditor(el), el).length >= wipedThreshold;
    };

    // Filling (especially pasting a long body) leaves the page scrolled to the
    // bottom; bring the user back to the title. Repeated because the editor
    // keeps adjusting scroll for a moment after content lands.
    const scrollToTop = () => {
      const doScroll = () => {
        try {
          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
          const title = findTitle();
          if (title) title.scrollIntoView({ block: 'start' });
        } catch (e) {}
      };
      doScroll();
      setTimeout(doScroll, 400);
      setTimeout(doScroll, 1200);
    };

    const finish = (bodyOk, titleOk, method, attempts) => {
      if (bodyOk) scrollToTop();
      setToast(
        bodyOk ? 'ContentPulse: Article filled successfully' : 'ContentPulse: Could not fill the editor, please try again',
        bodyOk ? 'ok' : 'error',
      );
      resolve({ ok: bodyOk, titleOk, bodyOk, method, attempts });
    };

    setToast('ContentPulse: Filling content, please wait...', 'progress');

    const GRACE_MS = 2200;
    const SETTLE_MS = 1200;
    const MAX_PASTE_ATTEMPTS = 3;

    // Empty the editor before any insert so a re-fill REPLACES the existing
    // body instead of appending below it.
    const clearBody = (el) => {
      try {
        const t = findTiptapEditor(el);
        if (t && t.commands && typeof t.commands.clearContent === 'function') {
          t.commands.clearContent(true);
          return;
        }
      } catch (err) {
        warn('[ContentPulse][page] tiptap clearContent failed', err);
      }
      try {
        el.focus();
        selectAll(el);
        document.execCommand('delete', false, null);
      } catch (err) {
        warn('[ContentPulse][page] clear via delete failed', err);
      }
    };

    const fillBodyVerified = (titleOk, attempts) => {
      let settled = false;
      let pasteTries = 0;

      const settle = (ok, method) => {
        if (settled) return;
        settled = true;
        finish(ok, titleOk, method, attempts);
      };

      // After a fill verifies, hold through a guard window: if LinkedIn's
      // draft sync wipes the content in that window, re-assert immediately so
      // the article never stays empty.
      const GUARD_MS = 4000;
      const MAX_GUARD_RETRIES = 2;
      let guardRetries = 0;

      const guardThenSettle = (method) => {
        const start = Date.now();
        const check = () => {
          if (settled) return;
          const el = findBodyEditor() || lastBodyEl;
          if (!bodyFilled(el)) {
            if (guardRetries < MAX_GUARD_RETRIES) {
              guardRetries += 1;
              log('[ContentPulse][page] content wiped during guard - silent re-assert', guardRetries);
              fillTitle();
              tryTiptap();
            } else {
              settle(bodyFilled(findBodyEditor() || lastBodyEl), method);
            }
            return;
          }
          if (Date.now() - start >= GUARD_MS) {
            settle(true, method);
            return;
          }
          setTimeout(check, 300);
        };
        check();
      };

      const verifyAfterSettle = (method, onFail) => {
        setTimeout(() => {
          if (settled) return;
          const el = findBodyEditor() || lastBodyEl;
          if (bodyFilled(el)) {
            log('[ContentPulse][page] body persisted via', method);
            guardThenSettle(method);
            return;
          }
          onFail();
        }, SETTLE_MS);
      };

      const tryTiptap = () => {
        if (settled) return;
        const el = findBodyEditor() || lastBodyEl;
        const t = findTiptapEditor(el);
        if (t && t.commands && typeof t.commands.setContent === 'function') {
          try {
            applyTiptap(t);
          } catch (err) {
            warn('[ContentPulse][page] tiptap setContent threw', err);
          }
          verifyAfterSettle('tiptap', tryPaste);
        } else if (useSystemClipboard) {
          tryClipboardPaste();
        } else {
          tryNativeHtml();
        }
      };

      const tryClipboardPaste = () => {
        if (settled) return;
        const el = findBodyEditor() || lastBodyEl;
        clearBody(el);
        if (pasteFromSystemClipboard(el)) {
          log('[ContentPulse][page] native clipboard paste attempt');
          verifyAfterSettle('clipboard-paste', tryNativeHtml);
        } else {
          tryNativeHtml();
        }
      };

      const tryNativeHtml = () => {
        if (settled) return;
        const el = findBodyEditor() || lastBodyEl;
        clearBody(el);
        if (insertFormattedHtml(el)) {
          log('[ContentPulse][page] native formatted HTML insertion attempt');
          verifyAfterSettle('native-html', tryPaste);
        } else {
          tryPaste();
        }
      };

      const tryPaste = () => {
        if (settled) return;
        pasteTries += 1;
        const el = findBodyEditor() || lastBodyEl;
        try {
          clearBody(el);
          pasteHtml(el);
        } catch (err) {
          warn('[ContentPulse][page] formatted paste threw', err);
        }
        log('[ContentPulse][page] formatted paste attempt', pasteTries);
        verifyAfterSettle('paste', () => {
          if (pasteTries < MAX_PASTE_ATTEMPTS) {
            log('[ContentPulse][page] paste did not persist — re-asserting formatted paste');
            tryPaste();
          } else {
            tryInsertHtml();
          }
        });
      };

      const tryInsertHtml = () => {
        if (settled) return;
        const el = findBodyEditor() || lastBodyEl;
        try {
          clearBody(el);
          el.focus();
          selectAll(el);
          document.execCommand('insertHTML', false, bodyHtml || '');
        } catch (err) {
          warn('[ContentPulse][page] insertHTML threw', err);
        }
        log('[ContentPulse][page] insertHTML attempt');
        verifyAfterSettle('insertHTML', tryPlainFallback);
      };

      const tryPlainFallback = () => {
        if (settled) return;
        const el = findBodyEditor() || lastBodyEl;
        try {
          clearBody(el);
          fillBodyNonTiptap(el);
        } catch (err) {
          warn('[ContentPulse][page] fallback fill threw', err);
        }
        verifyAfterSettle('fallback', () => settle(bodyFilled(findBodyEditor() || el), 'exhausted'));
      };

      tryTiptap();
    };

    const tick = () => {
      attempts += 1;
      const bodyEl = findBodyEditor();

      if (!bodyEl && attempts < MAX_ATTEMPTS) {
        setTimeout(tick, INTERVAL_MS);
        return;
      }

      if (!bodyEl) {
        setToast('ContentPulse: Could not detect LinkedIn editor, please try again', 'error');
        resolve({ ok: false, reason: 'no-body-editor', attempts });
        return;
      }

      lastBodyEl = bodyEl;

      // On a freshly opened tab the editor mounts, then bootstraps (loads the
      // draft, attaches tiptap) and REPLACES its DOM - wiping anything filled
      // too early. Wait until the editor element and its content have been
      // stable for a moment before the one and only fill.
      const waitForStableEditor = async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const STABLE_MS = 1600;
        const MAX_WAIT_MS = 15000;
        const start = Date.now();
        let el = findBodyEditor();
        let len = el ? (el.textContent || '').length : -1;
        let stableSince = Date.now();
        while (Date.now() - start < MAX_WAIT_MS) {
          await sleep(300);
          const cur = findBodyEditor();
          const curLen = cur ? (cur.textContent || '').length : -1;
          if (cur !== el || curLen !== len) {
            el = cur;
            len = curLen;
            stableSince = Date.now();
          }
          if (el && Date.now() - stableSince >= STABLE_MS) {
            // Give tiptap up to 8s to attach so the fill can go through the
            // editor's own API (immune to the bootstrap re-sync wipe).
            if (findTiptapEditor(el) || Date.now() - start >= 8000) return el;
          }
        }
        return findBodyEditor() || lastBodyEl;
      };

      // On a freshly opened tab the editor clears its content once while it
      // finishes booting. Insert a placeholder space first and wait for that
      // reset to settle, so the real fill lands on a stable editor and sticks
      // the first time.
      const primeEditor = async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        try {
          const el = findBodyEditor() || lastBodyEl;
          const t = findTiptapEditor(el);
          if (t && t.commands && typeof t.commands.setContent === 'function') {
            t.commands.setContent(
              { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }] },
              true,
            );
          } else if (el) {
            el.focus();
            document.execCommand('insertText', false, ' ');
          }
        } catch (e) {}
        const start = Date.now();
        let lastLen = -1;
        let stableSince = Date.now();
        while (Date.now() - start < 8000) {
          await sleep(200);
          const cur = findBodyEditor() || lastBodyEl;
          const len = cur ? (cur.textContent || '').length : -1;
          if (len === 0 && lastLen > 0) {
            // The boot reset cleared the placeholder - the editor is ready.
            await sleep(300);
            return;
          }
          if (len !== lastLen) {
            lastLen = len;
            stableSince = Date.now();
          }
          // Content stayed stable for a while - no reset is coming.
          if (Date.now() - stableSince >= 2500) return;
        }
      };

      setTimeout(async () => {
        const stableEl = await waitForStableEditor();
        if (stableEl) lastBodyEl = stableEl;
        if (isFreshTab) await primeEditor();
        const titleOk = fillTitle();
        fillBodyVerified(titleOk, attempts);
      }, GRACE_MS);
    };

    tick();
  });
}

function cpPageFillSeo(seoTitle, seoDescription) {
  return new Promise((resolve) => {
    const CP_DEBUG = false;
    const warn = (...args) => {
      if (CP_DEBUG) console.warn(...args);
    };
    const toast = (msg, state) => {
      try {
        let el = document.getElementById('cp-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'cp-toast';
          el.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px;display:flex;align-items:center;gap:9px';
          document.body.appendChild(el);
        }
        if (!document.getElementById('cp-spin-style')) {
          const s = document.createElement('style');
          s.id = 'cp-spin-style';
          s.textContent = '@keyframes cp-spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(s);
        }
        el.style.background = state === 'ok' ? '#0a7d33' : state === 'error' ? '#b3261e' : '#1f2937';
        el.innerHTML =
          (state === 'progress'
            ? '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:cp-spin .7s linear infinite"></span>'
            : '') + '<span></span>';
        el.lastChild.textContent = msg;
        if (el._cpHide) clearTimeout(el._cpHide);
        if (state !== 'progress') el._cpHide = setTimeout(() => el.remove(), 3000);
      } catch (e) {}
    };

    const setNative = (el, text) => {
      try {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        el.focus();
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      } catch (err) {
        warn('[ContentPulse][page] SEO native set failed', err);
        return false;
      }
    };

    const findSeoTitle = () =>
      document.querySelector(
        'input[name="seoTitle"], input[aria-label*="SEO title" i], input[placeholder*="SEO title" i]',
      );
    const findSeoDescription = () =>
      document.querySelector(
        'textarea[name="seoDescription"], textarea[aria-label*="SEO description" i], textarea[placeholder*="SEO description" i]',
      );

    const isVisible = (el) => !!(el && el.offsetParent !== null);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const waitFor = async (cond, timeoutMs, stepMs = 150) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const val = cond();
        if (val) return val;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };

    // The "Settings" item lives inside the editor's Manage menu, whose open
    // dropdown container carries a stable class. Scope the lookup to it so we
    // never match items from other dropdowns.
    const findSettingsItem = () => {
      const scope = document.querySelector('.article-editor-manage-menu__dropdown-container') || document;
      const items = scope.querySelectorAll('.artdeco-dropdown__item[role="button"], .artdeco-dropdown__item');
      for (const item of items) {
        if (isVisible(item) && item.textContent.trim().toLowerCase() === 'settings') return item;
      }
      return null;
    };

    const fillFields = () => {
      const titleEl = findSeoTitle();
      const descEl = findSeoDescription();
      if (!titleEl && !descEl) return null;

      let titleOk = false;
      let descOk = false;
      if (titleEl && (seoTitle || '').trim() !== '') {
        titleOk = setNative(titleEl, (seoTitle || '').slice(0, 60));
      }
      if (descEl && (seoDescription || '').trim() !== '') {
        descOk = setNative(descEl, (seoDescription || '').slice(0, 160));
      }
      return { titleOk, descOk };
    };

    // The settings modal's own Save (primary button in the actionbar) persists
    // the SEO fields and closes the modal.
    const clickSave = () => {
      const bar = Array.from(document.querySelectorAll('.artdeco-modal__actionbar')).find(isVisible);
      if (!bar) return false;
      const saveBtn = Array.from(bar.querySelectorAll('button.artdeco-button--primary')).find(
        (b) => isVisible(b) && /^save$/i.test((b.textContent || '').trim()),
      );
      if (!saveBtn) return false;
      saveBtn.click();
      return true;
    };

    (async () => {
      toast('ContentPulse: Filling SEO fields...', 'progress');
      // 1) Fields already on screen (settings panel open) - just fill.
      let res = fillFields();
      let openedByUs = false;

      // 2) Otherwise open the panel ourselves: click the "Settings" dropdown
      //    item, opening its parent dropdown trigger first when needed. The
      //    menu and modal are kept out of view while they are filled and
      //    saved, so no transient dialogs flash on screen.
      const hideStyle = document.createElement('style');
      hideStyle.textContent =
        '.artdeco-dropdown__content,.artdeco-modal-overlay,.artdeco-modal,.artdeco-toast-item{opacity:0 !important;}' +
        '.artdeco-modal-overlay{background:transparent !important;}';

      // LinkedIn refuses to open Settings while the article draft is being
      // persisted ("Sorry, your article is still saving."). Detect that notice
      // and keep retrying until the save finishes.
      const stillSaving = () =>
        Array.from(document.querySelectorAll('.artdeco-toast-item, [role="alert"]')).some((t) =>
          /still saving/i.test(t.textContent || ''),
        );

      if (!res) {
        openedByUs = true;
        document.documentElement.appendChild(hideStyle);

        const deadline = Date.now() + 45000;
        for (let attempt = 0; !res; attempt += 1) {
          let settingsItem = findSettingsItem();

          if (!settingsItem) {
            // Open the Manage menu directly - its trigger sits inside the
            // .article-editor-manage-menu wrapper, so no other buttons are
            // ever clicked.
            const manageTrigger = document.querySelector(
              '.article-editor-manage-menu .artdeco-dropdown__trigger, .article-editor-manage-menu button',
            );
            if (manageTrigger && isVisible(manageTrigger)) {
              manageTrigger.click();
              settingsItem = await waitFor(findSettingsItem, 2000);
            }
          }

          if (settingsItem) {
            settingsItem.click();
            await waitFor(() => findSeoTitle() || findSeoDescription(), 5000);
            res = fillFields();
          }

          if (res) break;
          // Retry only while the draft is still saving (or on the first miss);
          // anything else is a real failure.
          if (Date.now() >= deadline || (attempt >= 1 && !stillSaving())) break;
          await sleep(2500);
        }
      }

      try {
        if (!res) {
          toast('ContentPulse: Could not open the Settings (SEO) panel - open it manually, then try again', 'error');
          resolve({ ok: false, reason: 'no-seo-fields' });
          return;
        }

        // While the settings panel is open, also create/read the article's
        // permanent pulse URL so the popup can offer it as the published link.
        const findPulseUrl = () => {
          for (const p of document.querySelectorAll('p.text-body-small')) {
            const text = p.textContent.trim();
            if (/^https:\/\/www\.linkedin\.com\/pulse\/\S+$/.test(text)) return text;
          }
          return null;
        };

        let pulseUrl = findPulseUrl();
        if (!pulseUrl) {
          const createBtn = Array.from(document.querySelectorAll('button[aria-label="Create URL"]')).find(isVisible);
          if (createBtn) {
            createBtn.click();
            pulseUrl = await waitFor(findPulseUrl, 5000);
          }
        }

        const saved = clickSave();
        if (saved) await sleep(400);

        const ok = res.titleOk || res.descOk;
        toast(
          ok
            ? saved
              ? 'ContentPulse: SEO fields filled and saved'
              : 'ContentPulse: SEO fields filled - click Save in the settings panel'
            : 'ContentPulse: Could not fill the SEO fields',
          ok ? 'ok' : 'error',
        );
        resolve({ ok, titleOk: res.titleOk, descOk: res.descOk, saved, pulseUrl: pulseUrl || null });
      } finally {
        // If the modal could not be saved/closed, make it visible again so the
        // user can finish manually - never leave an invisible modal behind.
        if (openedByUs) {
          if (!clickSave()) {
            const dismiss = document.querySelector('button.artdeco-modal__dismiss, button[aria-label="Dismiss"]');
            if (dismiss && isVisible(dismiss)) dismiss.click();
          }
          await sleep(300);
          hideStyle.remove();
        }
      }
    })();
  });
}

async function pageFill(tabId, title, bodyHtml, bodyText, isFreshTab, useSystemClipboard) {
  if (!tabId) {
    return { ok: false, error: 'No tab id for page fill' };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      // Clipboard paste is privileged for the extension's isolated world.
      // Keep the existing MAIN-world path for the other editor operations,
      // but run this fill in ISOLATED when the popup prepared a rich clipboard
      // payload so document.execCommand('paste') can read it.
      world: useSystemClipboard ? 'ISOLATED' : 'MAIN',
      func: cpPageFill,
      args: [title || '', bodyHtml || '', bodyText || '', !!isFreshTab, !!useSystemClipboard],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] pageFill result', result);
    return result || { ok: false, error: 'No result from page fill' };
  } catch (e) {
    log('[ContentPulse][bg] pageFill executeScript error', e);
    return { ok: false, error: e.message };
  }
}

// ── Medium page fill ───────────────────────────────────────────────
// Runs in the page (MAIN world). Medium's editor is a single contenteditable
// div (.postArticle-content.editable) with graf elements inside. Title is the
// first line; body follows. Direct DOM writes break the internal model, so we
// paste via clipboard and let Medium's own handler process the HTML.
function cpMediumPageFill(titleText, bodyHtml, bodyText, imageMeta) {
  return new Promise((resolve) => {
    const CP_DEBUG = false;
    const log = (...args) => { if (CP_DEBUG) console.log('[ContentPulse][medium-page]', ...args); };

    const EDITOR_SELECTORS = [
      '.postArticle-content.editable[contenteditable="true"]',
      'div.js-postField[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"][g_editable="true"]',
      'div.editable[role="textbox"][contenteditable="true"]',
    ];

    const findEditor = () => {
      for (const s of EDITOR_SELECTORS) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      return null;
    };

    const waitFor = async (condition, timeoutMs, stepMs = 200) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = condition();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, stepMs));
      }
    };

    const setEditableText = (el, value) => {
      const text = String(value || '').slice(0, 500);
      try {
        el.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, text);
        if ((el.textContent || '').trim() !== text.trim()) {
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, text);
        }
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text,
        }));
        return (el.textContent || '').replace(/\u00a0/g, ' ').trim() === text.trim();
      } catch (e) {
        log('editable text fill failed', e);
        return false;
      }
    };

    const getImageFigures = (editor) =>
      Array.from(editor.querySelectorAll('figure[data-testid="editorImageParagraph"], figure.graf--figure')).filter(
        (figure) => figure.querySelector('img.graf-image, img'),
      );

    const fillImageMetadata = async (editor) => {
      const meta = Array.isArray(imageMeta) ? imageMeta : [];
      if (!meta.length) return { imageCount: 0, captionsSet: 0, altTextSet: 0 };

      const figures = await waitFor(() => {
        const found = getImageFigures(editor);
        return found.length >= meta.length ? found.slice(0, meta.length) : null;
      }, 30000);
      if (!figures) {
        log('image metadata wait timed out', { expected: meta.length });
        return { imageCount: getImageFigures(editor).length, captionsSet: 0, altTextSet: 0 };
      }

      let captionsSet = 0;
      let altTextSet = 0;
      for (let index = 0; index < figures.length; index += 1) {
        // Medium replaces the selected figure after caption/alt-text saves;
        // always resolve the current node instead of retaining a stale DOM
        // reference from the initial query.
        const figure = getImageFigures(editor)[index];
        if (!figure) continue;
        const item = meta[index] || {};
        const caption = String(item.caption || '').trim().slice(0, 250);
        const alt = String(item.alt || item.caption || '').trim().slice(0, 500);
        const captionField = figure.querySelector('figcaption.imageCaption, figcaption[contenteditable="true"]');
        if (caption && captionField && setEditableText(captionField, caption)) captionsSet += 1;

        // Medium exposes alt text from the selected-image toolbar. Fill it via
        // the same UI so the value is stored in Medium's model, not just on
        // the DOM image element.
        if (alt) {
          const currentFigure = getImageFigures(editor)[index] || figure;
          const image = currentFigure.querySelector('img.graf-image, img');
          if (image) {
            try { image.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
            image.click();
          }
          const altButton = await waitFor(
            () => Array.from(document.querySelectorAll('button[data-action="alt"]')).find((button) => button.offsetParent !== null),
            5000,
          );
          if (altButton) {
            altButton.click();
            const altEditor = await waitFor(
              () => document.querySelector('.js-textAreaEditor[contenteditable="true"][role="textbox"]'),
              5000,
            );
            if (altEditor && setEditableText(altEditor, alt)) {
              const saveButton = await waitFor(
                () => Array.from(document.querySelectorAll('button')).find((button) => button.offsetParent !== null && /^save$/i.test((button.textContent || '').trim())),
                3000,
              );
              if (saveButton) {
                saveButton.click();
                await new Promise((resolve) => setTimeout(resolve, 250));
                if ((image.alt || '').trim() === alt) altTextSet += 1;
              }
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { imageCount: figures.length, captionsSet, altTextSet };
    };

    const setToast = (msg, kind) => {
      let el = document.getElementById('contentpulse-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'contentpulse-toast';
        Object.assign(el.style, {
          position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
          maxWidth: '360px', padding: '12px 16px', borderRadius: '8px',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          fontSize: '14px', color: '#fff', boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
          transition: 'opacity 0.3s',
        });
        document.body.appendChild(el);
      }
      el.style.background = kind === 'ok' ? '#52227a' : kind === 'error' ? '#c0392b' : '#555';
      el.textContent = msg;
      el.style.opacity = '1';
      if (kind !== 'progress') setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 4000);
    };

    setToast('ContentPulse: Filling content, please wait...', 'progress');

    const MAX_WAIT = 20;
    let attempts = 0;
    const tick = () => {
      attempts += 1;
      const editorEl = findEditor();
      log('probe', attempts, { found: !!editorEl });

      if (!editorEl && attempts < MAX_WAIT) {
        setTimeout(tick, 500);
        return;
      }

      if (!editorEl) {
        setToast('ContentPulse: Could not detect Medium editor, please try again', 'error');
        resolve({ ok: false, reason: 'no-editor', attempts });
        return;
      }

      try {
        // Build full HTML: title as H3 + body. Medium treats the first block
        // as the title automatically.
        const fullHtml = titleText ? `<h3>${titleText}</h3>${bodyHtml}` : bodyHtml;
        const fullText = titleText ? `${titleText}\n\n${bodyText || ''}` : (bodyText || '');

        editorEl.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editorEl);
        sel.removeAllRanges();
        sel.addRange(range);

        const dt = new DataTransfer();
        dt.setData('text/html', fullHtml);
        dt.setData('text/plain', fullText);
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        editorEl.dispatchEvent(evt);

        (async () => {
          const metadata = await fillImageMetadata(editorEl);
          setToast(
            metadata.imageCount
              ? `ContentPulse: Article filled with ${metadata.imageCount} image${metadata.imageCount === 1 ? '' : 's'} and SEO text`
              : 'ContentPulse: Article filled successfully',
            'ok',
          );
          resolve({ ok: true, attempts, ...metadata });
        })();
      } catch (e) {
        log('fill error', e);
        setToast('ContentPulse: Could not fill the editor, please try again', 'error');
        resolve({ ok: false, error: e.message, attempts });
      }
    };
    tick();
  });
}

async function mediumPageFill(tabId, title, bodyHtml, bodyText, imageMeta) {
  if (!tabId) return { ok: false, error: 'No tab id for Medium page fill' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpMediumPageFill,
      args: [title || '', bodyHtml || '', bodyText || '', imageMeta || []],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] mediumPageFill result', result);
    return result || { ok: false, error: 'No result from Medium page fill' };
  } catch (e) {
    log('[ContentPulse][bg] mediumPageFill error', e);
    return { ok: false, error: e.message };
  }
}

// ── Substack page fill ──────────────────────────────────────────────
// Runs in the page (MAIN world). Substack's editor has textarea inputs for
// title/subtitle and a TipTap/ProseMirror contenteditable for the body.
function cpSubstackPageFill(titleText, subtitleText, bodyHtml, bodyText, expectedImageCount, tags) {
  return new Promise((resolve) => {
    const CP_DEBUG = false;
    const log = (...args) => { if (CP_DEBUG) console.log('[ContentPulse][substack-page]', ...args); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (condition, timeoutMs, stepMs = 250) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = condition();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };

    const BODY_SELECTORS = [
      'div.tiptap.ProseMirror[data-testid="editor"]',
      'div.tiptap.ProseMirror.mousetrap[contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
    ];

    const findEditor = () => {
      for (const s of BODY_SELECTORS) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      return null;
    };

    const setTextareaValue = (textarea, value) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(textarea, value);
      else textarea.value = value;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const substackTags = (Array.isArray(tags) ? tags : [])
      .map((tag) => String(tag?.name || tag || '').trim())
      .filter(Boolean)
      .slice(0, 10);

    // Substack exposes tags only after Continue/Settings opens the Post
    // settings dialog. Arm this watcher before returning from the editor fill
    // so the user's Continue click is handled automatically, including SPA
    // renders where the combobox is mounted later in the same document.
    const armTagFill = () => {
      if (!substackTags.length || !document.documentElement) return;
      let observer = null;
      let stopTimer = null;
      let filling = false;
      let finished = false;

      const findTagInput = () => document.querySelector(
        'input[role="combobox"][placeholder="Select or create tags"], input[placeholder="Select or create tags"]',
      );

      const setNativeInput = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const finish = () => {
        finished = true;
        observer?.disconnect();
        document.removeEventListener('click', onClick, true);
        if (stopTimer) clearTimeout(stopTimer);
      };

      const fillTags = async () => {
        if (finished || filling) return 0;
        filling = true;
        try {
          let filled = 0;
          for (const tag of substackTags) {
            const input = await waitFor(findTagInput, 2500);
            if (!input) break;
            input.focus();
            setNativeInput(input, tag);

            const normalizedTag = tag.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
            const option = await waitFor(
              () => Array.from(document.querySelectorAll('[role="option"]')).find(
                (candidate) => candidate.textContent.replace(/\s+/g, ' ').trim().toLocaleLowerCase() === normalizedTag,
              ),
              2500,
              150,
            );
            if (option) {
              option.click();
            } else {
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            }
            filled += 1;
            await sleep(350);
          }

          if (filled === substackTags.length) {
            setToast(`ContentPulse: Filled ${filled} Substack tags`, 'ok');
            finish();
          }
          return filled;
        } finally {
          filling = false;
        }
      };

      const onClick = (event) => {
        const button = event.target?.closest?.('button');
        if (button && /^continue$/i.test((button.textContent || '').trim())) {
          setTimeout(() => fillTags(), 900);
        }
      };

      observer = new MutationObserver(() => {
        if (findTagInput()) fillTags();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener('click', onClick, true);
      setTimeout(() => fillTags(), 500);
      stopTimer = setTimeout(finish, 90000);
    };

    const setToast = (msg, kind) => {
      let el = document.getElementById('contentpulse-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'contentpulse-toast';
        Object.assign(el.style, {
          position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
          maxWidth: '360px', padding: '12px 16px', borderRadius: '8px',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          fontSize: '14px', color: '#fff', boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
          transition: 'opacity 0.3s',
        });
        document.body.appendChild(el);
      }
      el.style.background = kind === 'ok' ? '#52227a' : kind === 'error' ? '#c0392b' : '#555';
      el.textContent = msg;
      el.style.opacity = '1';
      if (kind !== 'progress') setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 4000);
    };

    armTagFill();

    setToast('ContentPulse: Filling content, please wait...', 'progress');

    // Fill title
    const titleEl = document.querySelector('textarea[data-testid="post-title"], textarea.page-title');
    if (titleEl && titleText) {
      setTextareaValue(titleEl, titleText);
      log('title filled');
    }

    // Fill subtitle
    const subtitleEl = document.querySelector('textarea.subtitle, textarea[placeholder*="subtitle"]');
    if (subtitleEl && subtitleText) {
      setTextareaValue(subtitleEl, subtitleText);
      log('subtitle filled');
    }

    // Fill body
    const MAX_WAIT = 20;
    let attempts = 0;
    const tick = () => {
      attempts += 1;
      const editorEl = findEditor();
      log('probe', attempts, { found: !!editorEl });

      if (!editorEl && attempts < MAX_WAIT) {
        setTimeout(tick, 500);
        return;
      }

      if (!editorEl) {
        setToast('ContentPulse: Could not detect Substack editor, please try again', 'error');
        resolve({ ok: false, reason: 'no-editor', attempts });
        return;
      }

      try {
        editorEl.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editorEl);
        sel.removeAllRanges();
        sel.addRange(range);

        const dt = new DataTransfer();
        dt.setData('text/html', bodyHtml);
        dt.setData('text/plain', bodyText || '');
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        editorEl.dispatchEvent(evt);

        const expected = Math.max(0, Number(expectedImageCount) || 0);
        const waitForImages = async () => {
          const deadline = Date.now() + (expected ? 30000 : 800);
          for (;;) {
            const imageCount = editorEl.querySelectorAll('img').length;
            if (imageCount >= expected || Date.now() >= deadline) return imageCount;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        };
        waitForImages().then((imageCount) => {
          setToast(
            imageCount
              ? `ContentPulse: Article filled with ${imageCount} image${imageCount === 1 ? '' : 's'}`
              : 'ContentPulse: Article filled successfully',
            'ok',
          );
          resolve({ ok: true, attempts, imageCount, expectedImageCount: expected });
        });
      } catch (e) {
        log('fill error', e);
        setToast('ContentPulse: Could not fill the editor, please try again', 'error');
        resolve({ ok: false, error: e.message, attempts });
      }
    };
    tick();
  });
}

async function substackPageFill(tabId, title, subtitle, bodyHtml, bodyText, expectedImageCount, tags) {
  if (!tabId) return { ok: false, error: 'No tab id for Substack page fill' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpSubstackPageFill,
      args: [title || '', subtitle || '', bodyHtml || '', bodyText || '', expectedImageCount || 0, tags || []],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] substackPageFill result', result);
    return result || { ok: false, error: 'No result from Substack page fill' };
  } catch (e) {
    log('[ContentPulse][bg] substackPageFill error', e);
    return { ok: false, error: e.message };
  }
}

// Substack's thumbnail picker can render its input before the upload handler
// is ready. If the thumbnail event is rejected, keep the featured image in
// the article itself instead of silently losing it. The collapsed selection
// at the start is important: a normal paste would append the image at the end.
function cpSubstackInsertHeroAtStart(imageUrl, altText, captionText) {
  return new Promise(async (resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (condition, timeoutMs, stepMs = 250) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = condition();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };
    const editor = await waitFor(
      () => document.querySelector(
        'div.tiptap.ProseMirror[data-testid="editor"], div.tiptap.ProseMirror.mousetrap[contenteditable="true"], div.ProseMirror[contenteditable="true"]',
      ),
      10000,
    );
    if (!editor || !imageUrl) {
      resolve({ ok: false, reason: 'substack-editor-not-found' });
      return;
    }

    try {
      const before = editor.querySelectorAll('img').length;
      const escape = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      const html = `<figure><img src="${escape(imageUrl)}" alt="${escape(altText || 'Featured image')}"><figcaption>${escape(captionText || '')}</figcaption></figure>`;
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/html', html);
      dataTransfer.setData('text/plain', captionText || altText || 'Featured image');
      editor.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }));

      const deadline = Date.now() + 30000;
      let imageCount = before;
      while (Date.now() < deadline) {
        imageCount = editor.querySelectorAll('img').length;
        if (imageCount > before) break;
        await sleep(250);
      }
      resolve({ ok: imageCount > before, imageCount, reason: imageCount > before ? undefined : 'hero-body-insert-not-confirmed' });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

async function substackInsertHeroAtStart(tabId, imageUrl, altText, captionText) {
  if (!tabId || !imageUrl) return { ok: false, error: 'Missing tab or hero image URL' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpSubstackInsertHeroAtStart,
      args: [imageUrl, altText || '', captionText || ''],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] substack hero fallback result', result);
    return result || { ok: false, error: 'No result from Substack hero fallback' };
  } catch (e) {
    log('[ContentPulse][bg] substack hero fallback error', e);
    return { ok: false, error: e.message };
  }
}

// ── Substack cover image upload ────────────────────────────────────
// Runs in Substack's MAIN world. The thumbnail input is already mounted in the
// current editor as #file-sidebar-file-input; assign the fetched bytes directly
// so no native file picker is needed.
function cpFillSubstackThumbnail(b64, mime, seoTitle, seoDescription) {
  return new Promise(async (resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (condition, timeoutMs, stepMs = 200) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = condition();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };
    const setNative = (el, value) => {
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) return false;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === value;
    };

    try {
      const input = await waitFor(
        () => document.querySelector('#file-sidebar-file-input, input[type="file"][accept*="image"]'),
        10000,
      );
      if (!input) {
        resolve({ ok: false, reason: 'thumbnail-file-input-not-found' });
        return;
      }

      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      let file = new File([bytes], `contentpulse-thumbnail.${ext}`, { type: mime });

      // ContentPulse commonly serves WebP, while Substack's thumbnail
      // processor is more reliable with JPEG/PNG. Convert unsupported formats
      // in the page before assigning the FileList to Substack's input.
      if (mime !== 'image/jpeg' && mime !== 'image/png' && typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(file);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          const converted = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
          bitmap.close?.();
          if (converted) file = new File([converted], 'contentpulse-thumbnail.jpg', { type: 'image/jpeg' });
        } catch (conversionError) {
          // Keep the original file as a fallback for browsers that cannot
          // decode the source format; Substack will report the upload result.
        }
      }

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

      // These are Substack's current file-sidebar fields. They provide useful
      // title/description metadata for the thumbnail and improve its SEO and
      // accessibility even though the thumbnail has no visible caption field.
      const titleOk = setNative(
        document.querySelector('input[placeholder="Add a title..."]'),
        String(seoTitle || '').slice(0, 500),
      );
      const descriptionOk = setNative(
        document.querySelector('textarea[placeholder="Add a description..."]'),
        String(seoDescription || '').slice(0, 500),
      );
      const preview = await waitFor(() => {
        const scope = document.querySelector('.post-editor-file-edit-sidebar') || document;
        return Array.from(scope.querySelectorAll('img')).find((img) => (img.currentSrc || img.src || '').length > 0) || null;
      }, 20000, 250);
      resolve({
        ok: !!preview,
        method: 'thumbnail-file-input',
        preview: !!preview,
        titleOk,
        descriptionOk,
        reason: preview ? undefined : 'thumbnail-upload-not-confirmed',
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

async function substackCoverImage(tabId, imageUrl, seoTitle, seoDescription) {
  if (!tabId || !imageUrl) return { ok: false, error: 'Missing tab or image URL' };
  try {
    const { b64, mime } = await fetchImageAsBase64(imageUrl);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpFillSubstackThumbnail,
      args: [b64, mime, seoTitle || '', seoDescription || ''],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] substackCoverImage result', result);
    return result || { ok: false, error: 'No result' };
  } catch (e) {
    log('[ContentPulse][bg] substackCoverImage error', e);
    return { ok: false, error: e.message };
  }
}

// Runs in the page (MAIN world) on medium.com/p/<id>/settings.
// Fills "Reader Interests" tags, SEO title, SEO description, and canonical URL.
function cpMediumSettingsFill(topicNames, seoTitle, seoDescription, canonicalUrl) {
  return new Promise((resolve) => {
    const CP_DEBUG = false;
    const log = (...args) => { if (CP_DEBUG) console.log('[ContentPulse][medium-settings]', ...args); };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const setToast = (msg, kind) => {
      let el = document.getElementById('contentpulse-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'contentpulse-toast';
        Object.assign(el.style, {
          position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
          maxWidth: '360px', padding: '12px 16px', borderRadius: '8px',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          fontSize: '14px', color: '#fff', boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
          transition: 'opacity 0.3s',
        });
        document.body.appendChild(el);
      }
      el.style.background = kind === 'ok' ? '#52227a' : kind === 'error' ? '#c0392b' : '#555';
      el.textContent = msg;
      el.style.opacity = '1';
      if (kind !== 'progress') setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 4000);
    };

    const waitFor = async (cond, timeoutMs, stepMs = 300) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const val = cond();
        if (val) return val;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };

    const setNative = (el, value) => {
      const isTextarea = el.tagName === 'TEXTAREA';
      const proto = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    (async () => {
      setToast('ContentPulse: Filling Medium settings...', 'progress');
      let filledTags = 0;
      let filledSeoTitle = false;
      let filledSeoDescription = false;
      let filledCanonical = false;

      // ── Fill tags (Reader Interests) ──
      // Medium's tag input: input[role="combobox"] with placeholder "Add a topic..."
      // inside #reader_interests.
      if (topicNames && topicNames.length > 0) {
        const topics = topicNames.slice(0, 5);
        log('filling topics', topics);

        const findTagInput = () => {
          const container = document.getElementById('reader_interests');
          if (container) {
            const inp = container.querySelector('input[role="combobox"]') || container.querySelector('input');
            if (inp) return inp;
          }
          const inputs = document.querySelectorAll('input[role="combobox"], input[placeholder*="topic" i]');
          return inputs.length > 0 ? inputs[0] : null;
        };

        const tagInput = await waitFor(findTagInput, 8000);
        if (tagInput) {
          for (const topic of topics) {
            tagInput.focus();
            setNative(tagInput, topic);

            // Wait for suggestions dropdown, then pick the first matching option.
            await sleep(700);

            const suggestion = await waitFor(() => {
              const menu = document.getElementById('tagMultiSelectMenu')
                || document.querySelector('[role="listbox"]');
              if (menu) {
                const first = menu.querySelector('[role="option"], li, button');
                if (first) return first;
              }
              return null;
            }, 2500, 200);

            if (suggestion) {
              suggestion.click();
              filledTags++;
              log('clicked suggestion for', topic);
            } else {
              tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              tagInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              filledTags++;
              log('pressed Enter for', topic);
            }
            await sleep(500);
          }
        } else {
          log('tag input not found');
        }
      }

      // ── Fill SEO Title ──
      if (seoTitle && seoTitle.trim()) {
        log('filling SEO title', seoTitle);
        const seoSection = document.getElementById('seo_settings');
        if (seoSection) {
          const seoTitleInput = seoSection.querySelector('input[type="text"], input:not([type])');
          if (seoTitleInput) {
            seoTitleInput.focus();
            setNative(seoTitleInput, seoTitle.slice(0, 60));
            filledSeoTitle = true;
            log('SEO title filled');

            await sleep(500);

            // The Save button sits in a sibling div within the shared
            // wrapper (.mi or the nearest ancestor containing both the
            // input and the button). Walk up to find a container that
            // holds a <button> with "Save" text.
            let saveBtn = null;
            let ancestor = seoTitleInput.parentElement;
            for (let i = 0; i < 6 && ancestor; i++) {
              const btns = ancestor.querySelectorAll('button');
              for (const b of btns) {
                if ((b.textContent || '').trim() === 'Save') { saveBtn = b; break; }
              }
              if (saveBtn) break;
              ancestor = ancestor.parentElement;
            }
            if (saveBtn) {
              saveBtn.click();
              log('SEO title saved');
              await sleep(800);
            } else {
              log('SEO title Save button not found');
            }
          }
        }
      }

      // ── Fill SEO Description ──
      if (seoDescription && seoDescription.trim()) {
        log('filling SEO description', seoDescription);
        const seoSection = document.getElementById('seo_settings');
        if (seoSection) {
          const seoDescTextarea = seoSection.querySelector('textarea');
          if (seoDescTextarea) {
            seoDescTextarea.focus();
            setNative(seoDescTextarea, seoDescription.slice(0, 156));
            filledSeoDescription = true;
            log('SEO description filled');

            await sleep(500);

            let saveBtn = null;
            let ancestor = seoDescTextarea.parentElement;
            for (let i = 0; i < 6 && ancestor; i++) {
              const btns = ancestor.querySelectorAll('button');
              for (const b of btns) {
                if ((b.textContent || '').trim() === 'Save') { saveBtn = b; break; }
              }
              if (saveBtn) break;
              ancestor = ancestor.parentElement;
            }
            if (saveBtn) {
              saveBtn.click();
              log('SEO description saved');
              await sleep(800);
            } else {
              log('SEO description Save button not found');
            }
          }
        }
      }

      // ── Fill canonical URL ──
      if (canonicalUrl && canonicalUrl.trim()) {
        log('filling canonical URL', canonicalUrl);
        const findCanonicalInput = () => {
          const headings = document.querySelectorAll('h2, h3, label');
          for (const h of headings) {
            const txt = (h.textContent || '').toLowerCase();
            if (txt.includes('canonical') || txt.includes('originally published')) {
              const container = h.closest('div.lo, div.e, section, fieldset');
              if (container) {
                const inp = container.querySelector('input');
                if (inp) return inp;
              }
            }
          }
          return null;
        };

        const canonicalInput = await waitFor(findCanonicalInput, 5000);
        if (canonicalInput) {
          canonicalInput.focus();
          setNative(canonicalInput, canonicalUrl);
          canonicalInput.dispatchEvent(new Event('blur', { bubbles: true }));
          filledCanonical = true;
          log('canonical URL filled');
        } else {
          log('canonical URL input not found');
        }
      }

      const parts = [];
      if (filledTags > 0) parts.push(`${filledTags} tag${filledTags > 1 ? 's' : ''}`);
      if (filledSeoTitle) parts.push('SEO title');
      if (filledSeoDescription) parts.push('SEO description');
      if (filledCanonical) parts.push('canonical URL');

      if (parts.length > 0) {
        setToast(`ContentPulse: Filled ${parts.join(', ')}`, 'ok');
        resolve({ ok: true, filledTags, filledSeoTitle, filledSeoDescription, filledCanonical });
      } else {
        setToast('ContentPulse: No settings fields could be filled', 'error');
        resolve({ ok: false, filledTags: 0, filledSeoTitle: false, filledSeoDescription: false, filledCanonical: false });
      }
    })();
  });
}

async function mediumSettingsFill(tabId, topicNames, seoTitle, seoDescription, canonicalUrl) {
  if (!tabId) return { ok: false, error: 'No tab id for Medium settings fill' };
  const hasTopics = topicNames && topicNames.length > 0;
  const hasSeo = (seoTitle && seoTitle.trim()) || (seoDescription && seoDescription.trim());
  const hasCanonical = canonicalUrl && canonicalUrl.trim();
  if (!hasTopics && !hasSeo && !hasCanonical) {
    return { ok: true, skipped: true };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpMediumSettingsFill,
      args: [topicNames || [], seoTitle || '', seoDescription || '', canonicalUrl || ''],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] mediumSettingsFill result', result);
    return result || { ok: false, error: 'No result from Medium settings fill' };
  } catch (e) {
    log('[ContentPulse][bg] mediumSettingsFill error', e);
    return { ok: false, error: e.message };
  }
}

// After filling the Medium editor, navigate to the settings page and fill
// tags, SEO fields, and canonical URL. The settings URL is derived from the
// draft URL: /p/<id>/edit → /p/<id>/settings.
async function mediumAfterFill(tabId, tags, categories, canonicalUrl, seoTitle, seoDescription) {
  const topicNames = tags.length > 0 ? tags : categories;
  const hasWork = topicNames.length > 0 || canonicalUrl || (seoTitle && seoTitle.trim()) || (seoDescription && seoDescription.trim());
  if (!hasWork) return;

  // Wait for Medium to auto-save the draft. Poll for the "Draft Saved"
  // indicator in the editor's metabar; fall back to a generous timeout.
  const draftSaved = await new Promise((resolve) => {
    let elapsed = 0;
    const check = async () => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const el = document.querySelector('.js-metabarMessage');
            return el ? el.textContent : '';
          },
          args: [],
        });
        const text = (results && results[0] ? results[0].result : '') || '';
        if (text.toLowerCase().includes('saved')) {
          resolve(true);
          return;
        }
      } catch (_) { /* ignore */ }
      elapsed += 1000;
      if (elapsed >= 8000) {
        resolve(false);
        return;
      }
      setTimeout(check, 1000);
    };
    setTimeout(check, 1500);
  });
  log('[ContentPulse][bg] draft saved status:', draftSaved);

  const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
  if (!tabInfo?.url) return;

  // Extract the draft ID from the URL.
  const draftMatch = tabInfo.url.match(/medium\.com\/p\/([a-f0-9]+)\/edit/);
  const newStoryMatch = tabInfo.url.match(/medium\.com\/new-story/);

  let settingsUrl;
  if (draftMatch) {
    settingsUrl = `https://medium.com/p/${draftMatch[1]}/settings`;
  } else if (newStoryMatch) {
    // Still on /new-story - click "More actions" → "More settings" via DOM.
    log('[ContentPulse][bg] still on new-story, trying DOM navigation to settings');
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const btn = document.querySelector('.js-moreActionsButton, button[data-action="show-post-actions-popover"]');
          if (btn) btn.click();
        },
        args: [],
      });
      await new Promise((r) => setTimeout(r, 1000));
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const link = document.querySelector('a[href*="/settings"]');
          if (link) link.click();
        },
        args: [],
      });
      // Wait for navigation to settings page.
      await new Promise((resolve) => {
        let navListener;
        const navTimeout = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(navListener);
          resolve();
        }, 8000);
        navListener = (tid, changeInfo) => {
          if (tid !== tabId || changeInfo.status !== 'complete') return;
          if (changeInfo.url && changeInfo.url.includes('/settings')) {
            clearTimeout(navTimeout);
            chrome.tabs.onUpdated.removeListener(navListener);
            setTimeout(resolve, 1000);
          }
        };
        chrome.tabs.onUpdated.addListener(navListener);
      });
      await mediumSettingsFill(tabId, topicNames.slice(0, 5), seoTitle, seoDescription, canonicalUrl);
      return;
    } catch (e) {
      log('[ContentPulse][bg] DOM navigation to settings failed', e);
      return;
    }
  } else {
    return;
  }

  log('[ContentPulse][bg] navigating to Medium settings', settingsUrl);
  await chrome.tabs.update(tabId, { url: settingsUrl });

  // Wait for the settings page to fully load.
  await new Promise((resolve) => {
    let loadListener;
    const loadTimeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(loadListener);
      resolve();
    }, 10000);
    loadListener = (tid, changeInfo) => {
      if (tid !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(loadTimeout);
      chrome.tabs.onUpdated.removeListener(loadListener);
      setTimeout(resolve, 1500);
    };
    chrome.tabs.onUpdated.addListener(loadListener);
  });

  await mediumSettingsFill(tabId, topicNames.slice(0, 5), seoTitle, seoDescription, canonicalUrl);
}

// ── End Medium page fill ───────────────────────────────────────────

// Runs in the page (MAIN world). Makes sure the LinkedIn article editor's
// "Publish as" entity matches the wanted name (personal profile or a company
// page). Opens the actor toggle, picks the matching radio, saves, verifies.
function cpEnsurePublisher(entityName) {
  return new Promise((resolve) => {
    const wanted = (entityName || '').trim().toLowerCase();
    if (!wanted) {
      resolve({ ok: true, skipped: true });
      return;
    }

    const isVisible = (el) => !!(el && el.offsetParent !== null);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const waitFor = async (cond, timeoutMs, stepMs = 150) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const val = cond();
        if (val) return val;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };

    const toast = (msg, state) => {
      try {
        let el = document.getElementById('cp-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'cp-toast';
          el.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px;display:flex;align-items:center;gap:9px';
          document.body.appendChild(el);
        }
        if (!document.getElementById('cp-spin-style')) {
          const s = document.createElement('style');
          s.id = 'cp-spin-style';
          s.textContent = '@keyframes cp-spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(s);
        }
        el.style.background = state === 'ok' ? '#0a7d33' : state === 'error' ? '#b3261e' : '#1f2937';
        el.innerHTML =
          (state === 'progress'
            ? '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:cp-spin .7s linear infinite"></span>'
            : '') + '<span></span>';
        el.lastChild.textContent = msg;
        if (el._cpHide) clearTimeout(el._cpHide);
        if (state !== 'progress') el._cpHide = setTimeout(() => el.remove(), 3000);
      } catch (e) {}
    };

    // Keep the transient entity selector out of view while it is driven so it
    // does not flash on screen. It renders as an artdeco DROPDOWN
    // (.artdeco-dropdown__content), not a modal, so cover both.
    const hideTransients = () => {
      const style = document.createElement('style');
      style.setAttribute('data-cp-hidden', '');
      style.textContent =
        '.artdeco-dropdown__content,.artdeco-modal-overlay,.artdeco-modal,[role="dialog"],[role="alertdialog"]' +
        '{opacity:0 !important;pointer-events:none;}' +
        '.artdeco-modal-overlay{background:transparent !important;}';
      document.documentElement.appendChild(style);
      return () => style.remove();
    };

    const currentAuthor = () => {
      const el = document.querySelector('.article-editor-actor-toggle__author-title');
      return el ? norm(el.textContent) : '';
    };

    const findEntityRadio = () => {
      const radios = document.querySelectorAll('button[role="radio"].article-editor-entity-selector-item__item-button');
      for (const radio of radios) {
        if (isVisible(radio) && norm(radio.textContent).includes(wanted)) return radio;
      }
      return null;
    };

    // While the selector is open, harvest name -> URN for every entity (the
    // radio input ids embed the URN). The background caches these so future
    // fills can open the editor as /article/new/?author=<urn> directly and
    // skip this whole click dance.
    const collectEntities = () => {
      const map = {};
      document
        .querySelectorAll('button[role="radio"].article-editor-entity-selector-item__item-button input[type="radio"]')
        .forEach((input) => {
          const urn = (input.id || '').replace('article-editor-entity-selector-item-radio-', '');
          const btn = input.closest('button[role="radio"]');
          const name = btn ? norm(btn.textContent) : '';
          if (name && urn.startsWith('urn:')) map[name] = urn;
        });
      return map;
    };

    (async () => {
      if (currentAuthor() === wanted || currentAuthor().includes(wanted)) {
        resolve({ ok: true, already: true, author: currentAuthor() });
        return;
      }

      toast('ContentPulse: Selecting publisher...', 'progress');
      const restoreTransients = hideTransients();
      const dismissDialog = () => {
        const dismiss = document.querySelector('button.artdeco-modal__dismiss, button[aria-label="Dismiss"]');
        if (dismiss && isVisible(dismiss)) dismiss.click();
      };

      try {
        // Open the actor toggle (the author chip with the caret in the header).
        // On a freshly opened editor the toggle and the entity list render late,
        // so wait for the trigger and retry the open once before giving up.
        const findTrigger = () => {
          const titleEl = document.querySelector('.article-editor-actor-toggle__author-lockup-title');
          return (
            (titleEl && (titleEl.closest('button, [role="button"]') || titleEl)) ||
            document.querySelector('.article-editor-actor-toggle button, .article-editor-actor-toggle [role="button"]')
          );
        };

        let entities = {};
        let radio = findEntityRadio();
        for (let attempt = 0; !radio && attempt < 2; attempt += 1) {
          const trigger = await waitFor(findTrigger, 10000);
          if (!trigger) {
            toast('ContentPulse: Could not find the publisher selector', 'error');
            resolve({ ok: false, reason: 'no-toggle' });
            return;
          }
          try {
            trigger.scrollIntoView({ block: 'center' });
          } catch (e) {}
          trigger.click();
          radio = await waitFor(findEntityRadio, 8000);
          Object.assign(entities, collectEntities());
          if (!radio) {
            // The dialog may have opened before the entity list loaded; close it
            // and try once more from scratch.
            dismissDialog();
            await sleep(600);
          }
        }
        Object.assign(entities, collectEntities());

        if (!radio) {
          dismissDialog();
          toast(`ContentPulse: "${entityName}" is not in your Publish as list`, 'error');
          resolve({ ok: false, reason: 'entity-not-found', entities });
          return;
        }

        if (radio.getAttribute('aria-checked') !== 'true') {
          radio.click();
          await sleep(250);
        }

        // Apply the choice: prefer an explicit Save/Done button, otherwise the
        // selection applies on click and we just dismiss the dialog.
        const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
        const saveBtn = buttons.find((b) => ['save', 'done', 'apply', 'next'].includes(norm(b.textContent)));
        if (saveBtn) {
          saveBtn.click();
        } else {
          dismissDialog();
        }

        await waitFor(() => currentAuthor().includes(wanted), 3000);
        const ok = currentAuthor().includes(wanted);
        toast(
          ok
            ? `ContentPulse: Publishing as ${entityName}`
            : `ContentPulse: Check the publisher - could not confirm "${entityName}"`,
          ok ? 'ok' : 'error',
        );
        resolve({ ok, author: currentAuthor(), entities });
      } finally {
        // Never leave an invisible dialog stranded on the page.
        await sleep(400);
        dismissDialog();
        restoreTransients();
      }
    })();
  });
}

// Fetches the article's featured image in the service worker (extension host
// permissions apply, no page CORS) and returns raw base64 + mime type. The
// injected page script rebuilds the bytes itself - fetch(data:) is blocked by
// LinkedIn's CSP, so no data URLs cross into the page.
async function fetchImageAsBase64(imageUrl, requestHeaders = null) {
  const res = await fetch(imageUrl, requestHeaders ? { headers: requestHeaders } : undefined);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const blob = await res.blob();
  const mime = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return { b64: btoa(binary), mime };
}

// Structured tables are intentionally exposed by a separate endpoint because
// they are rendered on demand as PNGs. Pull those PNGs through the same
// authenticated service-worker path used for charts so a platform never sees
// an unauthenticated table download URL.
async function fetchTableImages(contentId) {
  if (!contentId) return [];

  const { apiKey } = await getStored(['apiKey']);
  if (!apiKey) return [];

  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  try {
    const listUrl = `${API_BASE}/content/${encodeURIComponent(contentId)}/tables`;
    const listRes = await fetch(listUrl, { headers });
    if (!listRes.ok) {
      warn('[ContentPulse][bg] table list failed', listRes.status);
      return [];
    }

    const payload = await listRes.json();
    const tables = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.data?.data)
        ? payload.data.data
        : [];
    const assets = [];

    for (let index = 0; index < tables.length; index += 1) {
      const table = tables[index];
      const downloadUrl = typeof table?.download_url === 'string' ? table.download_url.trim() : '';
      if (!downloadUrl) continue;

      try {
        const { b64, mime } = await fetchImageAsBase64(downloadUrl, headers);
        const title = String(table.title || `Table ${index + 1}`).trim().slice(0, 250);
        assets.push({
          url: downloadUrl,
          b64,
          mime,
          caption: title,
          alt: `Table: ${title}`.slice(0, 500),
          table: true,
          sectionIndex: Number.isFinite(Number(table.section_index)) ? Number(table.section_index) : null,
        });
      } catch (error) {
        warn('[ContentPulse][bg] table image download failed', downloadUrl, error);
      }
    }

    log('[ContentPulse][bg] downloaded table images', assets.length);
    return assets;
  } catch (error) {
    warn('[ContentPulse][bg] table asset lookup failed', error);
    return [];
  }
}

function replaceTablesWithImageFigures(html, tableImages) {
  const source = typeof html === 'string' ? html : '';
  const assets = Array.isArray(tableImages) ? tableImages.filter((asset) => asset?.b64 && asset?.mime) : [];
  let index = 0;

  return source.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
    const asset = assets[index++];
    if (!asset) return tableHtml;
    const src = `data:${asset.mime};base64,${asset.b64}`;
    return `<figure data-contentpulse-table="true"><img src="${escapeHtml(src)}" alt="${escapeHtml(asset.alt || asset.caption || '')}"><figcaption>${escapeHtml(asset.caption || '')}</figcaption></figure>`;
  });
}

// Medium's current editor has no native table block and flattens pasted table
// markup into ordinary text. Convert any available table renders first, then
// remove any table that could not be rendered so unsupported markup never
// reaches the editor.
function replaceTablesWithImageFiguresForMedium(html, tableImages) {
  const converted = replaceTablesWithImageFigures(html, tableImages);
  return converted.replace(/<table\b[\s\S]*?<\/table>/gi, '');
}

// LinkedIn has no table block type. Its body paste must not contain the
// original table markup because LinkedIn will flatten it into ordinary text
// before the dedicated uploader has a chance to place the generated PNG.
// Keep the table-image metadata from the original source and remove only the
// table markup from the body that is pasted into LinkedIn.
function removeTablesForLinkedIn(html) {
  const source = typeof html === 'string' ? html : '';
  return source.replace(/<table\b[\s\S]*?<\/table>/gi, '');
}

// Return metadata in the same order as the source body. This matters on
// Medium, where captions and alt text are applied to figures by position.
function buildInlineImageMeta(html, tableImages) {
  const source = typeof html === 'string' ? html : '';
  const assets = Array.isArray(tableImages) ? tableImages.filter(Boolean) : [];
  const remoteImages = extractInlineImagePlacements(source);
  const metadata = [];
  let remoteIndex = 0;
  let tableIndex = 0;
  const tokenRe = /<table\b[\s\S]*?<\/table>|<img\b[^>]*>/gi;
  let match;

  while ((match = tokenRe.exec(source))) {
    const token = match[0] || '';
    if (/^<table\b/i.test(token)) {
      if (assets[tableIndex]) {
        const anchorText = findHeadingTextBefore(source, match.index);
        metadata.push(anchorText ? { ...assets[tableIndex], anchorText } : assets[tableIndex]);
      }
      tableIndex += 1;
      continue;
    }

    const candidate = remoteImages[remoteIndex++];
    if (candidate) metadata.push(candidate);
  }

  return metadata;
}

// Runs in the page (MAIN world). Drops the featured image into LinkedIn's
// cover-image file input (#media-editor-file-selector__file-input) via a
// DataTransfer so the editor treats it like a manual upload.
function cpFillCoverImage(b64, mime, creditText) {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const toast = (msg, state) => {
      try {
        let el = document.getElementById('cp-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'cp-toast';
          el.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px;display:flex;align-items:center;gap:9px';
          document.body.appendChild(el);
        }
        if (!document.getElementById('cp-spin-style')) {
          const s = document.createElement('style');
          s.id = 'cp-spin-style';
          s.textContent = '@keyframes cp-spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(s);
        }
        el.style.background = state === 'ok' ? '#0a7d33' : state === 'error' ? '#b3261e' : '#1f2937';
        el.innerHTML =
          (state === 'progress'
            ? '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:cp-spin .7s linear infinite"></span>'
            : '') + '<span></span>';
        el.lastChild.textContent = msg;
        if (el._cpHide) clearTimeout(el._cpHide);
        if (state !== 'progress') el._cpHide = setTimeout(() => el.remove(), 3000);
      } catch (e) {}
    };

    const waitFor = async (cond, timeoutMs, stepMs = 200) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const val = cond();
        if (val) return val;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };

    const isVisible = (el) => !!(el && el.offsetParent !== null);
    const findInput = () => document.getElementById('media-editor-file-selector__file-input');

    // "Upload from computer" makes LinkedIn call click()/showPicker() on its
    // file input, which pops the native OS file dialog. We inject the file
    // ourselves, so swallow those calls while we drive the flow.
    const suppressFilePicker = () => {
      const origClick = HTMLInputElement.prototype.click;
      const origShowPicker = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.click = function (...args) {
        if (this.type === 'file') return undefined;
        return origClick.apply(this, args);
      };
      if (origShowPicker) {
        HTMLInputElement.prototype.showPicker = function (...args) {
          if (this.type === 'file') return undefined;
          return origShowPicker.apply(this, args);
        };
      }
      return () => {
        HTMLInputElement.prototype.click = origClick;
        if (origShowPicker) HTMLInputElement.prototype.showPicker = origShowPicker;
      };
    };

    (async () => {
      // A cover image is already in place - re-uploading would stack the
      // media editor on top of it. Tell the user how to refill instead.
      const existingCover = document.querySelector(
        'img.article-editor-cover-image-v2__image, img[class*="cover-image"]',
      );
      if (existingCover && isVisible(existingCover) && (existingCover.getAttribute('src') || '').length > 0) {
        toast('ContentPulse: Cover image already set - remove it in the editor to refill', 'error');
        resolve({ ok: true, skipped: true, reason: 'cover-exists' });
        return;
      }

      const restorePicker = suppressFilePicker();
      toast('ContentPulse: Adding cover image...', 'progress');
      try {
        // The file input only exists once the media editor is open; the cover
        // placeholder's "Upload from computer" button opens it.
        let input = findInput();
        if (!input) {
          const uploadBtn = Array.from(document.querySelectorAll('button[aria-label="Upload from computer"]')).find(
            isVisible,
          );
          if (uploadBtn) {
            uploadBtn.click();
            input = await waitFor(findInput, 8000);
          }
        }
        if (!input) {
          toast('ContentPulse: Cover image area not found - add the image manually', 'error');
          resolve({ ok: false, reason: 'no-file-input' });
          return;
        }

        // Decode base64 locally - fetch('data:...') is blocked by LinkedIn's CSP.
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        const file = new File([bytes], `cover.${ext}`, { type: mime });

        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // The media editor asks for a confirmation; press its Next button.
        // Only the media-editor dialog's own footer button counts - the article
        // editor's top-nav "Next" (.article-editor-nav__publish) starts the
        // posting flow and must never be clicked here.
        const nextBtn = await waitFor(() => {
          const dialog = Array.from(document.querySelectorAll('[role="dialog"], .media-editor, [class*="media-editor"]')).find(
            (d) => isVisible(d) && d.querySelector('.share-box-footer__primary-btn'),
          );
          if (!dialog) return null;
          const btn = dialog.querySelector('button.share-box-footer__primary-btn');
          if (!btn || btn.classList.contains('article-editor-nav__publish')) return null;
          if (!/next/i.test(btn.textContent || btn.getAttribute('aria-label') || '')) return null;
          return isVisible(btn) && !btn.disabled ? btn : null;
        }, 8000);
        if (nextBtn) nextBtn.click();

        // Confirming the upload scrolls the page down to the media area;
        // bring the user straight back to the top. Repeated because the
        // editor keeps adjusting scroll while the image settles in.
        const scrollTop = () => {
          try {
            window.scrollTo(0, 0);
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
          } catch (e) {}
        };
        if (nextBtn) {
          scrollTop();
          setTimeout(scrollTop, 400);
          setTimeout(scrollTop, 1200);
          setTimeout(scrollTop, 2500);
        }

        // Once the cover is in place an "Add credit and caption" control shows
        // under it; open it and fill the caption field with the article credit.
        // LinkedIn keeps the editor blocked while it processes the upload -
        // the cover <img> exists but its src stays empty until processing is
        // done - so wait for a real src before touching the credit control.
        let creditOk = false;
        if (nextBtn && (creditText || '').trim()) {
          toast('ContentPulse: Adding image credit...', 'progress');
          // The processed cover image is the readiness signal: until LinkedIn
          // finishes the upload, the cover <img> has no src and the whole
          // editor rejects clicks ("still saving"), so the credit control
          // cannot work. Wait for a real, visible src first.
          const coverImg = await waitFor(() => {
            const img = document.querySelector('img.article-editor-cover-image-v2__image, img[class*="cover-image"]');
            return img && isVisible(img) && (img.getAttribute('src') || '').length > 0 ? img : null;
          }, 60000);
          await sleep(800);

          // The credit is an INLINE textarea rendered under the cover image
          // (article-editor-cover-image-v2__caption, maxlength 150) - no
          // button/dialog involved. Fill it natively; LinkedIn saves on
          // input/blur.
          const findCreditField = () => {
            const candidates = Array.from(
              document.querySelectorAll(
                'textarea.article-editor-cover-image-v2__caption, textarea[placeholder*="credit" i], textarea[aria-label*="credit" i], textarea[placeholder*="caption" i], textarea[aria-label*="caption" i]',
              ),
            ).filter(isVisible);
            return candidates[0] || null;
          };

          const creditValue = creditText.trim().slice(0, 150);
          for (let attempt = 0; coverImg && !creditOk && attempt < 3; attempt += 1) {
            const field = await waitFor(findCreditField, 8000);
            if (!field) {
              await sleep(1500);
              continue;
            }
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            field.focus();
            setter.call(field, creditValue);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            field.dispatchEvent(new Event('blur', { bubbles: true }));
            await sleep(300);
            if ((field.value || '').trim() !== creditValue) {
              await sleep(1000);
              continue;
            }
            creditOk = true;
          }
        }

        if (nextBtn) {
          scrollTop();
          setTimeout(scrollTop, 500);
        }

        toast(
          nextBtn
            ? creditOk
              ? 'ContentPulse: Cover image and credit added'
              : 'ContentPulse: Cover image added'
            : 'ContentPulse: Image loaded - confirm it with Next',
          nextBtn ? 'ok' : 'error',
        );
        resolve({ ok: true, confirmed: !!nextBtn, creditOk });
      } catch (e) {
        toast('ContentPulse: Could not add the cover image', 'error');
        resolve({ ok: false, error: e.message });
      } finally {
        restorePicker();
      }
    })();
  });
}

async function pageFillCoverImage(tabId, imageUrl, credit) {
  if (!tabId || !imageUrl) {
    return { ok: true, skipped: true };
  }
  try {
    const { b64, mime } = await fetchImageAsBase64(imageUrl);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpFillCoverImage,
      args: [b64, mime, credit || ''],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] pageFillCoverImage result', result);
    return result || { ok: false, error: 'No result from cover image fill' };
  } catch (e) {
    log('[ContentPulse][bg] pageFillCoverImage error', e);
    return { ok: false, error: `Could not download the image (${e.message}). Try "Download image" and add it manually.` };
  }
}

// Runs in LinkedIn's page. Inline images use a different uploader from the
// cover image: the toolbar opens an "Add image or video" dialog, then the
// resulting figure exposes a native textarea for its caption.
function cpFillInlineImage(b64, mime, captionText, anchorText) {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (cond, timeoutMs, stepMs = 200) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = cond();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };
    // LinkedIn renders the article toolbar in a fixed/sticky layer. For those
    // controls offsetParent is legitimately null even while the element is
    // visible and clickable, so offsetParent is not a valid visibility test.
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        Number(style.opacity || 1) > 0
      );
    };
    const editor = () => document.querySelector('[data-test-article-editor-content-textbox], div.ProseMirror[contenteditable="true"]');
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const imageButton = () =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => visible(button) && button.querySelector('svg[data-test-icon="image-medium"], use[href="#image-medium"]'),
      );
    const imageDialog = () =>
      Array.from(document.querySelectorAll('[role="dialog"], .artdeco-modal')).find(
        (el) => visible(el) && /add image or video/i.test(el.textContent || ''),
      );
    const restorePicker = (() => {
      const originalClick = HTMLInputElement.prototype.click;
      const originalShowPicker = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.click = function (...args) {
        if (this.type === 'file') return undefined;
        return originalClick.apply(this, args);
      };
      if (originalShowPicker) {
        HTMLInputElement.prototype.showPicker = function (...args) {
          if (this.type === 'file') return undefined;
          return originalShowPicker.apply(this, args);
        };
      }
      return () => {
        HTMLInputElement.prototype.click = originalClick;
        if (originalShowPicker) HTMLInputElement.prototype.showPicker = originalShowPicker;
      };
    })();

    (async () => {
      try {
        const body = editor();
        const button = imageButton();
        if (!body || !button) {
          resolve({ ok: false, reason: 'inline-image-toolbar-not-found' });
          return;
        }

        // Place the image after the source section's heading. Falling back to
        // the end keeps older/plain articles working when no matching heading
        // is present. If that section already has an imported image, insert
        // after it so repeated images retain source order.
        let insertionPlaceholder = null;
        let insertionReference = null;
        const setInsertionPoint = () => {
          const wanted = normalizeText(anchorText);
          const headings = Array.from(body.querySelectorAll('h1, h2, h3, h4, h5, h6')).reverse();
          const captionHint = normalizeText(captionText);
          // Some rendered article variants omit the source-side anchor while
          // keeping the chart title in the caption. Prefer that exact title
          // match so a stale/missing anchor cannot send the image elsewhere.
          const headingByCaption = captionHint
            ? headings
                .filter((el) => {
                  const headingText = normalizeText(el.textContent);
                  return headingText && captionHint.includes(headingText);
                })
                .sort((a, b) => normalizeText(b.textContent).length - normalizeText(a.textContent).length)[0]
            : null;
          const heading = headingByCaption || (wanted ? headings.find((el) => normalizeText(el.textContent) === wanted) : null);
          let insertionNode = heading;
          let placeholder = null;
          if (heading) {
            let sibling = heading.nextElementSibling;
            while (sibling && !/^H[1-6]$/i.test(sibling.tagName)) {
              if (sibling.matches('figure.article-editor-figure-image')) insertionNode = sibling;
              else if (!placeholder && sibling.matches('p') && !normalizeText(sibling.textContent)) placeholder = sibling;
              sibling = sibling.nextElementSibling;
            }
            if (!placeholder && insertionNode === heading) {
              // Older drafts were filled before image slots were preserved.
              // Create the same empty paragraph a user creates by pressing
              // Enter below the heading, then activate it before uploading.
              placeholder = document.createElement('p');
              placeholder.className = 'article-editor-paragraph is-empty';
              placeholder.innerHTML = '<br>';
              heading.parentNode.insertBefore(placeholder, heading.nextSibling);
              body.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                composed: true,
                inputType: 'insertParagraph',
              }));
            }
          }
          const range = document.createRange();
          if (placeholder && insertionNode === heading) {
            // Mimic the reliable manual flow: click the new line, focus the
            // editor, then put the caret inside that line. LinkedIn's uploader
            // uses this live selection bookmark when the dialog opens.
            placeholder.scrollIntoView({ block: 'center', inline: 'nearest' });
            placeholder.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            placeholder.click();
            placeholder.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            body.focus();
            range.selectNodeContents(placeholder);
            range.collapse(true);
          } else if (insertionNode) {
            range.setStartAfter(insertionNode);
          } else {
            range.selectNodeContents(body);
            range.collapse(false);
          }
          range.collapse(true);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          body.focus();
          const selectedNode = selection.anchorNode;
          if (placeholder && insertionNode === heading && !(placeholder.contains(selectedNode) || selectedNode === placeholder)) {
            return false;
          }
          insertionPlaceholder = placeholder;
          insertionReference = insertionNode;
          return !!heading;
        };

        if (!setInsertionPoint()) {
          resolve({ ok: false, reason: 'inline-image-slot-focus-failed' });
          return;
        }
        // Allow LinkedIn's editor observer to register the clicked line and
        // preserve that selection bookmark before the upload dialog opens.
        await sleep(150);

        const beforeCount = body.querySelectorAll('figure.article-editor-figure-image').length;
        const existingInputs = new Set(Array.from(document.querySelectorAll('input[type="file"]')));
        button.click();
        // LinkedIn reuses the same input id for the cover-image and inline
        // media dialogs. Selecting by id (or excluding that id) is therefore
        // unreliable after a cover has already been uploaded. Scope the file
        // input to the active "Add image or video" dialog instead.
        let dialog = await waitFor(imageDialog, 1500);
        const input = await waitFor(
          () => {
            const inputs = dialog
              ? Array.from(dialog.querySelectorAll('input[type="file"]'))
              : Array.from(document.querySelectorAll('input[type="file"]')).filter((candidate) => !existingInputs.has(candidate));
            return inputs[inputs.length - 1] || null;
          },
          8000,
        );
        if (!input) {
          resolve({ ok: false, reason: 'inline-image-file-input-not-found' });
          return;
        }

        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        const file = new File([bytes], `contentpulse-inline.${ext}`, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        dialog = dialog || (await waitFor(imageDialog, 10000));
        if (!dialog) {
          resolve({ ok: false, reason: 'inline-image-dialog-not-found' });
          return;
        }
        const next = await waitFor(
          () => Array.from(dialog.querySelectorAll('button')).find((el) => visible(el) && /^next$/i.test((el.textContent || '').trim()) && !el.disabled),
          8000,
        );
        if (!next) {
          resolve({ ok: false, reason: 'inline-image-next-not-found' });
          return;
        }
        next.click();

        const figure = await waitFor(
          () => {
            const figures = Array.from(body.querySelectorAll('figure.article-editor-figure-image'));
            return figures.length > beforeCount ? figures[figures.length - 1] : null;
          },
          60000,
        );
        if (!figure) {
          resolve({ ok: false, reason: 'inline-image-not-inserted' });
          return;
        }

        // Some LinkedIn builds ignore the selection bookmark and append the
        // uploaded figure to the document tail. The upload itself succeeded,
        // so repair only that placement: put the new figure directly after
        // the heading/previous figure captured above and notify the editor's
        // DOM observer. This is the same location a focused blank line uses.
        if (
          insertionReference?.isConnected &&
          insertionReference.parentNode === body &&
          figure.parentNode === body &&
          figure !== insertionReference.nextElementSibling
        ) {
          insertionReference.parentNode.insertBefore(figure, insertionReference.nextElementSibling);
          body.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertFromPaste',
          }));
          await sleep(250);
        }

        const caption = String(captionText || '').trim().slice(0, 250);
        let captionOk = !caption;
        if (caption) {
          const field = await waitFor(
            () => figure.querySelector('textarea.article-editor-figure-caption, textarea[data-test-inline-image-caption]'),
            10000,
          );
          if (field) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            field.focus();
            setter.call(field, caption);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            field.dispatchEvent(new Event('blur', { bubbles: true }));
            await sleep(300);
            captionOk = (field.value || '').trim() === caption;
          }
        }

        // The temporary paragraph is only a selection anchor. LinkedIn can
        // leave it behind after the upload, or recreate it while committing
        // the caption. Clean it after the image/caption transaction settles,
        // and only remove empty paragraphs between the captured insertion
        // reference and this figure. This preserves intentional spacing
        // elsewhere in the article while removing the extra line introduced
        // solely to open the inline-image uploader.
        const isEmptyAnchor = (node) =>
          !!node &&
          node.matches?.('p') &&
          !normalizeText(node.textContent) &&
          !node.querySelector('img, figure');
        const cleanupInsertionAnchors = () => {
          const removable = new Set();
          if (isEmptyAnchor(insertionPlaceholder)) removable.add(insertionPlaceholder);

          if (
            insertionReference?.isConnected &&
            insertionReference.parentNode === body &&
            figure?.isConnected &&
            figure.parentNode === body
          ) {
            let sibling = insertionReference.nextElementSibling;
            while (sibling && sibling !== figure) {
              if (!isEmptyAnchor(sibling)) break;
              removable.add(sibling);
              sibling = sibling.nextElementSibling;
            }
          }

          if (!removable.size) return false;
          for (const node of removable) node.remove();
          body.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'deleteContentBackward',
          }));
          return true;
        };

        // Let LinkedIn finish its caption render before removing the anchor;
        // otherwise its editor observer can immediately recreate the blank
        // line we just removed.
        await sleep(250);
        cleanupInsertionAnchors();
        resolve({ ok: true, captionOk });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      } finally {
        restorePicker();
      }
    })();
  });
}

async function pageFillInlineImages(tabId, images) {
  const list = Array.isArray(images) ? images.filter((image) => image && image.url) : [];
  const results = [];
  for (const image of list) {
    try {
      const imageData = image.b64 && image.mime
        ? { b64: image.b64, mime: image.mime }
        : await fetchImageAsBase64(image.url);
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: cpFillInlineImage,
        args: [imageData.b64, imageData.mime, image.caption || '', image.anchorText || ''],
      });
      const result = injected && injected[0] ? injected[0].result : null;
      results.push(result || { ok: false, reason: 'no-result' });
    } catch (e) {
      results.push({ ok: false, error: `Could not download ${image.url}: ${e.message}` });
    }
  }
  log('[ContentPulse][bg] pageFillInlineImages results', results);
  return results;
}

async function pageEnsurePublisher(tabId, entityName) {
  if (!tabId || !(entityName || '').trim()) {
    return { ok: true, skipped: true };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpEnsurePublisher,
      args: [entityName],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] pageEnsurePublisher result', result);
    if (result && result.entities) await rememberPublisherUrns(result.entities);
    return result || { ok: false, error: 'No result from publisher check' };
  } catch (e) {
    log('[ContentPulse][bg] pageEnsurePublisher executeScript error', e);
    return { ok: false, error: e.message };
  }
}

// name -> URN cache learned from the entity selector. Once an entity's URN is
// known, the editor is opened as /article/new/?author=<urn> so the whole
// Publish-as click automation can be skipped.
async function rememberPublisherUrns(entities) {
  try {
    const names = Object.keys(entities || {}).filter((k) => (entities[k] || '').startsWith('urn:'));
    if (!names.length) return;
    const { cp_publisher_urns: map = {} } = await chrome.storage.local.get('cp_publisher_urns');
    let changed = false;
    for (const name of names) {
      if (map[name] !== entities[name]) {
        map[name] = entities[name];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ cp_publisher_urns: map });
  } catch (e) {
    log('[ContentPulse][bg] rememberPublisherUrns error', e);
  }
}

async function getKnownPublisherUrn(entityName) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = norm(entityName);
  if (!wanted) return null;
  try {
    const { cp_publisher_urns: map = {} } = await chrome.storage.local.get('cp_publisher_urns');
    if (map[wanted]) return map[wanted];
    const key = Object.keys(map).find((k) => k.includes(wanted) || wanted.includes(k));
    return key ? map[key] : null;
  } catch (e) {
    return null;
  }
}

async function pageFillSeo(tabId, seoTitle, seoDescription) {
  if (!tabId) {
    return { ok: false, error: 'No tab id for SEO fill' };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpPageFillSeo,
      args: [seoTitle || '', seoDescription || ''],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] pageFillSeo result', result);
    return result || { ok: false, error: 'No result from SEO fill' };
  } catch (e) {
    log('[ContentPulse][bg] pageFillSeo executeScript error', e);
    return { ok: false, error: e.message };
  }
}

// Runs in the page (MAIN world). Waits for LinkedIn's share dialog - the post
// composer LinkedIn forces open when a Pulse article is published - and fills
// it with the prepared share text. Never overwrites text the user already
// typed. In one-shot mode (popup button) it fills the currently visible
// composer or reports that none is open.
function cpFillShareDialog(shareText, oneShot) {
  try {
    const isVisible = (el) => !!(el && el.offsetParent !== null);

    const findComposer = () => {
      const candidates = document.querySelectorAll(
        [
          'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
          '.share-creation-state__text-editor div[contenteditable="true"]',
          'div[role="textbox"][contenteditable="true"].ql-editor',
        ].join(', ')
      );
      for (const el of candidates) {
        if (isVisible(el)) return el;
      }
      return null;
    };

    const toast = (msg) => {
      try {
        let el = document.getElementById('cp-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'cp-toast';
          el.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px;display:flex;align-items:center;gap:9px';
          document.body.appendChild(el);
        }
        el.style.background = '#0a7d33';
        el.innerHTML = '<span></span>';
        el.lastChild.textContent = msg;
        if (el._cpHide) clearTimeout(el._cpHide);
        el._cpHide = setTimeout(() => el.remove(), 3500);
      } catch (e) {}
    };

    const fill = (composer) => {
      if ((composer.textContent || '').trim() !== '') return false;
      composer.focus();
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, shareText);
      } catch (e) {}
      if (!inserted || (composer.textContent || '').trim() === '') {
        // Quill fallback: build the paragraphs directly and let the editor
        // sync from an input event.
        composer.innerHTML = '';
        for (const line of shareText.split('\n')) {
          const p = document.createElement('p');
          if (line === '') {
            p.appendChild(document.createElement('br'));
          } else {
            p.textContent = line;
          }
          composer.appendChild(p);
        }
        composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      toast('ContentPulse: share post text filled');
      return true;
    };

    const existing = findComposer();
    if (existing) {
      const filled = fill(existing);
      return { ok: true, filled };
    }

    if (oneShot) {
      return { ok: false, error: 'No share dialog is open. Click Publish on the article first, then try again.' };
    }

    // Watch for the dialog LinkedIn opens later in the publish flow. Guarded so
    // repeated fills never stack observers; auto-expires after 30 minutes.
    if (window.__cpShareWatch) return { ok: true, watching: true };
    window.__cpShareWatch = true;

    const stop = (observer) => {
      observer.disconnect();
      window.__cpShareWatch = false;
    };
    const observer = new MutationObserver(() => {
      const composer = findComposer();
      if (!composer) return;
      fill(composer);
      stop(observer);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => stop(observer), 30 * 60 * 1000);

    return { ok: true, watching: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Compose the final share text the way it is posted: commentary, blank line,
// hashtags. Mirrors the dashboard's composePostText.
function composeShareText(sharePost) {
  if (!sharePost || typeof sharePost.commentary !== 'string') return '';
  const parts = [sharePost.commentary.trim()];
  const tags = typeof sharePost.hashtags === 'string' ? sharePost.hashtags.trim() : '';
  if (tags !== '') parts.push('', tags);
  return parts.join('\n').trim();
}

async function injectShareDialogFill(tabId, shareText, oneShot) {
  if (!tabId || !shareText) {
    return { ok: false, error: 'Nothing to fill.' };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpFillShareDialog,
      args: [shareText, !!oneShot],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] share dialog fill result', result);
    return result || { ok: false, error: 'No result from share dialog fill' };
  } catch (e) {
    err('[ContentPulse][bg] share dialog fill error', e);
    return { ok: false, error: e.message };
  }
}

// Popup button: fill the share dialog currently open in the active LinkedIn tab.
function fillSharePostActive(shareText) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const activeTab = tabs && tabs[0];
      if (!activeTab || !/^https:\/\/www\.linkedin\.com\//.test(activeTab.url || '')) {
        resolve({ ok: false, error: 'Open LinkedIn with the share dialog visible first, then try again.' });
        return;
      }
      resolve(await injectShareDialogFill(activeTab.id, shareText, true));
    });
  });
}

const LINKEDIN_EDITOR_URL = 'https://www.linkedin.com/article/new/';
const MEDIUM_EDITOR_URL = 'https://medium.com/new-story';

function editorUrlWithContentId(url, contentId) {
  const id = String(contentId || '').trim();
  if (!id) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('cp', id);
    return parsed.toString();
  } catch (e) {
    return url;
  }
}

// LinkedIn's API identifies Company Pages with an organization URN, but the
// Article editor's `author` query parameter expects the frontend `fsd_company`
// entity URN. Keep the API/storage value unchanged and translate it only at
// this browser boundary.
function linkedinEditorAuthorUrn(urn) {
  const value = typeof urn === 'string' ? urn.trim() : '';
  return value.replace(/^urn:li:organization:(\d+)$/, 'urn:li:fsd_company:$1');
}

function isEditorUrl(url) {
  if (!url) return false;
  return url.startsWith('https://www.linkedin.com/article/') || url.startsWith('https://www.linkedin.com/pulse/');
}

function isMediumEditorUrl(url) {
  if (!url) return false;
  return url.startsWith('https://medium.com/new-story') || /^https:\/\/medium\.com\/p\/[^/]+\/edit/.test(url);
}

// A LinkedIn article is live once its URL settles on the /pulse/<slug> permalink.
// The editor (/article/new/) and the in-progress draft never match this, so a
// later transition to a /pulse/ URL is a reliable "published" signal.
function publishedLinkedInUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^https:\/\/www\.linkedin\.com\/pulse\/[^/?#]+/);
  return match ? match[0] : null;
}

// Medium story URLs: https://medium.com/@user/slug-hexid or
// https://medium.com/publication/slug-hexid. The new-story editor and edit
// URLs (/new-story, /p/xxx/edit) don't match.
function publishedMediumUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.includes('/new-story') || url.includes('/edit') || url.includes('/settings')) return null;
  const match = url.match(/^https:\/\/medium\.com\/(@[^/]+|[^/]+)\/[a-z0-9][\w-]+-[0-9a-f]{8,}/i);
  return match ? match[0] : null;
}

function isSubstackEditorUrl(url) {
  if (!url) return false;
  return /^https:\/\/[^/]+\.substack\.com\/publish\/post(?:\/|$)/.test(url);
}

function publishedSubstackUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.includes('/publish/')) return null;
  const match = url.match(/^https:\/\/[^/]+\.substack\.com\/p\/[a-z0-9][\w-]+/i);
  return match ? match[0] : null;
}

// Tabs we are watching for a publish navigation: tabId -> {contentId, platform, initialUrl}.
// After the user clicks "Fill in editor" we keep an eye on that editor tab; when it
// navigates to the live /pulse/ URL we auto-record the publication. Manual paste in
// the popup remains the fallback when auto-capture cannot fire (popup-only flows,
// edits of an existing article, or unexpected redirects).
const publishWatch = new Map();

function watchTabForPublish(tabId, contentId, platform, initialUrl, shareText) {
  if (!tabId || !contentId || !platform) return;
  publishWatch.set(tabId, { contentId, platform, initialUrl: initialUrl || '', shareText: shareText || '' });
  log('[ContentPulse][bg] watching tab', tabId, 'for publish of content', contentId);
}

function cpPublishCapturedToast(message) {
  try {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;background:#0a7d33;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  } catch (e) {}
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const watch = publishWatch.get(tabId);
  if (!watch) return;

  const currentUrl = changeInfo.url || tab?.url || '';
  const liveUrl = publishedLinkedInUrl(currentUrl) || publishedMediumUrl(currentUrl) || publishedSubstackUrl(currentUrl);
  // Ignore the editor and any URL identical to where we started filling; only a
  // transition to a real permalink counts as published.
  if (!liveUrl || currentUrl === watch.initialUrl) return;

  publishWatch.delete(tabId);

  // The publish navigation may replace the page (destroying the in-page
  // watcher armed at fill time), and LinkedIn opens/keeps its share dialog
  // around this transition - so re-arm the share fill on the live page.
  if (watch.shareText) {
    injectShareDialogFill(tabId, watch.shareText, false);
  }

  const res = await recordPublication(watch.contentId, watch.platform, liveUrl);
  if (res.ok) {
    log('[ContentPulse][bg] auto-captured publish URL', liveUrl);
    try {
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: cpPublishCapturedToast,
        args: ['ContentPulse: publish link saved to your workspace'],
      });
    } catch (e) {}
  } else {
    warn('[ContentPulse][bg] auto-capture could not save publish URL', res.error);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  publishWatch.delete(tabId);
});

async function autoFillFromContentId(contentId, tabId, requestedPlatform) {
  const result = await getArticle(contentId);
  if (!result?.ok || !result.article) return result || { ok: false, error: 'Article was not found.' };

  // The page itself is the platform signal for this initial-load path. This
  // prevents a stale publish_channel value from routing a LinkedIn URL into
  // the Medium/Substack branch.
  const platform = normalizeExtensionPlatform(requestedPlatform || 'linkedin_pulse');
  const article = {
    ...result.article,
    platform: ['linkedin_pulse', 'medium', 'substack'].includes(platform) ? platform : 'linkedin_pulse',
  };
  if (tabId) {
    directFillTabs.set(tabId, Date.now());
    setTimeout(() => directFillTabs.delete(tabId), 20_000);
  }
  openAndFill(article, tabId || null);
  return { ok: true, contentId: article.id, title: article.title };
}

async function openAndFill(article, preferredTabId = null) {
  const title = article?.title || '';
  const bodyHtml = article?.body_html || article?.body || '';
  const contentId = article?.id || null;
  const platform = normalizeExtensionPlatform(article?.platform || article?.publish_channel || 'linkedin_pulse');
  const imageUrl = typeof article?.image_url === 'string' ? article.image_url.trim() : '';
  const credit = typeof article?.credit === 'string' ? article.credit.trim() : '';
  const taxonomyHashtags = normalizeLinkedInHashtags(article?.tags || []).join(' ');
  const sharePost = article?.share_post && typeof article.share_post === 'object'
    ? {
        ...article.share_post,
        hashtags: String(article.share_post.hashtags || '').trim() || taxonomyHashtags,
      }
    : article?.share_post;
  const shareText = composeShareText(sharePost);
  const clipboardPrepared = article?.clipboard_prepared === true;
  const clipboardToken = article?.clipboard_token || '';
  log('[ContentPulse][bg] openAndFill ->', title, 'platform:', platform);

  // Table PNGs are generated by a separate authenticated endpoint. Resolve
  // them once per fill and reuse the downloaded bytes for all platform flows.
  const tableImagesPromise = /<table\b/i.test(bodyHtml) ? fetchTableImages(contentId) : Promise.resolve([]);

  const isMedium = platform === 'medium';

  const queryTargetTab = () => new Promise((resolve) => {
    if (preferredTabId) {
      chrome.tabs.get(preferredTabId, (tab) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(tab || null);
      });
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
  });

  const createEditorTab = (url, onCreated) =>
    new Promise((resolve) => {
      if (!url) {
        resolve({ ok: false, error: 'No editor URL is configured for this platform.' });
        return;
      }
      chrome.tabs.create({ url }, (tab) => {
        const error = chrome.runtime.lastError;
        if (error || !tab?.id) {
          resolve({ ok: false, error: error?.message || 'The editor tab could not be opened.' });
          return;
        }
        onCreated(tab);
        resolve({ ok: true, tabId: tab.id });
      });
    });

  // Strip HTML to plain text (service worker has no DOMParser).
  const stripToText = (html) => {
    if (!html) return '';
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  };

  // ── Medium flow ──────────────────────────────────────────────────
  if (isMedium) {
    const mediumImageUrl = typeof article?.image_url === 'string' ? article.image_url.trim() : '';
    const mediumTags = article?.tags || [];
    const mediumCategories = article?.categories || [];
    const canonicalUrl = article?.article_url || '';
    const seo = article?.seo || {};
    const seoTitle = seo.meta_title || '';
    const seoDescription = seo.meta_description || '';

    // Keep opening/navigation independent from authenticated table-image
    // downloads. The editor must open immediately, while the body assets can
    // finish resolving before the page fill starts.
    const mediumPrepared = tableImagesPromise.then((tableImages) => {
      const mediumBodySource = replaceTablesWithImageFiguresForMedium(bodyHtml, tableImages);
      const mediumInlineImages = buildInlineImageMeta(bodyHtml, tableImages);
      const heroCaption = (article?.credit || title || '').trim().slice(0, 250);
      const heroAlt = (title || heroCaption || 'Featured image').trim().slice(0, 500);
      const heroAlreadyInBody = mediumImageUrl && mediumInlineImages.some((image) => image.url === mediumImageUrl);
      const heroHtml =
        mediumImageUrl && !heroAlreadyInBody
          ? `<figure><img src="${escapeHtml(mediumImageUrl)}" alt="${escapeHtml(heroAlt)}"><figcaption>${escapeHtml(heroCaption)}</figcaption></figure>`
          : '';
      const mediumBodyHtml = `${heroHtml}${mediumBodySource}`;
      return {
        mediumBodyHtml,
        bodyText: stripToText(mediumBodyHtml),
        mediumImageMeta: [
          ...(heroHtml ? [{ caption: heroCaption, alt: heroAlt }] : []),
          ...mediumInlineImages,
        ],
      };
    });

    const mediumAfterEditorFill = async (tabId) => {
      await mediumAfterFill(tabId, mediumTags, mediumCategories, canonicalUrl, seoTitle, seoDescription);
    };
    const fillMediumTab = async (tabId) => {
      const prepared = await mediumPrepared;
      await mediumPageFill(tabId, title, prepared.mediumBodyHtml, prepared.bodyText, prepared.mediumImageMeta);
      await mediumAfterEditorFill(tabId);
    };

    const activeTab = await queryTargetTab();
    if (activeTab && isMediumEditorUrl(activeTab.url)) {
      log('[ContentPulse][bg] active tab is Medium editor, filling in place');
      watchTabForPublish(activeTab.id, contentId, platform, activeTab.url, '');
      fillMediumTab(activeTab.id);
      return { ok: true, tabId: activeTab.id, reused: true };
    }

    const editorUrl = editorUrlWithContentId(MEDIUM_EDITOR_URL, contentId);
    log('[ContentPulse][bg] opening Medium editor', editorUrl);
    return createEditorTab(editorUrl, (tab) => {
      const targetTabId = tab.id;
      watchTabForPublish(targetTabId, contentId, platform, editorUrl, '');

      let readyHandled = false;
      const listener = (tabId, changeInfo) => {
        if (readyHandled || tabId !== targetTabId || changeInfo.status !== 'complete') return;
        readyHandled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        // Medium's editor needs extra time to bootstrap ProseMirror.
        setTimeout(() => {
          if (directFillTabs.has(targetTabId)) {
            directFillTabs.delete(targetTabId);
            return;
          }
          fillMediumTab(targetTabId);
        }, 2000);
      };
      chrome.tabs.onUpdated.addListener(listener);
      if (tab.status === 'complete') listener(targetTabId, { status: 'complete' });
    });
  }

  // ── Substack flow ─────────────────────────────────────────────────
  const isSubstack = platform === 'substack';
  if (isSubstack) {
    const subtitle = article?.subtitle || article?.seo?.meta_description || '';
    const thumbnailDescription = article?.seo?.meta_description || credit || title;
    const substackPrepared = tableImagesPromise.then((tableImages) => {
      const substackBodyHtml = replaceTablesWithImageFigures(bodyHtml, tableImages);
      return {
        substackBodyHtml,
        bodyText: stripToText(substackBodyHtml),
        substackInlineImages: buildInlineImageMeta(bodyHtml, tableImages),
      };
    });
    const doFill = async (tabId) => {
      const prepared = await substackPrepared;
      // The body paste is also Substack's working inline-image uploader: it
      // converts remote <img> URLs into Substack CDN blocks and keeps their
      // figcaptions/alt text. Add the separate thumbnail after that settles.
      await substackPageFill(tabId, title, subtitle, prepared.substackBodyHtml, prepared.bodyText, prepared.substackInlineImages.length, article?.tags || []);
      if (imageUrl) {
        const coverResult = await substackCoverImage(tabId, imageUrl, title, thumbnailDescription);
        if (!coverResult?.ok) {
          const heroCaption = (credit || article?.hero_description || title || 'Featured image').trim().slice(0, 250);
          await substackInsertHeroAtStart(tabId, imageUrl, title || 'Featured image', heroCaption);
        }
      }
    };

    const activeTab = await queryTargetTab();
    if (activeTab && isSubstackEditorUrl(activeTab.url)) {
      log('[ContentPulse][bg] active tab is Substack editor, filling in place');
      watchTabForPublish(activeTab.id, contentId, platform, activeTab.url, '');
      doFill(activeTab.id);
      return { ok: true, tabId: activeTab.id, reused: true };
    }

    log('[ContentPulse][bg] no Substack editor in the active tab');
    const substackDomain = article?.substack_domain || '';
    const editorBaseUrl = substackDomain ? `https://${substackDomain}.substack.com/publish/post` : null;
    const editorUrl = editorUrlWithContentId(editorBaseUrl, contentId);

    if (!editorUrl) {
      log('[ContentPulse][bg] no Substack domain configured, cannot open editor');
      return { ok: false, error: 'No Substack publication domain is configured for this article.' };
    }

    return createEditorTab(editorUrl, (tab) => {
      const targetTabId = tab.id;
      watchTabForPublish(targetTabId, contentId, platform, editorUrl, '');

      let readyHandled = false;
      const listener = (tabId, changeInfo) => {
        if (readyHandled || tabId !== targetTabId || changeInfo.status !== 'complete') return;
        readyHandled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => {
          if (directFillTabs.has(targetTabId)) {
            directFillTabs.delete(targetTabId);
            return;
          }
          doFill(targetTabId);
        }, 2000);
      };
      chrome.tabs.onUpdated.addListener(listener);
      if (tab.status === 'complete') listener(targetTabId, { status: 'complete' });
    });
  }

  // ── LinkedIn flow (default) ──────────────────────────────────────
  // LinkedIn forces a share-post dialog when the Pulse article is published;
  // arm a watcher on the editor tab so the prepared copy is filled in the
  // moment that dialog opens.
  const armShareFill = (tabId) => {
    if (shareText) injectShareDialogFill(tabId, shareText, false);
  };

  // The article's website carries the connected LinkedIn profile/page name;
  // verify/switch the editor's "Publish as" entity to it after the fill.
  const publishAs = article?.publish_as || '';
  const linkedinPrepared = tableImagesPromise.then((tableImages) => {
    const linkedinBodySource = removeTablesForLinkedIn(bodyHtml);
    const linkedinBodyWithHero = addLinkedInHeroDescription(linkedinBodySource, article?.hero_description || '');
    const linkedinBodyHtml = addLinkedInTitleSpacing(formatLinkedInTagsHtml(linkedinBodyWithHero, article?.tags || []));
    // Build image metadata from the original body so generated table PNGs keep
    // their source order and heading anchors even though the table HTML itself
    // was removed from LinkedIn's pasted body.
    const seo = article?.seo || null;
    return {
      linkedinBodyHtml,
      inlineImages: buildInlineImageMeta(bodyHtml, tableImages),
      seo,
      hasSeo: !!(seo && ((seo.meta_title || '').trim() || (seo.meta_description || '').trim())),
    };
  });
  // Run sequentially - each step opens its own dialog on the page and they
  // would fight each other if fired at the same time. Order: publisher ->
  // cover image + credit -> inline images/captions -> SEO settings (filled and saved).
  const afterFill = async (tabId, prepared) => {
    if (publishAs) await pageEnsurePublisher(tabId, publishAs);
    if (imageUrl) await pageFillCoverImage(tabId, imageUrl, credit);
    if (prepared.inlineImages.length) await pageFillInlineImages(tabId, prepared.inlineImages);
    if (prepared.hasSeo) await pageFillSeo(tabId, prepared.seo.meta_title || '', prepared.seo.meta_description || '');
  };
  const fillLinkedInTab = async (tabId) => {
    const prepared = await linkedinPrepared;
    const systemClipboardReady = clipboardPrepared || await waitForClipboardPrepared(clipboardToken);
    await pageFill(tabId, title, prepared.linkedinBodyHtml, '', false, systemClipboardReady);
    await afterFill(tabId, prepared);
  };

  const activeTab = await queryTargetTab();
  if (activeTab && isEditorUrl(activeTab.url)) {
    log('[ContentPulse][bg] active tab is already the editor, filling in place');
    watchTabForPublish(activeTab.id, contentId, platform, activeTab.url, shareText);
    fillLinkedInTab(activeTab.id);
    armShareFill(activeTab.id);
    return { ok: true, tabId: activeTab.id, reused: true };
  }

  log('[ContentPulse][bg] no editor in the active tab, opening a new one');
  // If we already learned this publisher's URN, open the editor publishing
  // as it right away (?author=<urn>) - no Publish-as clicking needed.
  const configuredUrn = typeof article?.publish_as_urn === 'string' ? article.publish_as_urn.trim() : '';
  const urn = linkedinEditorAuthorUrn(configuredUrn);
  const editorBaseUrl = urn ? `${LINKEDIN_EDITOR_URL}?author=${encodeURIComponent(urn)}` : LINKEDIN_EDITOR_URL;
  const editorUrl = editorUrlWithContentId(editorBaseUrl, contentId);
  if (urn) log('[ContentPulse][bg] opening editor with configured author urn', urn);
  return createEditorTab(editorUrl, (tab) => {
    const targetTabId = tab.id;
    watchTabForPublish(targetTabId, contentId, platform, editorUrl, shareText);

    let readyHandled = false;
    const listener = (tabId, changeInfo) => {
      if (readyHandled || tabId !== targetTabId || changeInfo.status !== 'complete') {
        return;
      }
      readyHandled = true;
      log('[ContentPulse][bg] editor tab ready, filling via executeScript');
      chrome.tabs.onUpdated.removeListener(listener);
      if (directFillTabs.has(targetTabId)) {
        directFillTabs.delete(targetTabId);
        return;
      }
      linkedinPrepared.then(async (prepared) => {
        const systemClipboardReady = clipboardPrepared || await waitForClipboardPrepared(clipboardToken);
        pageFill(targetTabId, title, prepared.linkedinBodyHtml, '', true, systemClipboardReady).then(() => afterFill(targetTabId, prepared));
      });
      armShareFill(targetTabId);
    };

    chrome.tabs.onUpdated.addListener(listener);
    if (tab.status === 'complete') listener(targetTabId, { status: 'complete' });
  });
}

function fillCoverImageActive(imageUrl, credit) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const activeTab = tabs && tabs[0];

      if (!activeTab || !isEditorUrl(activeTab.url)) {
        resolve({
          ok: false,
          error: 'Open the LinkedIn article editor first, then click Fill image.',
        });
        return;
      }

      const res = await pageFillCoverImage(activeTab.id, imageUrl, credit);
      resolve(res);
    });
  });
}

function fillSeoActive(seo) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const activeTab = tabs && tabs[0];

      if (!activeTab || !isEditorUrl(activeTab.url)) {
        resolve({
          ok: false,
          error: 'Open the LinkedIn article editor first, then click Fill SEO.',
        });
        return;
      }

      const res = await pageFillSeo(activeTab.id, seo?.meta_title || '', seo?.meta_description || '');
      resolve(res);
    });
  });
}

// Runs in the page (MAIN world). Drives LinkedIn's scheduling flow end to end:
// editor Next -> share composer clock button -> fill date/time from the
// article's scheduled_at -> dialog Next -> final Schedule confirm. Without a
// scheduled_at it stops at the picker for the user to finish.
function cpSchedulePost(scheduledAtIso) {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const isVisible = (el) => !!(el && el.offsetParent !== null);

    const waitFor = async (cond, timeoutMs, stepMs = 200) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const val = cond();
        if (val) return val;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };

    const toast = (msg, state) => {
      try {
        let el = document.getElementById('cp-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'cp-toast';
          el.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px;display:flex;align-items:center;gap:9px';
          document.body.appendChild(el);
        }
        el.style.background = state === 'ok' ? '#0a7d33' : state === 'error' ? '#b3261e' : '#1f2937';
        el.innerHTML = '<span></span>';
        el.lastChild.textContent = msg;
        if (el._cpHide) clearTimeout(el._cpHide);
        if (state !== 'progress') el._cpHide = setTimeout(() => el.remove(), 3000);
      } catch (e) {}
    };

    (async () => {
      toast('ContentPulse: Opening the schedule flow...', 'progress');

      const nextBtn = Array.from(document.querySelectorAll('button.article-editor-nav__publish')).find(
        (b) => isVisible(b) && !b.disabled,
      );
      if (!nextBtn) {
        toast('ContentPulse: Could not find the editor Next button', 'error');
        resolve({ ok: false, error: 'The editor "Next" button was not found. Is the article editor open?' });
        return;
      }
      nextBtn.click();

      const scheduleBtn = await waitFor(() => {
        const btn = document.querySelector(
          'button.share-actions__scheduled-post-btn, button[aria-label="Schedule post"]',
        );
        return btn && isVisible(btn) && !btn.disabled ? btn : null;
      }, 15000);

      if (!scheduleBtn) {
        toast('ContentPulse: Schedule button did not appear - use the clock icon in the post dialog', 'error');
        resolve({ ok: false, error: 'The share dialog opened but the schedule (clock) button was not found.' });
        return;
      }
      scheduleBtn.click();

      const scheduled = scheduledAtIso ? new Date(scheduledAtIso) : null;
      if (!scheduled || isNaN(scheduled.getTime())) {
        toast('ContentPulse: Pick the date and time, then confirm', 'ok');
        resolve({ ok: true });
        return;
      }

      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${pad(scheduled.getMonth() + 1)}/${pad(scheduled.getDate())}/${scheduled.getFullYear()}`;
      let hours = scheduled.getHours();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      const timeStr = `${hours}:${pad(scheduled.getMinutes())} ${ampm}`;

      // Ember inputs ignore direct .value writes; go through the native setter
      // and fire the events its bindings listen for.
      const fillInput = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        input.focus();
        setter.call(input, value);
        for (const type of ['input', 'change', 'blur']) {
          input.dispatchEvent(new Event(type, { bubbles: true }));
        }
      };

      toast('ContentPulse: Filling the schedule date and time...', 'progress');

      const dateInput = await waitFor(() => {
        const el = document.getElementById('share-post__scheduled-date');
        return el && isVisible(el) ? el : null;
      }, 10000);
      const timeInput = document.getElementById('share-post__scheduled-time');

      if (!dateInput || !timeInput) {
        toast('ContentPulse: Schedule dialog opened - pick the date and time manually', 'error');
        resolve({ ok: false, error: 'The schedule date/time inputs were not found; fill them manually.' });
        return;
      }

      fillInput(dateInput, dateStr);
      await sleep(300);
      fillInput(timeInput, timeStr);
      // The time field is a typeahead; Escape closes its suggestion list so it
      // keeps the typed value instead of a highlighted suggestion.
      timeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);

      const dialogNextBtn = await waitFor(() => {
        const btn = document.querySelector('.share-box-footer__main-actions button.share-box-footer__primary-btn');
        return btn && isVisible(btn) && !btn.disabled ? btn : null;
      }, 8000);
      if (!dialogNextBtn) {
        toast('ContentPulse: Date and time filled - click Next to continue', 'error');
        resolve({ ok: false, error: 'Filled the date/time but the dialog Next button was not found.' });
        return;
      }
      dialogNextBtn.click();

      const confirmBtn = await waitFor(() => {
        const btn = Array.from(document.querySelectorAll('button.share-actions__primary-action')).find(
          (b) => isVisible(b) && !b.disabled && /schedule/i.test(b.textContent || ''),
        );
        return btn || null;
      }, 10000);
      if (!confirmBtn) {
        toast('ContentPulse: Review the post, then click Schedule', 'error');
        resolve({ ok: false, error: 'The final Schedule button was not found; confirm manually.' });
        return;
      }
      confirmBtn.click();

      toast(`ContentPulse: Scheduled for ${dateStr} ${timeStr}`, 'ok');
      resolve({ ok: true });
    })();
  });
}

// Popup button: start the schedule flow on the active LinkedIn editor tab.
function schedulePostActive(scheduledAtIso) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const activeTab = tabs && tabs[0];

      if (!activeTab || !isEditorUrl(activeTab.url)) {
        resolve({
          ok: false,
          error: 'Open the LinkedIn article editor first, then click Schedule.',
        });
        return;
      }

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          world: 'MAIN',
          func: cpSchedulePost,
          args: [scheduledAtIso || null],
        });
        const result = results && results[0] ? results[0].result : null;
        log('[ContentPulse][bg] schedulePost result', result);
        resolve(result || { ok: false, error: 'No result from the schedule flow' });
      } catch (e) {
        log('[ContentPulse][bg] schedulePost error', e);
        resolve({ ok: false, error: e.message });
      }
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log('[ContentPulse][bg] message:', message?.action);

  switch (message?.action) {
    case 'validateKey':
      validateKey(message.apiKey).then(sendResponse);
      return true;

    case 'getWebsites':
      getWebsites().then(sendResponse);
      return true;

    case 'getArticles':
      getArticles(message.websiteId).then(sendResponse);
      return true;

    case 'getArticle':
      getArticle(message.contentId).then(sendResponse);
      return true;

    case 'autoFillFromContentId':
      autoFillFromContentId(message.contentId, sender?.tab?.id, message.platform)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || 'The article could not be filled.' }));
      return true;

    case 'setScheduledAutoFill':
      setScheduledAutoFillEnabled(message.enabled).then(sendResponse);
      return true;

    case 'pageFill':

      pageFill(sender?.tab?.id, message.title, message.bodyHtml, message.bodyText).then(sendResponse);
      return true;

    case 'openAndFill':
      openAndFill(message.article)
        .then((result) => sendResponse(result || { ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || 'The editor could not be opened.' }));
      return true;

    case 'clipboardPrepared':
      sendResponse(recordClipboardPrepared(message.token, message.prepared));
      return false;

    case 'fillSeo':
      fillSeoActive(message.seo).then(sendResponse);
      return true;

    case 'fillCoverImage':
      fillCoverImageActive(message.imageUrl, message.credit).then(sendResponse);
      return true;

    case 'fillSharePost':
      fillSharePostActive(composeShareText(message.sharePost)).then(sendResponse);
      return true;

    case 'schedulePost':
      schedulePostActive(message.scheduledAt).then(sendResponse);
      return true;

    case 'recordPublication':
      recordPublication(message.contentId, message.platform, message.remoteUrl).then(sendResponse);
      return true;

    case 'redditIngest':
      redditIngest(message.payload).then(sendResponse);
      return true;

    case 'markCommentSent':
      markCommentSent(message.oppId, message.commentUrl).then(sendResponse);
      return true;

    default:
      sendResponse({ ok: false, error: `Unknown action: ${message?.action}` });
      return false;
  }
});

// Keep the toolbar badge current even when the popup is closed. A short
// refresh interval is intentional: it catches schedule changes made in the
// ContentPulse dashboard without keeping a tab open or publishing anything.
function ensureScheduledBadgeAlarm() {
  if (!chrome.alarms?.create) return;
  chrome.alarms.create(BADGE_ALARM_NAME, { periodInMinutes: SCHEDULED_BADGE_REFRESH_MINUTES });
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BADGE_ALARM_NAME) {
      refreshScheduledAutomation();
      return;
    }
    if (alarm.name.startsWith(AUTO_FILL_ALARM_PREFIX)) {
      runScheduledAutoFillAlarm(alarm.name);
    }
  });
}

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    ensureScheduledBadgeAlarm();
    refreshScheduledAutomation();
  });
}

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    ensureScheduledBadgeAlarm();
    refreshScheduledAutomation();
  });
}

ensureScheduledBadgeAlarm();
refreshScheduledAutomation();
