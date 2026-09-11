const $ = (id) => document.getElementById(id);

const CP_DEBUG = false;
const log = (...args) => {
  if (CP_DEBUG) console.log(...args);
};
const warn = (...args) => {
  if (CP_DEBUG) console.warn(...args);
};

const SCREENS = ['screen-boot', 'screen-onboarding', 'screen-list', 'screen-detail', 'screen-settings', 'screen-reddit'];

const APP_BASE_URL = 'https://app.contentpulse.io';
const AUTO_FILL_SCHEDULED_KEY = 'cp_auto_fill_scheduled_enabled';
const CONTENT_ID_PARAM = 'cp';

// True when this page runs inside the in-page LinkedIn panel (iframe injected
// by panel.js) instead of the toolbar popup.
const IS_EMBEDDED = new URLSearchParams(location.search).has('embedded');
const IS_REDDIT_EMBED = new URLSearchParams(location.search).has('reddit');

// The toolbar popup closes itself after a successful fill; the in-page panel
// exists precisely so the user can keep it open, so it stays.
function closeUi() {
  if (!IS_EMBEDDED) window.close();
}

if (IS_EMBEDDED) document.documentElement.classList.add('cp-embedded');

function showScreen(id) {
  log('[ContentPulse][popup] show screen', id);
  for (const s of SCREENS) {
    $(s).hidden = s !== id;
  }
}

const CONNECTION_ERROR_HINTS = [
  'Receiving end does not exist',
  'Could not establish connection',
  'message port closed',
];

function sendOnce(message) {
  return new Promise((resolve) => {
    // chrome.runtime.sendMessage THROWS synchronously with "Extension context
    // invalidated" when this page outlived an extension reload - typical for
    // the embedded LinkedIn panel, which stays open across updates.
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, status: 0, error: chrome.runtime.lastError.message, _connError: true });
          return;
        }
        resolve(response);
      });
    } catch (e) {
      resolve({ ok: false, status: 0, error: e.message, _ctxInvalidated: true });
    }
  });
}

async function sendMessage(message, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await sendOnce(message);
    if (res && res._ctxInvalidated) {
      // Inline on purpose: in an invalidated (orphaned) extension context,
      // even same-file function bindings can already be gone, so calling a
      // helper here throws ReferenceError. Reload the document to reattach.
      try {
        setTimeout(() => window.location.reload(), 600);
      } catch (e) {}
      return { ok: false, status: 0, error: 'The extension was updated - reloading this panel…' };
    }
    const isConnError =
      res &&
      res._connError &&
      CONNECTION_ERROR_HINTS.some((h) => (res.error || '').toLowerCase().includes(h.toLowerCase()));
    if (!isConnError) {
      if (res && res.ok === false && /^Unknown action:/.test(res.error || '')) {
        return handleStaleWorker(res);
      }
      return res;
    }
    warn(`[ContentPulse][popup] worker not ready (attempt ${i + 1}/${attempts}), retrying…`);
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
  }
  return { ok: false, status: 0, error: 'Background service worker did not respond. Try again.' };
}

// "Unknown action" means the running background service worker predates this
// popup (Chrome re-reads popup.js on every open, but keeps the old worker until
// the extension is reloaded - common with unpacked installs after an update).
// Self-heal by reloading the extension so the fresh background.js is picked up.
// Throttled so a genuinely missing handler can never cause a reload loop.
async function handleStaleWorker(res) {
  const RELOAD_THROTTLE_MS = 60_000;
  const { lastStaleReloadAt } = await new Promise((resolve) =>
    chrome.storage.local.get(['lastStaleReloadAt'], resolve),
  );
  if (!lastStaleReloadAt || Date.now() - lastStaleReloadAt > RELOAD_THROTTLE_MS) {
    await new Promise((resolve) => chrome.storage.local.set({ lastStaleReloadAt: Date.now() }, resolve));
    warn('[ContentPulse][popup] stale background worker detected, reloading extension');
    setTimeout(() => chrome.runtime.reload(), 300);
    return { ok: false, status: 0, error: 'Extension was just updated - please reopen the popup and try again.' };
  }
  return res;
}

function getStored(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

function setStored(items) {
  return new Promise((resolve) => chrome.storage.sync.set(items, resolve));
}

function clearStored() {
  return new Promise((resolve) => chrome.storage.sync.clear(resolve));
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  const t = (text || '').trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

// A ContentPulse article URL can carry ?cp=<ULID>. Restrict the value to the
// ULID alphabet/length so arbitrary query strings never become API paths.
function contentIdFromUrl(url) {
  if (!url) return '';
  try {
    const value = new URL(url).searchParams.get(CONTENT_ID_PARAM) || '';
    return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value.trim()) ? value.trim().toUpperCase() : '';
  } catch (e) {
    return '';
  }
}

function activeTabUrl() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0]?.url || ''));
  });
}

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusColor(status) {
  switch (status) {
    case 'scheduled':
      return 'cp-badge-blue';
    case 'review':
      return 'cp-badge-amber';
    case 'published':
      return 'cp-badge-green';
    default:
      return 'cp-badge-muted';
  }
}

let currentArticles = [];
let selectedArticle = null;
let websites = [];
let selectedWebsiteId = null;
let selectedPlatform = 'linkedin';

const PLATFORMS = [
  { id: 'linkedin', name: 'LinkedIn', live: true, icon: 'assets/platforms/linkedin.svg', urlPattern: 'linkedin.com' },
  { id: 'medium', name: 'Medium', live: true, icon: 'assets/platforms/medium.svg', urlPattern: 'medium.com' },
  { id: 'substack', name: 'Substack', live: true, icon: 'assets/platforms/substack.svg', urlPattern: 'substack.com' },
];

const MARQUEE_PLATFORMS = [
  ...PLATFORMS,
  { id: 'wordpress', name: 'WordPress', live: false, icon: 'assets/platforms/wordpress.svg' },
  { id: 'webflow', name: 'Webflow', live: false, icon: 'assets/platforms/webflow.svg' },
  { id: 'shopify', name: 'Shopify', live: false, icon: 'assets/platforms/shopify.svg' },
  { id: 'squarespace', name: 'Squarespace', live: false, icon: 'assets/platforms/squarespace.svg' },
  { id: 'bigcommerce', name: 'BigCommerce', live: false, icon: 'assets/platforms/bigcommerce.svg' },
  { id: 'hubspot', name: 'HubSpot', live: false, icon: 'assets/platforms/hubspot.svg' },
  { id: 'lovable', name: 'Lovable', live: false, icon: 'assets/platforms/lovable.svg' },
  { id: 'duda', name: 'Duda', live: false, icon: 'assets/platforms/duda.svg' },
  { id: 'gohighlevel', name: 'GoHighLevel', live: false, icon: 'assets/platforms/gohighlevel.png' },
];

