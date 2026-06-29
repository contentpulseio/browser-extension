console.log('[ContentPulse][cs] content script loaded on', location.href);

const MAX_ATTEMPTS = 10;
const ATTEMPT_INTERVAL_MS = 500;

const TITLE_SELECTORS = [
  '#article-editor-headline__textarea',
  'textarea.article-editor-headline__textarea',
  'textarea[name="article-title"]',
  'textarea[aria-label*="title" i]',
  'textarea[placeholder*="title" i]',
  '.article-editor-title__input',
  'h1[contenteditable="true"]',
  '[data-placeholder*="title" i]',
  '[aria-label*="title" i][contenteditable="true"]',
];

const BODY_SELECTORS = [
  '[data-test-article-editor-content-textbox]',
  'div.ProseMirror[contenteditable="true"]',
  '.ql-editor[contenteditable="true"]',
  '.article-editor-content [contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  '[aria-label*="article content" i][contenteditable="true"]',
  '[data-placeholder*="write" i][contenteditable="true"]',
];

function stripHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc.body.querySelectorAll('p, br, div, h1, h2, h3, h4, li').forEach((el) => {
    el.append('\n');
  });
  const text = doc.body.textContent || '';
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function findFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function waitForEditor() {
  return new Promise((resolve) => {
    let attempts = 0;
    const tick = () => {
      attempts += 1;
      const titleEl = findFirst(TITLE_SELECTORS);
      const bodyEl = findFirst(BODY_SELECTORS);
      console.log(`[ContentPulse][cs] editor probe ${attempts}/${MAX_ATTEMPTS}`, {
        title: !!titleEl,
        body: !!bodyEl,
      });
      if (titleEl && bodyEl) {
        resolve({ titleEl, bodyEl });
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        resolve({ titleEl, bodyEl });
        return;
      }
      setTimeout(tick, ATTEMPT_INTERVAL_MS);
    };
    tick();
  });
}

function insertText(el, text) {
  el.focus();

  const isContentEditable = el.isContentEditable;

  if (isContentEditable) {

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  } else if ('value' in el) {
    el.select?.();
  }

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch (err) {
    console.warn('[ContentPulse][cs] execCommand insertText threw', err);
  }

  if (!inserted) {
    if ('value' in el) {
      el.value = text;
    } else {
      el.textContent = text;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

function showToast(message, ok) {
  const existing = document.getElementById('contentpulse-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'contentpulse-toast';
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: '2147483647',
    maxWidth: '320px',
    padding: '12px 16px',
    borderRadius: '8px',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    fontSize: '14px',
    color: '#ffffff',
    boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
    background: ok ? '#0077B5' : '#c0392b',
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function inExtension() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
}

function requestPageFill(title, bodyHtml, bodyText) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'pageFill', title, bodyHtml, bodyText }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { ok: false });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

async function fillArticle(article) {
  console.log('[ContentPulse][cs] fillArticle', article?.title);
  const title = article?.title || '';
  const bodyHtml = article?.body || '';
  const bodyText = stripHtml(bodyHtml);

  if (inExtension() && typeof chrome.runtime.sendMessage === 'function') {
    const res = await requestPageFill(title, bodyHtml, bodyText);
    if (res && res.ok) {
      console.log('[ContentPulse][cs] background fill complete', res);
      return true;
    }
    console.warn('[ContentPulse][cs] background fill unavailable/failed, trying DOM fallback', res);
  }

  const { titleEl, bodyEl } = await waitForEditor();

  if (!titleEl || !bodyEl) {
    console.error('[ContentPulse][cs] editor fields not found');
    showToast('ContentPulse: Could not detect LinkedIn editor, please try again', false);
    return false;
  }

  try {
    insertText(titleEl, title);
    insertText(bodyEl, bodyText);
    console.log('[ContentPulse][cs] fill complete');
    showToast('ContentPulse: Article filled successfully', true);
    return true;
  } catch (err) {
    console.error('[ContentPulse][cs] fill failed', err);
    showToast('ContentPulse: Could not detect LinkedIn editor, please try again', false);
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'fill') {
    fillArticle(message.article).then((ok) => sendResponse({ ok }));
    return true;
  }
  return false;
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source === window && data && data.source === 'contentpulse-test' && data.action === 'fill') {
    console.log('[ContentPulse][cs] test bridge fill received');
    fillArticle(data.article);
  }
});
