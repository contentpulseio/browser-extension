// ContentPulse background: content api.
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

async function fetchWebsites() {
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

function getWebsites() {
  if (websitesRequest) return websitesRequest;
  const request = fetchWebsites().finally(() => {
    if (websitesRequest === request) websitesRequest = null;
  });
  websitesRequest = request;
  return request;
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
    const error = new Error(`Request failed (${res.status}) for status=${status}: ${text.slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  const body = await res.json();
  return Array.isArray(body?.data) ? body.data : [];
}

async function fetchArticles(websiteId) {
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
    return { ok: false, status: e.status || 0, error: e.message };
  }
}

function getArticles(websiteId) {
  const key = String(websiteId || '');
  if (articleRequests.has(key)) return articleRequests.get(key);

  const request = fetchArticles(websiteId).finally(() => {
    if (articleRequests.get(key) === request) articleRequests.delete(key);
  });
  articleRequests.set(key, request);
  return request;
}

function articleSummary(article) {
  return {
    id: article.id,
    title: article.title,
    status: article.status,
    platform: article.platform,
    publish_channel: article.publish_channel,
    scheduled_date: article.scheduled_date,
    excerpt: article.excerpt,
    image_url: article.image_url,
    external_url: article.external_url,
    article_url: article.article_url,
    substack_domain: article.substack_domain,
  };
}

function popupCacheBucketKey(websiteId) {
  return String(websiteId || '__all__');
}

async function readPopupCache() {
  const stored = await getLocalStored([POPUP_CACHE_KEY]);
  const cache = stored[POPUP_CACHE_KEY];
  return cache && typeof cache === 'object' ? cache : null;
}

async function writePopupCache(cache) {
  await setLocalStored({ [POPUP_CACHE_KEY]: cache });
}

function popupStateFromCache(cache, websiteId) {
  if (!cache || !Array.isArray(cache.websites)) return null;

  const validRequested = websiteId && cache.websites.some((website) => website.id === websiteId);
  const selectedWebsiteId = validRequested ? websiteId : cache.selectedWebsiteId || cache.websites[0]?.id || null;
  const bucket = cache.articles?.[popupCacheBucketKey(selectedWebsiteId)];
  if (!bucket || !Array.isArray(bucket.articles)) return null;

  return {
    ok: true,
    status: 200,
    stale: true,
    updatedAt: bucket.updatedAt || cache.updatedAt || null,
    websites: cache.websites,
    selectedWebsiteId,
    articles: bucket.articles,
  };
}

async function refreshPopupState(websiteId) {
  const previous = await readPopupCache();
  const stored = await getStored(['selectedWebsiteId']);
  const requestedWebsiteId = websiteId || stored.selectedWebsiteId || null;
  const websites = await getWebsites();
  if (!websites?.ok) return websites;

  const selectedWebsiteId =
    requestedWebsiteId && websites.websites.some((website) => website.id === requestedWebsiteId)
      ? requestedWebsiteId
      : websites.websites[0]?.id || null;
  const articles = await getArticles(selectedWebsiteId);
  if (!articles?.ok) return articles;

  const updatedAt = Date.now();
  const cache = {
    version: 1,
    updatedAt,
    selectedWebsiteId,
    websites: websites.websites,
    articles: {
      ...(previous?.articles || {}),
      [popupCacheBucketKey(selectedWebsiteId)]: {
        updatedAt,
        articles: articles.articles.map(articleSummary),
      },
    },
  };
  await writePopupCache(cache);

  return {
    ok: true,
    status: 200,
    stale: false,
    updatedAt,
    websites: cache.websites,
    selectedWebsiteId,
    articles: cache.articles[popupCacheBucketKey(selectedWebsiteId)].articles,
  };
}

const popupRefreshRequests = new Map();

function refreshPopupStateOnce(websiteId) {
  const key = String(websiteId || '');
  if (popupRefreshRequests.has(key)) return popupRefreshRequests.get(key);

  const request = refreshPopupState(websiteId).finally(() => {
    if (popupRefreshRequests.get(key) === request) popupRefreshRequests.delete(key);
  });
  popupRefreshRequests.set(key, request);
  return request;
}

function notifyPopupState(state) {
  if (!state) return;
  chrome.runtime.sendMessage({ action: 'popupStateUpdated', state }, () => {
    // No popup is a normal state; reading lastError prevents Chrome from
    // logging an unhandled "Receiving end does not exist" message.
    void chrome.runtime.lastError;
  });
}

async function getPopupState(websiteId) {
  const { apiKey } = await getStored(['apiKey']);
  if (!apiKey) return { ok: false, status: 401, error: 'No API key stored. Please connect first.' };

  const cached = popupStateFromCache(await readPopupCache(), websiteId);
  const refresh = refreshPopupStateOnce(websiteId);
  refresh.then(notifyPopupState).catch(() => {});
  if (cached) return cached;
  return refresh;
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