function renderMarquee() {
  const track = $('platform-marquee');
  if (!track) return;
  track.innerHTML = '';
  const addGroup = () => {
    for (const p of MARQUEE_PLATFORMS) {
      const chip = document.createElement('span');
      chip.className = 'cp-pchip' + (p.live ? ' cp-pchip-live' : '');
      const img = document.createElement('img');
      img.src = p.icon;
      img.alt = '';
      img.className = 'cp-pchip-icon';
      chip.appendChild(img);
      chip.appendChild(document.createTextNode(p.name));
      if (p.live) {
        const dot = document.createElement('span');
        dot.className = 'cp-pchip-dot';
        dot.textContent = 'Live';
        chip.appendChild(dot);
      }
      track.appendChild(chip);
    }
  };
  addGroup();
  addGroup();
}

function selectedWebsiteName() {
  const match = websites.find((w) => w.id === selectedWebsiteId);
  return match ? match.name : '';
}

function selectedWebsiteLinkedInAuthor() {
  const match = websites.find((w) => w.id === selectedWebsiteId);
  return match?.linkedin_author || '';
}

function selectedWebsiteLinkedInAuthorUrn() {
  const match = websites.find((w) => w.id === selectedWebsiteId);
  return match?.linkedin_author_urn || '';
}

function creditCaption() {
  if (!selectedArticle) return '';
  const caption = selectedArticle.title || '';
  const credit = selectedWebsiteName();
  return credit ? `${caption}, ${credit}` : caption;
}

async function enterConnectedShell() {
  // One central loader; the queue only appears once account, websites AND
  // articles are all ready, instead of the page building up in stages.
  showScreen('screen-boot');
  await refreshAccount();
  await loadWebsites();
  const openedDirectArticle = await loadArticles(selectedWebsiteId);
  if (!$('screen-onboarding').hidden) return; // session expired during boot
  if (!openedDirectArticle) showTab('list');
  showRedditBtnIfNeeded();

  if (IS_REDDIT_EMBED) {
    $('reddit-tools-btn').hidden = false;
    await checkRedditTab();
    showScreen('screen-reddit');
    redditCollectAndSync();
  }
}

function renderAccountBar(tenant) {
  const bar = $('account-bar');
  if (!tenant || !tenant.name) {
    bar.hidden = true;
    return;
  }
  $('account-workspace').textContent = tenant.name;

  const tier = tenant.plan || (tenant.subscription && tenant.subscription.plan) || '';
  const tierEl = $('account-tier');
  if (tier) {
    tierEl.textContent = `${tier}`;
    tierEl.hidden = false;
  } else {
    tierEl.hidden = true;
  }
  bar.hidden = false;
}

async function refreshAccount() {
  const cached = await getStored(['tenant']);
  renderAccountBar(cached.tenant);
}

async function loadWebsites() {
  const select = $('website-select');
  const res = await sendMessage({ action: 'getWebsites' });

  if (!res || !res.ok || !Array.isArray(res.websites) || res.websites.length === 0) {
    websites = [];
    selectedWebsiteId = null;
    $('website-filter').hidden = true;
    return;
  }

  websites = res.websites;

  const { selectedWebsiteId: stored } = await getStored(['selectedWebsiteId']);
  const validStored = stored && websites.some((w) => w.id === stored);
  selectedWebsiteId = validStored ? stored : websites[0].id;
  await setStored({ selectedWebsiteId });

  select.innerHTML = '';
  for (const w of websites) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.name;
    select.appendChild(opt);
  }
  select.value = selectedWebsiteId;

  $('website-filter').hidden = websites.length <= 1;
}

async function handleWebsiteChange() {
  selectedWebsiteId = $('website-select').value || null;
  await setStored({ selectedWebsiteId });
  log('[ContentPulse][popup] website filter ->', selectedWebsiteId);
  await loadArticles(selectedWebsiteId);
}

function enterDisconnectedShell() {
  $('account-bar').hidden = true;
  showScreen('screen-onboarding');
}

function showTab(tab) {
  if (tab === 'settings') {
    renderSettings();
    showScreen('screen-settings');
  } else {
    showScreen('screen-list');
  }
}

function showOnboardingError(msg) {
  const el = $('onboarding-error');
  el.textContent = msg;
  el.hidden = !msg;
}

async function handleSaveConnect() {
  const btn = $('save-connect-btn');
  const apiKey = $('api-key-input').value.trim();
  showOnboardingError('');

  if (!apiKey) {
    showOnboardingError('Please enter your API key.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Connecting…';
  log('[ContentPulse][popup] validating key');

  const res = await sendMessage({ action: 'validateKey', apiKey });

  btn.disabled = false;
  btn.textContent = 'Save & Connect';

  if (res && res.ok) {
    await setStored({ apiKey, user: res.user, tenant: res.tenant });
    log('[ContentPulse][popup] connected as', res.user?.email);

    await enterConnectedShell();
    return;
  }

  if (res && res.status === 401) {
    showOnboardingError('Invalid API key, please check your ContentPulse settings');
  } else {
    showOnboardingError(res?.error || 'Could not connect. Please try again.');
  }
}

async function loadArticles(websiteId = selectedWebsiteId) {
  $('list-error').hidden = true;
  $('list-empty').hidden = true;
  $('article-list').innerHTML = '';
  $('list-loading').hidden = false;

  const res = await sendMessage({ action: 'getArticles', websiteId });
  $('list-loading').hidden = true;

  if (!res || !res.ok) {
    if (res && res.status === 401) {
      warn('[ContentPulse][popup] 401 from getArticles, returning to connect');
      await clearStored();
      enterDisconnectedShell();
      showOnboardingError('Your session expired. Please reconnect.');
      return false;
    }
    const el = $('list-error');
    el.textContent = res?.error || 'Failed to load articles.';
    el.hidden = false;
    return false;
  }

  currentArticles = res.articles || [];

  // If the active editor/app URL identifies an article, load that exact
  // article and open its detail screen. This also works for published content
  // that is intentionally absent from the pending queue.
  const directContentId = contentIdFromUrl(await activeTabUrl());
  if (directContentId) {
    const direct = await sendMessage({ action: 'getArticle', contentId: directContentId });
    if (direct?.ok && direct.article) {
      const article = direct.article;
      if (!currentArticles.some((item) => String(item.id) === String(article.id))) {
        currentArticles = [article, ...currentArticles];
      }
      renderArticleList();
      openDetail(article);
      return true;
    }
    warn('[ContentPulse][popup] direct article lookup failed', direct?.error || directContentId);
  }

  renderArticleList();
  return false;
}

function renderArticleList() {
  const container = $('article-list');
  container.innerHTML = '';

  if (currentArticles.length === 0) {
    $('list-empty').hidden = false;
    return;
  }
  $('list-empty').hidden = true;

  // Compact single-row cards: thumb | title + meta (status inline) | Publish.
  for (const article of currentArticles) {
    const card = document.createElement('div');
    card.className = 'cp-article-card';

    if (article.image_url) {
      const thumb = document.createElement('img');
      thumb.className = 'cp-article-thumb';
      thumb.src = article.image_url;
      thumb.alt = '';
      thumb.loading = 'lazy';

      thumb.addEventListener('error', () => thumb.remove());
      card.appendChild(thumb);
    }

    const info = document.createElement('div');
    info.className = 'cp-article-info';

    const title = document.createElement('div');
    title.className = 'cp-article-title';
    title.textContent = article.title;
    title.title = article.title;

    const meta = document.createElement('div');
    meta.className = 'cp-article-meta';

    const badge = document.createElement('span');
    badge.className = `cp-badge ${statusColor(article.status)}`;
    badge.textContent = article.status;
    meta.appendChild(badge);

    // The status badge already reads "scheduled"; just show the date itself.
    const date = formatDate(article.scheduled_date);
    const when = document.createElement('span');
    when.textContent = date || 'Not scheduled';
    meta.appendChild(when);

    info.appendChild(title);
    info.appendChild(meta);
    card.appendChild(info);

    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-btn-primary cp-btn-sm cp-article-publish';
    btn.textContent = 'Publish';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDetail(article);
    });

    card.appendChild(btn);
    card.addEventListener('click', () => openDetail(article));

    container.appendChild(card);
  }
}

