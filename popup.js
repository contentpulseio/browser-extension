const $ = (id) => document.getElementById(id);

const CP_DEBUG = false;
const log = (...args) => {
  if (CP_DEBUG) console.log(...args);
};
const warn = (...args) => {
  if (CP_DEBUG) console.warn(...args);
};

const SCREENS = ['screen-onboarding', 'screen-list', 'screen-detail', 'screen-settings'];

const APP_BASE_URL = 'https://app.contentpulse.io';

function showScreen(id) {
  log('[ContentPulse][popup] show screen', id);
  for (const s of SCREENS) {
    $(s).hidden = s !== id;
  }
}

function setTabbarVisible(visible) {
  $('tabbar').hidden = !visible;
}

function setActiveTab(tab) {
  $('tab-list').classList.toggle('cp-tab-active', tab === 'list');
  $('tab-settings').classList.toggle('cp-tab-active', tab === 'settings');
}

const CONNECTION_ERROR_HINTS = [
  'Receiving end does not exist',
  'Could not establish connection',
  'message port closed',
];

function sendOnce(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, status: 0, error: chrome.runtime.lastError.message, _connError: true });
        return;
      }
      resolve(response);
    });
  });
}

async function sendMessage(message, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await sendOnce(message);
    const isConnError =
      res &&
      res._connError &&
      CONNECTION_ERROR_HINTS.some((h) => (res.error || '').toLowerCase().includes(h.toLowerCase()));
    if (!isConnError) {
      return res;
    }
    warn(`[ContentPulse][popup] worker not ready (attempt ${i + 1}/${attempts}), retrying…`);
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
  }
  return { ok: false, status: 0, error: 'Background service worker did not respond. Try again.' };
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
  { id: 'linkedin', name: 'LinkedIn', live: true, icon: 'assets/platforms/linkedin.svg' },
  { id: 'medium', name: 'Medium', live: false, icon: 'assets/platforms/medium.svg' },
  { id: 'wordpress', name: 'WordPress', live: false, icon: 'assets/platforms/wordpress.svg' },
  { id: 'webflow', name: 'Webflow', live: false, icon: 'assets/platforms/webflow.svg' },
  { id: 'wix', name: 'Wix', live: false, icon: 'assets/platforms/wix.svg' },
  { id: 'shopify', name: 'Shopify', live: false, icon: 'assets/platforms/shopify.svg' },
];

const MARQUEE_PLATFORMS = [
  ...PLATFORMS,
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

function creditCaption() {
  if (!selectedArticle) return '';
  const caption = selectedArticle.title || '';
  const credit = selectedWebsiteName();
  return credit ? `${caption}, ${credit}` : caption;
}

async function enterConnectedShell() {
  setTabbarVisible(true);
  showTab('list');
  await refreshAccount();
  await loadWebsites();
  await loadArticles(selectedWebsiteId);
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
  setTabbarVisible(false);
  $('account-bar').hidden = true;
  showScreen('screen-onboarding');
}

function showTab(tab) {
  setActiveTab(tab);
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
      return;
    }
    const el = $('list-error');
    el.textContent = res?.error || 'Failed to load articles.';
    el.hidden = false;
    return;
  }

  currentArticles = res.articles || [];
  renderArticleList();
}

function renderArticleList() {
  const container = $('article-list');
  container.innerHTML = '';

  if (currentArticles.length === 0) {
    $('list-empty').hidden = false;
    return;
  }
  $('list-empty').hidden = true;

  for (const article of currentArticles) {
    const card = document.createElement('div');
    card.className = 'cp-article-card';

    const main = document.createElement('div');
    main.className = 'cp-article-main';

    if (article.image_url) {
      const thumb = document.createElement('img');
      thumb.className = 'cp-article-thumb';
      thumb.src = article.image_url;
      thumb.alt = '';
      thumb.loading = 'lazy';

      thumb.addEventListener('error', () => thumb.remove());
      main.appendChild(thumb);
    }

    const info = document.createElement('div');
    info.className = 'cp-article-info';

    const top = document.createElement('div');
    top.className = 'cp-article-top';

    const title = document.createElement('div');
    title.className = 'cp-article-title';
    title.textContent = article.title;

    const badge = document.createElement('span');
    badge.className = `cp-badge ${statusColor(article.status)}`;
    badge.textContent = article.status;

    top.appendChild(title);
    top.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'cp-article-meta';
    const date = formatDate(article.scheduled_date);
    meta.textContent = date ? `Scheduled ${date}` : 'Not scheduled';

    info.appendChild(top);
    info.appendChild(meta);
    main.appendChild(info);

    const btn = document.createElement('button');
    btn.className = 'cp-btn cp-btn-primary cp-btn-sm cp-btn-block';
    btn.textContent = 'Publish';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDetail(article);
    });

    card.appendChild(main);
    card.appendChild(btn);
    card.addEventListener('click', () => openDetail(article));

    container.appendChild(card);
  }
}

