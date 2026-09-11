const CP_DEBUG = false;
const log = (...args) => {
  if (CP_DEBUG) console.log('[ContentPulse][substack]', ...args);
};

const MAX_ATTEMPTS = 20;
const ATTEMPT_INTERVAL_MS = 500;

// Substack's editor is TipTap/ProseMirror. Title and subtitle are native
// <textarea> elements; the body is a contenteditable div.tiptap.ProseMirror.
const TITLE_SELECTOR = 'textarea[data-testid="post-title"], textarea.page-title';
const SUBTITLE_SELECTOR = 'textarea.subtitle, textarea[placeholder="Add a subtitle"]';
const BODY_SELECTORS = [
  'div.tiptap.ProseMirror[data-testid="editor"]',
  'div.tiptap.ProseMirror.mousetrap[contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
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
      const editorEl = findFirst(BODY_SELECTORS);
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

// Set a native textarea's value using the native setter so React/TipTap picks
// up the change (direct .value= doesn't fire internal state updates).
function setTextareaValue(textarea, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, value);
  } else {
    textarea.value = value;
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

async function fillArticle(article) {
  log('fillArticle', article?.title);
  const title = article?.title || '';
  const subtitle = article?.subtitle || '';
  const bodyHtml = article?.body || '';

  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html');
  doc.body.querySelectorAll('p, br, div, h1, h2, h3, h4, li').forEach((el) => {
    el.append('\n');
  });
  const bodyText = (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();

  // Fill title
  const titleEl = document.querySelector(TITLE_SELECTOR);
  if (titleEl && title) {
    setTextareaValue(titleEl, title);
    log('title filled');
  }

  // Fill subtitle
  const subtitleEl = document.querySelector(SUBTITLE_SELECTOR);
  if (subtitleEl && subtitle) {
    setTextareaValue(subtitleEl, subtitle);
    log('subtitle filled');
  }

  // Fill body via clipboard paste (ProseMirror-safe)
  const editorEl = await waitForEditor();
  if (!editorEl) {
    showToast('ContentPulse: Could not detect Substack editor, please try again', false);
    return false;
  }

  try {
    editorEl.focus();

    // Select all existing content and replace via clipboard paste.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editorEl);
    sel.removeAllRanges();
    sel.addRange(range);

    const dt = new DataTransfer();
    dt.setData('text/html', bodyHtml);
    dt.setData('text/plain', bodyText);

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
  if (message?.action === 'substackFill') {
    fillArticle(message.article).then((ok) => sendResponse({ ok }));
    return true;
  }
  return false;
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source === window && data && data.source === 'contentpulse-test' && data.action === 'substackFill') {
    log('test bridge fill received');
    fillArticle(data.article);
  }
});

// Opening Substack with ?cp=<ULID> is an explicit fill request. Use the same
// article lookup and full fill pipeline as the publisher popup.
(async () => {
  const contentId = contentIdFromUrl();
  if (!contentId || window.__cpDirectAutoFillStarted) return;
  window.__cpDirectAutoFillStarted = true;
  const result = await requestRuntime({ action: 'autoFillFromContentId', contentId, platform: 'substack' });
  if (!result?.ok) {
    window.__cpDirectAutoFillStarted = false;
    showToast(`ContentPulse: Could not load article ${contentId}`, false);
    return;
  }
  showToast('ContentPulse: Article loaded from the cp link and filling now', true);
})();