// Internal tabs of the detail screen (Publish / Content / SEO). The old layout
// stacked every card vertically, which made the popup a long scroll; tabs keep
// it compact and grouped by intent.
const DETAIL_TABS = ['publish', 'content', 'seo'];

function showDetailTab(tab) {
  for (const t of DETAIL_TABS) {
    $(`dtab-${t}`).hidden = t !== tab;
    $(`dtab-btn-${t}`).classList.toggle('cp-detail-tab-active', t === tab);
  }
}

function detectPlatformFromUrl(url) {
  if (!url) return null;
  for (const p of PLATFORMS) {
    if (p.urlPattern && url.includes(p.urlPattern)) return p.id;
  }
  return null;
}

function platformIdFromArticle(article) {
  const value = String(article?.platform || article?.publish_channel || '').trim().toLowerCase();
  if (value === 'linkedin' || value === 'linkedin_pulse') return 'linkedin';
  if (value === 'medium') return 'medium';
  if (value === 'substack') return 'substack';
  return null;
}

function openDetail(article) {
  selectedArticle = article;
  const articlePlatform = platformIdFromArticle(article);
  selectedPlatform = articlePlatform || (PLATFORMS.find((p) => p.live) || PLATFORMS[0]).id;
  const initialPlatform = selectedPlatform;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const detected = detectPlatformFromUrl(tabs[0]?.url);
    // Do not let the asynchronous tab probe overwrite a platform the user
    // selected while the detail view was opening.
    if (!articlePlatform && detected && selectedPlatform === initialPlatform && selectedArticle === article) {
      selectedPlatform = detected;
      const select = $('platform-select');
      if (select) select.value = detected;
      renderPlatformAction();
    }
  });

  $('detail-error').hidden = true;
  showDetailTab('publish');

  const text = article.excerpt && article.excerpt.trim() !== '' ? article.excerpt : htmlToText(article.body_html);
  const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;

  $('detail-title').textContent = article.title;
  $('detail-excerpt').textContent = excerpt || 'No preview available.';
  $('detail-wordcount').textContent = `${wordCount(htmlToText(article.body_html)).toLocaleString()} words`;
  const statusBadge = $('detail-status');
  statusBadge.textContent = article.status;
  statusBadge.className = `cp-badge ${statusColor(article.status)}`;

  const imageWrap = $('detail-image-wrap');
  if (article.image_url) {
    $('detail-image').src = article.image_url;
    const creditRow = $('detail-credit-row');
    const credit = creditCaption();
    if (credit) {
      $('detail-credit').textContent = credit;
      creditRow.hidden = false;
    } else {
      creditRow.hidden = true;
    }
    imageWrap.hidden = false;
  } else {
    imageWrap.hidden = true;
  }

  renderSeo(article.seo);
  renderPlatformTabs();
  renderPlatformAction();

  showScreen('screen-detail');
}

function renderPlatformTabs() {
  const select = $('platform-select');
  select.innerHTML = '';
  for (const platform of PLATFORMS) {
    const option = document.createElement('option');
    option.value = platform.id;
    option.textContent = platform.name;
    select.appendChild(option);
  }
  select.value = selectedPlatform;
}

function renderPlatformAction() {
  const wrap = $('platform-action');
  wrap.innerHTML = '';
  const platform = PLATFORMS.find((p) => p.id === selectedPlatform) || PLATFORMS[0];
  wrap.hidden = true;

  $('fill-info-text').textContent = platform.id === 'medium'
    ? `"Fill in editor" opens ${platform.name}'s story editor and pastes the title, body, hero image, inline images, captions, and SEO text. The Content tab holds everything to copy.`
    : `"Fill in editor" drops the title, body and cover image into ${platform.name}, and checks the right profile/page is selected. The Content and SEO tabs hold everything to copy.`;
  $('fill-info-text').hidden = true;

  updateFillButton();
  renderSharePostCard();
  renderPublishUrlCard();
}

// LinkedIn forces a share post when a Pulse article is published. Show the
// backend-prepared copy (commentary + hashtags) so the user can paste it into
// the share dialog instead of writing one on the spot.
function renderSharePostCard() {
  const card = $('detail-share-post-card');
  if (!card) return;

  const post = selectedArticle && selectedArticle.share_post;
  if (selectedPlatform !== 'linkedin' || !post) {
    card.hidden = true;
    return;
  }

  $('share-post-text').textContent = composeSharePostText(post);
  $('share-post-error').hidden = true;
  card.hidden = false;
}

function composeSharePostText(post) {
  const parts = [(post.commentary || '').trim()];
  const tags = (post.hashtags || '').trim();
  if (tags !== '') {
    parts.push('', tags);
  }
  return parts.join('\n').trim();
}

async function handleCopySharePost() {
  const post = selectedArticle && selectedArticle.share_post;
  if (!post) return;
  const ok = await copyPlainText(composeSharePostText(post));
  if (ok) flashCopied($('copy-share-post-btn'));
}

// Fills LinkedIn's share dialog in the active tab with the prepared text.
// The automatic fill armed by "Fill in editor" covers the normal flow; this
// button is the manual fallback (e.g. popup-only usage or a missed dialog).
async function handleFillSharePost() {
  const post = selectedArticle && selectedArticle.share_post;
  if (!post) return;

  const errEl = $('share-post-error');
  errEl.hidden = true;

  const btn = $('fill-share-post-btn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Filling…';

  const res = await sendMessage({ action: 'fillSharePost', sharePost: post });

  btn.disabled = false;

  if (res && res.ok) {
    btn.textContent = 'Filled ✓';
    btn.classList.add('cp-copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('cp-copied');
    }, 1600);
    return;
  }

  btn.textContent = original;
  errEl.textContent =
    res?.error || 'Could not fill the share dialog. Open it on LinkedIn (click Publish on the article) and try again.';
  errEl.hidden = false;
}

