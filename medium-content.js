const CP_DEBUG = false;
const log = (...args) => {
  if (CP_DEBUG) console.log('[ContentPulse][medium]', ...args);
};

const MAX_ATTEMPTS = 20;
const ATTEMPT_INTERVAL_MS = 500;

// Medium's editor: the entire editor is a single contenteditable div with
// id like "editor_N" and class "postArticle-content js-postField editable".
// The title is typed into the first paragraph (data-default-value="Title"),
// and the body follows. There is no separate title input — it is all one
// contenteditable with graf elements inside.
const EDITOR_SELECTORS = [
  '.postArticle-content.editable[contenteditable="true"]',
  'div.js-postField[contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"][g_editable="true"]',
  'div.editable[role="textbox"][contenteditable="true"]',
];

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
      const editorEl = findFirst(EDITOR_SELECTORS);
      log(`editor probe ${attempts}/${MAX_ATTEMPTS}`, { found: !!editorEl });
      if (editorEl) {
        resolve(editorEl);
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        resolve(null);
        return;
      }
      setTimeout(tick, ATTEMPT_INTERVAL_MS);
    };
    tick();
  });
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
    background: ok ? '#52227a' : '#c0392b',
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function requestRuntime(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { ok: false });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function contentIdFromUrl() {
  try {
    const id = new URL(location.href).searchParams.get('cp')?.trim() || '';
    return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id) ? id.toUpperCase() : '';
  } catch (e) {
    return '';
  }
}

// Medium's editor uses its own internal model on top of contenteditable.
// Direct DOM manipulation desync the model and break save. The safe approach
// is to paste via the clipboard so Medium's own paste handler processes it.
async function fillArticle(article) {
  log('fillArticle', article?.title);
  const title = article?.title || '';
  const bodyHtml = article?.body || '';

  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html');
  doc.body.querySelectorAll('p, br, div, h1, h2, h3, h4, li').forEach((el) => {
    el.append('\n');
  });
  const bodyText = (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();

  const editorEl = await waitForEditor();

  if (!editorEl) {
    showToast('ContentPulse: Could not detect Medium editor, please try again', false);
    return false;
  }

  try {
    // Build full HTML with title as H3 followed by the body.
    // Medium treats the first line/block as the title automatically.
    const fullHtml = title ? `<h3>${title}</h3>${bodyHtml}` : bodyHtml;
    const fullText = title ? `${title}\n\n${bodyText}` : bodyText;

    editorEl.focus();

    // Select all existing content and replace via clipboard paste.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editorEl);
    sel.removeAllRanges();
    sel.addRange(range);

    const dt = new DataTransfer();
    dt.setData('text/html', fullHtml);
    dt.setData('text/plain', fullText);

    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    editorEl.dispatchEvent(pasteEvent);

    log('clipboard paste dispatched');
    showToast('ContentPulse: Article filled successfully', true);
    return true;
  } catch (e) {
    log('fill failed', e);
    showToast('ContentPulse: Could not fill the editor, please try again', false);
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'mediumFill') {
    fillArticle(message.article).then((ok) => sendResponse({ ok }));
    return true;
  }
  return false;
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source === window && data && data.source === 'contentpulse-test' && data.action === 'mediumFill') {
    log('test bridge fill received');
    fillArticle(data.article);
  }
});

// Opening Medium with ?cp=<ULID> is an explicit fill request. Route it
// through the same background pipeline as the popup so the hero, table/chart
// images, captions, tags and SEO metadata are handled consistently.
(async () => {
  const contentId = contentIdFromUrl();
  if (!contentId || window.__cpDirectAutoFillStarted) return;
  window.__cpDirectAutoFillStarted = true;
  const result = await requestRuntime({ action: 'autoFillFromContentId', contentId, platform: 'medium' });
  if (!result?.ok) {
    window.__cpDirectAutoFillStarted = false;
    showToast(`ContentPulse: Could not load article ${contentId}`, false);
    return;
  }
  showToast('ContentPulse: Article loaded from the cp link and filling now', true);
})();