function openDetail(article) {
  selectedArticle = article;
  selectedPlatform = (PLATFORMS.find((p) => p.live) || PLATFORMS[0]).id;
  $('detail-error').hidden = true;

  const text = article.excerpt && article.excerpt.trim() !== '' ? article.excerpt : htmlToText(article.body_html);
  const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;

  $('detail-title').textContent = article.title;
  $('detail-excerpt').textContent = excerpt || 'No preview available.';
  $('detail-wordcount').textContent = `${wordCount(htmlToText(article.body_html))} words`;
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
  const tabs = $('platform-tabs');
  tabs.innerHTML = '';
  for (const platform of PLATFORMS) {
    const btn = document.createElement('button');
    btn.className = 'cp-platform-tab';
    btn.classList.toggle('cp-platform-tab-active', platform.id === selectedPlatform);
    btn.dataset.platform = platform.id;
    if (platform.icon) {
      const icon = document.createElement('img');
      icon.src = platform.icon;
      icon.alt = '';
      icon.className = 'cp-platform-tab-icon';
      btn.appendChild(icon);
    }
    btn.appendChild(document.createTextNode(platform.name));
    if (platform.live) {
      const dot = document.createElement('span');
      dot.className = 'cp-platform-live-dot';
      dot.textContent = 'Live';
      btn.appendChild(dot);
    }
    btn.addEventListener('click', () => {
      selectedPlatform = platform.id;
      renderPlatformTabs();
      renderPlatformAction();
    });
    tabs.appendChild(btn);
  }
}

function renderPlatformAction() {
  const wrap = $('platform-action');
  wrap.innerHTML = '';
  const platform = PLATFORMS.find((p) => p.id === selectedPlatform) || PLATFORMS[0];

  const note = document.createElement('p');
  note.className = 'cp-help' + (platform.live ? '' : ' cp-platform-soon');
  note.textContent = platform.live
    ? `"Fill in editor" drops the title and body into ${platform.name}. Copy the SEO and credit/caption below into their fields.`
    : `Direct fill for ${platform.name} is coming soon.`;
  wrap.appendChild(note);

  updateFillButton();
}

function updateFillButton() {
  const btn = $('fill-btn');
  if (!btn) return;
  const platform = PLATFORMS.find((p) => p.id === selectedPlatform) || PLATFORMS[0];
  btn.disabled = !platform.live;
  btn.title = platform.live
    ? `Fill the ${platform.name} editor`
    : `Direct fill for ${platform.name} is coming soon. Use the copy buttons below.`;
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

async function copyFormattedHtml(html) {
  const safeHtml = html || '';
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const item = new ClipboardItem({
        'text/html': new Blob([safeHtml], { type: 'text/html' }),
        'text/plain': new Blob([htmlToText(safeHtml)], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return true;
    }
  } catch (err) {
    warn('[ContentPulse][popup] clipboard html failed, falling back to text', err);
  }
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

  card.hidden = !(hasTitle || hasDesc || hasSlug || hasKeywords);
}

async function handleFill() {
  if (!selectedArticle) return;
  $('detail-error').hidden = true;

  log('[ContentPulse][popup] fill ->', selectedArticle.title);
  const res = await sendMessage({
    action: 'openAndFill',
    article: { title: selectedArticle.title, body_html: selectedArticle.body_html },
  });

  if (res && res.ok) {
    window.close();
  } else {
    const el = $('detail-error');
    el.textContent = res?.error || 'Could not open the LinkedIn editor.';
    el.hidden = false;
  }
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
    return;
  }

  btn.textContent = original;
  const el = $('detail-error');
  el.textContent =
    res?.error || 'Could not fill the SEO fields. Open the LinkedIn article editor and its Settings (SEO) panel, then try again.';
  el.hidden = false;
}

async function renderSettings() {
  const { user, apiKey } = await getStored(['user', 'apiKey']);
  $('settings-name').textContent = user?.name || 'Unknown user';
  $('settings-email').textContent = user?.email || '';
  $('settings-key').textContent = apiKey ? `••••••••${apiKey.slice(-4)}` : 'Not set';
}

async function handleChangeKey() {
  log('[ContentPulse][popup] change API key (no reset until a new key is saved)');
  $('api-key-input').value = '';
  showOnboardingError('');
  enterDisconnectedShell();
}

async function handleDisconnect() {
  const confirmed = window.confirm('Disconnect ContentPulse? You will need to re-enter your API key.');
  if (!confirmed) return;
  log('[ContentPulse][popup] disconnect');
  await clearStored();
  window.location.reload();
}

async function init() {
  renderMarquee();
  $('save-connect-btn').addEventListener('click', handleSaveConnect);
  $('api-key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSaveConnect();
  });
  $('refresh-btn').addEventListener('click', () => loadArticles(selectedWebsiteId));
  $('website-select').addEventListener('change', handleWebsiteChange);
  $('tab-list').addEventListener('click', () => showTab('list'));
  $('tab-settings').addEventListener('click', () => showTab('settings'));
  $('detail-back-btn').addEventListener('click', () => showTab('list'));
  $('fill-btn').addEventListener('click', handleFill);
  $('fill-seo-btn').addEventListener('click', handleFillSeo);
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

document.addEventListener('DOMContentLoaded', init);