// Maps a popup platform tab to the backend publication platform. Only the
// extension-published, API-less channels (LinkedIn Pulse / Medium) accept a
// recorded URL; CMS platforms publish via their own API so they are excluded.
const PUBLISH_PLATFORM_MAP = { linkedin: 'linkedin_pulse', medium: 'medium', substack: 'substack' };

function backendPlatformFor(platformId) {
  const normalized = String(platformId || '').trim().toLowerCase();
  return PUBLISH_PLATFORM_MAP[normalized] || null;
}

// Shows the "Published link" capture/paste card for channels we can record, and
// prefills it with any URL already stored on the article.
function renderPublishUrlCard() {
  const card = $('detail-publish-url-card');
  if (!card) return;

  const backendPlatform = backendPlatformFor(selectedPlatform);
  if (!backendPlatform) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  $('publish-url-error').hidden = true;
  $('pulse-url-notice').hidden = true;
  $('use-pulse-url-btn').hidden = true;
  const input = $('published-url-input');
  input.value = (selectedArticle && selectedArticle.external_url) || '';

  const btn = $('save-published-url-btn');
  btn.disabled = false;
  btn.textContent = 'Save published link';
  btn.classList.remove('cp-copied');
}

function updateFillButton() {
  const btn = $('fill-btn');
  if (!btn) return;
  const platform = PLATFORMS.find((p) => p.id === selectedPlatform) || PLATFORMS[0];
  btn.disabled = false;
  btn.title = `Fill the ${platform.name} editor`;
}

async function handleDownloadImage() {
  if (!selectedArticle || !selectedArticle.image_url) return;
  const btn = $('download-image-btn');
  const url = selectedArticle.image_url;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Downloading…';

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    const ext = (blob.type && blob.type.split('/')[1]) || 'jpg';
    const base = (selectedArticle.seo && selectedArticle.seo.slug) || selectedArticle.id || 'image';
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `${base}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (err) {
    warn('[ContentPulse][popup] image download failed, opening in a tab', err);
    chrome.tabs.create({ url });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function handleManage() {
  if (!selectedArticle) return;
  chrome.tabs.create({ url: `${APP_BASE_URL}/content/${selectedArticle.id}` });
}

function flashCopied(btn) {
  if (!btn) return;
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = 'Copied';
  btn.classList.add('cp-copied');
  setTimeout(() => {
    btn.textContent = btn.dataset.label || original;
    btn.classList.remove('cp-copied');
  }, 1600);
}

async function copyPlainText(text) {
  try {
    await navigator.clipboard.writeText(text || '');
    return true;
  } catch (err) {
    warn('[ContentPulse][popup] clipboard text failed', err);
    return false;
  }
}

async function prepareFormattedClipboard(html) {
  if (!navigator.clipboard || !window.ClipboardItem) return false;
  try {
    const safeHtml = html || '';
    const item = new ClipboardItem({
      'text/html': new Blob([safeHtml], { type: 'text/html' }),
      'text/plain': new Blob([htmlToText(safeHtml)], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch (err) {
    warn('[ContentPulse][popup] rich clipboard preparation failed', err);
    return false;
  }
}

async function copyFormattedHtml(html) {
  const safeHtml = html || '';
  if (await prepareFormattedClipboard(safeHtml)) return true;
  return copyPlainText(safeHtml);
}

function copyValueFor(key) {
  if (!selectedArticle) return '';
  const seo = selectedArticle.seo || {};
  switch (key) {
    case 'title':
      return selectedArticle.title || '';
    case 'meta_title':
      return seo.meta_title || '';
    case 'meta_description':
      return seo.meta_description || '';
    case 'slug':
      return seo.slug || '';
    case 'keywords':
      return Array.isArray(seo.meta_keywords) ? seo.meta_keywords.join(', ') : '';
    case 'credit_caption':
      return creditCaption();
    default:
      return '';
  }
}

async function handleCopyField(btn) {
  const ok = await copyPlainText(copyValueFor(btn.dataset.copy));
  if (ok) flashCopied(btn);
}

async function handleCopyBodyHtml() {
  if (!selectedArticle) return;
  const ok = await copyFormattedHtml(selectedArticle.body_html);
  if (ok) flashCopied($('copy-body-html'));
}

async function handleCopyBodyText() {
  if (!selectedArticle) return;
  const ok = await copyPlainText(htmlToText(selectedArticle.body_html));
  if (ok) flashCopied($('copy-body-text'));
}

async function handleCopyBodyRaw() {
  if (!selectedArticle) return;
  const ok = await copyPlainText(selectedArticle.body_html || '');
  if (ok) flashCopied($('copy-body-raw'));
}

async function handleCopyImageUrl() {
  if (!selectedArticle || !selectedArticle.image_url) return;
  const ok = await copyPlainText(selectedArticle.image_url);
  if (ok) flashCopied($('copy-image-url'));
}

function renderSeo(seo) {
  const card = $('detail-seo');
  const data = seo || {};

  const setRow = (rowId, valId, value) => {
    const hasValue = typeof value === 'string' && value.trim() !== '';
    $(rowId).hidden = !hasValue;
    if (hasValue) $(valId).textContent = value.trim();
    return hasValue;
  };

  const hasTitle = setRow('seo-meta-title-row', 'seo-meta-title', data.meta_title);
  const hasDesc = setRow('seo-meta-desc-row', 'seo-meta-desc', data.meta_description);
  const hasSlug = setRow('seo-slug-row', 'seo-slug', data.slug);

  const keywords = Array.isArray(data.meta_keywords) ? data.meta_keywords.filter((k) => k && `${k}`.trim() !== '') : [];
  const hasKeywords = keywords.length > 0;
  $('seo-keywords-row').hidden = !hasKeywords;
  if (hasKeywords) {
    const chips = $('seo-keywords');
    chips.innerHTML = '';
    for (const kw of keywords) {
      const chip = document.createElement('span');
      chip.className = 'cp-chip';
      chip.textContent = `${kw}`.trim();
      chips.appendChild(chip);
    }
  }

  const hasAny = hasTitle || hasDesc || hasSlug || hasKeywords;
  card.hidden = !hasAny;
  $('seo-empty').hidden = hasAny;
}

async function handleFill() {
  if (!selectedArticle) return;
  $('detail-error').hidden = true;

  const backendPlatform = backendPlatformFor(selectedPlatform);
  if (!backendPlatform) {
    $('detail-error').textContent = 'Choose a supported publishing platform before filling the editor.';
    $('detail-error').hidden = false;
    return;
  }

  log('[ContentPulse][popup] fill ->', selectedArticle.title);
  // Send the open request before doing clipboard work. This lets the
  // background create the destination tab immediately; the LinkedIn fill
  // waits for this token before attempting native rich paste.
  const clipboardToken = backendPlatform === 'linkedin_pulse'
    ? `cp-clipboard-${Date.now()}-${Math.random().toString(36).slice(2)}`
    : '';
  const res = await sendMessage({
    action: 'openAndFill',
    article: {
      id: selectedArticle.id,
      title: selectedArticle.title,
      body_html: selectedArticle.body_html,
      clipboard_prepared: false,
      clipboard_token: clipboardToken,
      platform: backendPlatform,
      // Needed by the background to arm the share-dialog auto-fill.
      share_post: selectedArticle.share_post || null,
      // Connected LinkedIn profile/page of the article's website - the
      // background checks the editor's "Publish as" selector against it.
      publish_as: selectedWebsiteLinkedInAuthor(),
      // Open the editor directly as the configured LinkedIn company/profile.
      publish_as_urn: selectedWebsiteLinkedInAuthorUrn(),
      // Featured image - dropped into LinkedIn's cover image input.
      image_url: selectedArticle.image_url || null,
      // Filled into the cover's "Add credit and caption" field after the image.
      credit: creditCaption(),
      // SEO title/description - filled into the editor's Settings panel and
      // saved as the last step of the automated chain.
      seo: selectedArticle.seo
        ? {
            meta_title: selectedArticle.seo.meta_title || '',
            meta_description: selectedArticle.seo.meta_description || '',
          }
        : null,
      // Tags and categories - used by Medium for "Reader Interests" (up to 5).
      tags: selectedArticle.tags || [],
      categories: selectedArticle.categories || [],
      // Canonical URL for cross-posted content (Medium "More settings").
      article_url: selectedArticle.article_url || null,
      // Substack publication slug/domain used when the scheduled flow needs
      // to open a new editor instead of filling an already-open one.
      substack_domain: selectedArticle.substack_domain || '',
    },
  });

  if (res && res.ok) {
    if (clipboardToken) {
      const clipboardPrepared = await prepareFormattedClipboard(selectedArticle.body_html);
      await sendMessage({ action: 'clipboardPrepared', token: clipboardToken, prepared: clipboardPrepared });
    }
    closeUi();
  } else {
    const el = $('detail-error');
    const platform = PLATFORMS.find((p) => p.id === selectedPlatform) || PLATFORMS[0];
    el.textContent = res?.error || `Could not open the ${platform.name} editor.`;
    el.hidden = false;
  }
}

// Kicks off LinkedIn's own scheduling flow on the open editor tab: clicks the
// editor's top-nav Next, then the clock ("Schedule post") button in the share
// dialog. The user picks the date/time in LinkedIn's picker.
async function handleSchedule() {
  $('detail-error').hidden = true;

  const res = await sendMessage({
    action: 'schedulePost',
    scheduledAt: (selectedArticle && selectedArticle.scheduled_date) || null,
  });

  if (res && res.ok) {
    closeUi();
    return;
  }
  const el = $('detail-error');
  el.textContent = res?.error || 'Could not start the schedule flow. Open the LinkedIn editor tab first.';
  el.hidden = false;
}

async function handleSavePublishedUrl() {
  if (!selectedArticle) return;

  const input = $('published-url-input');
  const errEl = $('publish-url-error');
  const btn = $('save-published-url-btn');
  errEl.hidden = true;

  const remoteUrl = (input.value || '').trim();
  const backendPlatform = backendPlatformFor(selectedPlatform);

  if (!backendPlatform) {
    errEl.textContent = 'This platform does not support saving a published link.';
    errEl.hidden = false;
    return;
  }
  if (remoteUrl === '') {
    errEl.textContent = 'Paste the live article URL first.';
    errEl.hidden = false;
    return;
  }

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const res = await sendMessage({
    action: 'recordPublication',
    contentId: selectedArticle.id,
    platform: backendPlatform,
    remoteUrl,
  });

  btn.disabled = false;

  if (res && res.ok) {
    selectedArticle.external_url = selectedArticle.external_url || remoteUrl;
    btn.textContent = 'Saved ✓';
    btn.classList.add('cp-copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('cp-copied');
    }, 1600);
    return;
  }

  btn.textContent = original;
  errEl.textContent = res?.error || 'Could not save the published link. Please check the URL and try again.';
  errEl.hidden = false;
}

async function handleFillSeo() {
  if (!selectedArticle) return;
  $('detail-error').hidden = true;

  const seo = selectedArticle.seo || {};
  const metaTitle = seo.meta_title || '';
  const metaDescription = seo.meta_description || '';

  if (metaTitle.trim() === '' && metaDescription.trim() === '') {
    const el = $('detail-error');
    el.textContent = 'This article has no SEO title or description to fill.';
    el.hidden = false;
    return;
  }

  const btn = $('fill-seo-btn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Filling…';

  log('[ContentPulse][popup] fill SEO ->', selectedArticle.title);
  const res = await sendMessage({
    action: 'fillSeo',
    seo: { meta_title: metaTitle, meta_description: metaDescription },
  });

  btn.disabled = false;

  if (res && res.ok) {
    btn.textContent = 'Filled ✓';
    btn.classList.add('cp-copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('cp-copied');
    }, 1600);
    if (res.pulseUrl) offerPulseUrl(res.pulseUrl);
    return;
  }

  btn.textContent = original;
  const el = $('detail-error');
  el.textContent =
    res?.error || 'Could not fill the SEO fields. Open the LinkedIn article editor, then try again.';
  el.hidden = false;
}

// The SEO fill also creates/reads the article's permanent pulse URL. Feed it
// into the Published link card: prefill when empty, or warn (with a one-click
// "Use new URL" button) when it differs from what is already there.
function offerPulseUrl(pulseUrl) {
  const input = $('published-url-input');
  const notice = $('pulse-url-notice');
  const useBtn = $('use-pulse-url-btn');
  const current = (input.value || '').trim();

  notice.hidden = true;
  useBtn.hidden = true;

  if (current === pulseUrl) return;

  if (current === '') {
    input.value = pulseUrl;
    notice.textContent = 'URL captured from LinkedIn - click "Save published link" to store it.';
    notice.hidden = false;
  } else {
    notice.textContent = `LinkedIn now reports a different URL: ${pulseUrl} - do you want to change it?`;
    notice.hidden = false;
    useBtn.hidden = false;
    useBtn.onclick = () => {
      input.value = pulseUrl;
      useBtn.hidden = true;
      notice.textContent = 'URL replaced - click "Save published link" to store it.';
    };
  }

  // The card lives in the Publish tab; make the prompt visible right away.
  showDetailTab('publish');
}

async function handleFillImage() {
  if (!selectedArticle || !selectedArticle.image_url) return;
  $('fill-image-error').hidden = true;

  const btn = $('fill-image-btn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Filling…';

  log('[ContentPulse][popup] fill cover image ->', selectedArticle.title);
  const res = await sendMessage({ action: 'fillCoverImage', imageUrl: selectedArticle.image_url, credit: creditCaption() });

  btn.disabled = false;

  if (res && res.ok) {
    btn.textContent = 'Filled ✓';
    btn.classList.add('cp-copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('cp-copied');
    }, 1600);
    return;
  }

  btn.textContent = original;
  const el = $('fill-image-error');
  el.textContent = res?.error || 'Could not fill the cover image. Open the LinkedIn article editor, then try again.';
  el.hidden = false;
}

async function renderSettings() {
  const { user, apiKey, [AUTO_FILL_SCHEDULED_KEY]: autoFillEnabled } = await getStored([
    'user',
    'apiKey',
    AUTO_FILL_SCHEDULED_KEY,
  ]);
  $('settings-name').textContent = user?.name || 'Unknown user';
  $('settings-email').textContent = user?.email || '';
  $('settings-key').textContent = apiKey ? `••••••••${apiKey.slice(-4)}` : 'Not set';
  const toggle = $('scheduled-auto-fill-toggle');
  if (toggle) toggle.checked = autoFillEnabled === true;
  const status = $('scheduled-auto-fill-status');
  if (status) {
    status.textContent = autoFillEnabled === true
      ? 'Feature flag on. The icon badge shows how many extension articles are scheduled for today.'
      : 'Feature flag off. Turn this on to enable time-based editor filling.';
  }
}

// In-extension confirm dialog (window.confirm/alert are blocked or ugly in the
// embedded panel). Resolves true on confirm, false on cancel/Escape/backdrop.
function showConfirm({ title, text, okLabel = 'Continue', danger = true }) {
  return new Promise((resolve) => {
    const overlay = $('cp-confirm-overlay');
    const okBtn = $('cp-confirm-ok');
    const cancelBtn = $('cp-confirm-cancel');
    $('cp-confirm-title').textContent = title;
    $('cp-confirm-text').textContent = text;
    okBtn.textContent = okLabel;
    okBtn.classList.toggle('cp-btn-danger', danger);
    okBtn.classList.toggle('cp-btn-primary', !danger);
    overlay.hidden = false;

    const done = (result) => {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => {
      if (e.target === overlay) done(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    cancelBtn.focus();
  });
}

async function handleChangeKey() {
  const confirmed = await showConfirm({
    title: 'Change API key?',
    text: 'You will be taken back to the connect screen and signed out of this session. You will need to enter a valid API key to get back in.',
    okLabel: 'Change key',
  });
  if (!confirmed) return;
  log('[ContentPulse][popup] change API key (no reset until a new key is saved)');
  $('api-key-input').value = '';
  showOnboardingError('');
  enterDisconnectedShell();
}

async function handleDisconnect() {
  const confirmed = await showConfirm({
    title: 'Disconnect ContentPulse?',
    text: 'This signs you out and removes the stored API key. You will need to re-enter your API key to reconnect.',
    okLabel: 'Disconnect',
  });
  if (!confirmed) return;
  log('[ContentPulse][popup] disconnect');
  await clearStored();
  window.location.reload();
}

let redditTabId = null;
let redditLastPayload = null;

async function checkRedditTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    const isReddit = url.includes('reddit.com/r/');
    redditTabId = isReddit ? tab.id : null;

    if (isReddit) {
      $('reddit-tools-btn').hidden = false;
    }
  } catch (_e) {
    redditTabId = null;
  }
}

async function showRedditBtnIfNeeded() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('reddit.com/r/')) {
      $('reddit-tools-btn').hidden = false;
    }
  } catch (_e) {}
}

function redditExtractFunc() {
  function extractSubredditInfo() {
    const header = document.querySelector('shreddit-subreddit-header');
    if (!header) return null;
    const name = header.getAttribute('name') || header.getAttribute('prefixed-name')?.replace('r/', '') || null;
    return {
      name,
      title: header.querySelector('#title')?.textContent?.trim() || name,
      description: header.querySelector('#description')?.textContent?.trim() || document.querySelector('#description')?.textContent?.trim() || document.querySelector('.i18n-subreddit-description')?.textContent?.trim() || '',
      subscribers: header.querySelector('[slot="subscribers-count"]')?.textContent?.trim() || null,
      weekly_visitors: parseInt(header.getAttribute('weekly-active-users') || '0', 10),
      weekly_contributions: parseInt(header.getAttribute('weekly-contributions') || '0', 10),
    };
  }
  function extractRules() {
    const rules = [];
    const allH2 = document.querySelectorAll('h2');
    let container = null;
    for (const h2 of allH2) {
      if (h2.textContent?.includes('Rules')) { container = h2.closest('.px-md') || h2.parentElement; break; }
    }
    if (!container) return rules;
    container.querySelectorAll('faceplate-expandable-section-helper').forEach((section) => {
      const numberEl = section.querySelector('.text-neutral-content-weak.text-14.font-normal');
      const titleEl = section.querySelector('h2.i18n-translatable-text');
      const descEl = section.querySelector('.i18n-translatable-text.ms-xl .md p');
      const ruleTitle = titleEl?.textContent?.trim() || '';
      if (ruleTitle) rules.push({ number: parseInt(numberEl?.textContent?.trim() || '', 10) || rules.length + 1, title: ruleTitle, description: descEl?.textContent?.trim() || '' });
    });
    return rules;
  }
  function extractPostData() {
    const post = document.querySelector('shreddit-post');
    if (!post) return null;
    const titleEl = document.querySelector('[id^="post-title-"]');
    const bodyEl = post.querySelector('[slot="text-body"] .md');
    return { id: post.getAttribute('id') || null, title: titleEl?.textContent?.trim() || post.getAttribute('post-title') || '', author: post.getAttribute('author') || '', subreddit: post.getAttribute('subreddit-prefixed-name') || '', score: parseInt(post.getAttribute('score') || '0', 10), comment_count: parseInt(post.getAttribute('comment-count') || '0', 10), created: post.getAttribute('created-timestamp') || null, permalink: post.getAttribute('permalink') || null, post_type: post.getAttribute('post-type') || 'text', body: bodyEl?.textContent?.trim() || null };
  }
  function extractComments() {
    const comments = [];
    document.querySelectorAll('shreddit-comment').forEach((el) => {
      const author = el.getAttribute('author') || '';
      const body = el.querySelector('.md')?.textContent?.trim() || '';
      if (author && body && author !== 'AutoModerator') {
        comments.push({ id: el.getAttribute('thingid') || '', author, body, score: parseInt(el.getAttribute('score') || '0', 10), depth: parseInt(el.getAttribute('depth') || '0', 10), created: el.getAttribute('created') || null, permalink: el.getAttribute('permalink') ? 'https://www.reddit.com' + el.getAttribute('permalink') : null });
      }
    });
    return comments;
  }
  function detectLoggedInUser() {
    const el = document.querySelector('achievements-entrypoint[username]') ||
               document.querySelector('after-login-toast-dispatcher[username]');
    return el?.getAttribute('username') || null;
  }
  const url = window.location.href;
  const isPost = url.includes('/comments/');
  const result = { collected_at: new Date().toISOString(), url, page_type: isPost ? 'post' : 'subreddit', subreddit: extractSubredditInfo(), rules: extractRules(), logged_in_username: detectLoggedInUser() };
  if (isPost) { result.post = extractPostData(); result.comments = extractComments(); }
  return result;
}

async function redditCollectAndSync() {
  if (!redditTabId) {
    $('reddit-sync-status').textContent = 'Open a Reddit community or post to sync.';
    return;
  }
  const errEl = $('reddit-error');
  errEl.hidden = true;
  $('reddit-sync-status').textContent = 'Syncing with ContentPulse...';
  $('reddit-info-card').hidden = true;
  $('reddit-note-card').hidden = true;
  $('reddit-drafts-card').hidden = true;
  $('reddit-synced-comments-card').hidden = true;

  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: redditTabId }, func: redditExtractFunc });
    const data = results?.[0]?.result;
    if (!data) {
      errEl.textContent = 'No data found. Make sure you are on a Reddit community or post page.';
      errEl.hidden = false;
      $('reddit-sync-status').textContent = 'Could not sync.';
      return;
    }

    redditLastPayload = data;

    if (selectedWebsiteId) {
      data.website_id = selectedWebsiteId;
    }

    const res = await sendMessage({ action: 'redditIngest', payload: data });

    let summary = '';
    if (data.subreddit) {
      summary += `<strong>r/${data.subreddit.name}</strong>`;
      if (data.subreddit.subscribers) summary += ` &middot; ${data.subreddit.subscribers} members`;
      if (data.subreddit.weekly_visitors) summary += ` &middot; ${data.subreddit.weekly_visitors.toLocaleString()} weekly visitors`;
      if (data.subreddit.weekly_contributions) summary += ` &middot; ${data.subreddit.weekly_contributions.toLocaleString()} weekly posts`;
      summary += '<br>';
    }
    if (data.rules?.length) summary += `${data.rules.length} community rules<br>`;
    if (data.post) summary += `Post: "${data.post.title}" (${data.post.score} upvotes)<br>`;
    if (data.comments?.length) {
      summary += `${data.comments.length} comments synced<br>`;
      renderSyncedComments(data.comments, res?.data?.updated, data.logged_in_username);
    }

    if (res && res.ok) {
      const d = res.data?.updated || {};
      summary += '<span style="color:#22c55e">Synced to ContentPulse</span>';

      if (d.admin_note) {
        $('reddit-note-text').textContent = d.admin_note;
        $('reddit-note-card').hidden = false;

        if (d.comment_posted_at) {
          $('reddit-note-sent-badge').hidden = false;
          $('reddit-mark-sent-area').hidden = true;
          if (d.comment_posted_url) {
            $('reddit-comment-link').href = d.comment_posted_url;
            $('reddit-comment-link').hidden = false;
          }
        } else {
          $('reddit-mark-sent-area').hidden = false;
          $('reddit-mark-sent-area').dataset.oppId = d.ulid || d.id || '';
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.url) $('reddit-comment-url-input').value = tabs[0].url;
          });
        }
      }

      const drafts = res.data?.ready_drafts || [];
      renderReadyDrafts(drafts);
    } else {
      summary += '<span style="color:#f59e0b">Collected but not synced (no matching record)</span>';
    }

    $('reddit-summary').innerHTML = summary;
    $('reddit-info-card').hidden = false;
    $('reddit-sync-status').textContent = 'Synced';
  } catch (e) {
    errEl.textContent = e.message || 'Could not collect data from this page.';
    errEl.hidden = false;
    $('reddit-sync-status').textContent = 'Sync failed.';
  }
}

function renderReadyDrafts(drafts) {
  const card = $('reddit-drafts-card');
  const list = $('reddit-drafts-list');
  list.innerHTML = '';

  if (!drafts || drafts.length === 0) {
    card.hidden = true;
    return;
  }

  for (const draft of drafts) {
    const item = document.createElement('div');
    item.style.cssText = 'padding:6px 0;border-bottom:1px solid #f1f5f9';

    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';

    const titleLink = document.createElement('a');
    titleLink.href = draft.reddit_url || '#';
    titleLink.target = '_blank';
    titleLink.rel = 'noopener';
    titleLink.textContent = draft.title || 'Untitled';
    titleLink.style.cssText = 'font-size:12px;font-weight:600;color:#1e293b;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const cpLink = document.createElement('a');
    cpLink.href = draft.dashboard_url || '#';
    cpLink.target = '_blank';
    cpLink.rel = 'noopener';
    cpLink.title = 'Open in ContentPulse';
    cpLink.textContent = 'CP';
    cpLink.style.cssText = 'font-size:9px;font-weight:700;color:#fff;background:#52227a;padding:2px 5px;border-radius:4px;text-decoration:none;flex-shrink:0';

    titleRow.appendChild(titleLink);
    titleRow.appendChild(cpLink);

    const noteEl = document.createElement('p');
    noteEl.textContent = draft.admin_note;
    noteEl.style.cssText = 'font-size:11px;color:#64748b;margin:0;white-space:pre-wrap;max-height:60px;overflow:hidden';

    item.appendChild(titleRow);
    item.appendChild(noteEl);
    list.appendChild(item);
  }

  card.hidden = false;
}

function renderSyncedComments(comments, updatedOpp, loggedInUsername) {
  const list = $('reddit-synced-comments-list');
  const card = $('reddit-synced-comments-card');
  if (!list || !comments?.length) { if (card) card.hidden = true; return; }

  const oppId = updatedOpp?.ulid || updatedOpp?.id || '';
  const alreadySent = !!updatedOpp?.comment_posted_at;

  const displayComments = loggedInUsername
    ? comments.filter((c) => (c.author || '').toLowerCase() === loggedInUsername.toLowerCase())
    : comments;

  if (!displayComments.length) { if (card) card.hidden = true; return; }

  list.innerHTML = displayComments.slice(0, 15).map((c) => {
    const author = c.author || 'unknown';
    const text = (c.comment || c.body || '').slice(0, 120);
    const url = c.permalink || c.url || '';
    const canClaim = !alreadySent && oppId && url;
    const checkIcon = canClaim
      ? `<button class="reddit-claim-comment-btn" data-opp-id="${oppId}" data-url="${url}" title="Mark as my comment" style="background:none;border:none;cursor:pointer;padding:0;line-height:1;color:#10b981;font-size:14px;flex-shrink:0">&#10003;</button>`
      : '';
    return `<div style="padding:4px 0;border-bottom:1px solid #f1f5f9;display:flex;align-items:flex-start;gap:4px">
      ${checkIcon}
      <div style="flex:1;min-width:0"><strong style="color:#6366f1">u/${author}</strong> <span style="color:#94a3b8">${text}${text.length >= 120 ? '...' : ''}</span></div>
    </div>`;
  }).join('');

  card.hidden = false;

  list.querySelectorAll('.reddit-claim-comment-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const oid = btn.dataset.oppId;
      const curl = btn.dataset.url;
      btn.disabled = true;
      btn.textContent = '\u23F3';
      const res = await sendMessage({ action: 'markCommentSent', oppId: oid, commentUrl: curl });
      if (res && res.ok) {
        btn.textContent = '\u2714';
        btn.style.color = '#22c55e';
        btn.disabled = true;
        $('reddit-mark-sent-area').hidden = true;
        $('reddit-note-sent-badge').hidden = false;
        if (curl) {
          $('reddit-comment-link').href = curl;
          $('reddit-comment-link').hidden = false;
        }
        list.querySelectorAll('.reddit-claim-comment-btn').forEach((b) => { b.disabled = true; b.textContent = ''; b.style.cursor = 'default'; });
      } else {
        btn.textContent = '\u2717';
        btn.style.color = '#ef4444';
      }
    });
  });
}

async function handleMarkCommentSent() {
  const area = $('reddit-mark-sent-area');
  const btn = $('reddit-mark-sent-btn');
  const urlInput = $('reddit-comment-url-input');
  const oppId = area.dataset.oppId;

  if (!oppId) return;

  btn.disabled = true;
  btn.textContent = 'Saving...';

  const commentUrl = (urlInput?.value || '').trim();
  const res = await sendMessage({ action: 'markCommentSent', oppId, commentUrl });

  if (res && res.ok) {
    area.hidden = true;
    $('reddit-note-sent-badge').hidden = false;
    if (commentUrl) {
      $('reddit-comment-link').href = commentUrl;
      $('reddit-comment-link').hidden = false;
    }
  } else {
    btn.textContent = 'Failed - retry';
  }
  btn.disabled = false;
}

function showInitError(error) {
  const boot = $('screen-boot');
  if (!boot) return;
  const message = error instanceof Error ? error.message : String(error || 'Unknown initialization error');
  boot.hidden = false;
  boot.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'cp-boot-inner';
  const title = document.createElement('strong');
  title.textContent = 'Publisher could not load';
  const detail = document.createElement('p');
  detail.className = 'cp-boot-text';
  detail.textContent = IS_EMBEDDED
    ? 'Reload the page once to reconnect the publisher panel.'
    : 'Reload the extension and try again.';
  const diagnostic = document.createElement('small');
  diagnostic.className = 'cp-help';
  diagnostic.textContent = message;
  inner.append(title, detail, diagnostic);
  boot.appendChild(inner);
  console.error('[ContentPulse][popup] initialization failed', error);
}

async function initImpl() {
  renderMarquee();
  $('save-connect-btn').addEventListener('click', handleSaveConnect);
  $('api-key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSaveConnect();
  });
  $('refresh-btn').addEventListener('click', () => loadArticles(selectedWebsiteId));
  $('website-select').addEventListener('change', handleWebsiteChange);
  $('settings-btn').addEventListener('click', () => showTab('settings'));
  $('settings-back-btn').addEventListener('click', () => showTab('list'));
  $('scheduled-auto-fill-toggle').addEventListener('change', async (event) => {
    const toggle = event.currentTarget;
    const enabled = toggle.checked;
    toggle.disabled = true;
    const res = await sendMessage({ action: 'setScheduledAutoFill', enabled });
    toggle.disabled = false;
    if (!res || !res.ok) {
      toggle.checked = !enabled;
      $('scheduled-auto-fill-status').textContent = res?.error || 'Could not update the feature flag.';
      return;
    }
    $('scheduled-auto-fill-status').textContent = enabled
      ? 'Feature flag on. The icon badge shows how many extension articles are scheduled for today.'
      : 'Feature flag off. Scheduled editor filling is disabled.';
  });
  $('reddit-tools-btn').addEventListener('click', async () => {
    showScreen('screen-reddit');
    await checkRedditTab();
    redditCollectAndSync();
  });
  $('reddit-back-btn').addEventListener('click', () => showTab('list'));
  $('reddit-mark-sent-btn').addEventListener('click', handleMarkCommentSent);
  $('reddit-copy-note-btn').addEventListener('click', () => {
    const text = $('reddit-note-text').textContent || '';
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        const btn = $('reddit-copy-note-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    }
  });
  $('detail-back-btn').addEventListener('click', () => showTab('list'));
  $('fill-btn').addEventListener('click', handleFill);
  $('schedule-btn').addEventListener('click', handleSchedule);
  $('fill-seo-btn').addEventListener('click', handleFillSeo);
  $('save-published-url-btn').addEventListener('click', handleSavePublishedUrl);
  $('copy-share-post-btn').addEventListener('click', handleCopySharePost);
  $('fill-share-post-btn').addEventListener('click', handleFillSharePost);
  $('platform-select').addEventListener('change', (e) => {
    selectedPlatform = e.target.value;
    renderPlatformAction();
  });
  for (const tab of DETAIL_TABS) {
    $(`dtab-btn-${tab}`).addEventListener('click', () => showDetailTab(tab));
  }
  $('fill-info-btn').addEventListener('click', () => {
    const info = $('fill-info-text');
    info.hidden = !info.hidden;
  });
  $('fill-image-btn').addEventListener('click', handleFillImage);
  $('download-image-btn').addEventListener('click', handleDownloadImage);
  $('copy-image-url').addEventListener('click', handleCopyImageUrl);
  $('manage-btn').addEventListener('click', handleManage);
  $('copy-body-html').addEventListener('click', handleCopyBodyHtml);
  $('copy-body-text').addEventListener('click', handleCopyBodyText);
  $('copy-body-raw').addEventListener('click', handleCopyBodyRaw);
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', () => handleCopyField(btn));
  }
  $('change-key-btn').addEventListener('click', handleChangeKey);
  $('disconnect-btn').addEventListener('click', handleDisconnect);

  const { apiKey } = await getStored(['apiKey']);
  if (!apiKey) {
    enterDisconnectedShell();
    return;
  }

  log('[ContentPulse][popup] existing key found, verifying it is still valid');
  showScreen('screen-boot');
  const res = await sendMessage({ action: 'validateKey', apiKey });

  if (res && res.ok) {
    await setStored({ user: res.user, tenant: res.tenant });
    await enterConnectedShell();
    return;
  }

  if (res && res.status === 401) {
    warn('[ContentPulse][popup] stored key is no longer valid, signing out');
    await clearStored();
    enterDisconnectedShell();
    showOnboardingError('Your access has ended or the key was revoked. Please reconnect.');
    return;
  }

  warn('[ContentPulse][popup] could not verify key (offline?), showing cached queue');
  await enterConnectedShell();
}

async function init() {
  try {
    await initImpl();
  } catch (error) {
    showInitError(error);
  }
}

window.addEventListener('error', (event) => {
  if (event?.error) showInitError(event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  if (event?.reason) showInitError(event.reason);
});

// A panel iframe can be restored from the browser's page cache with the DOM
// already ready. In that case a DOMContentLoaded-only bootstrap never runs
// and all sections remain in their initial state. Start in either lifecycle.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
