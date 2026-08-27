const API_BASE = 'https://contentpulse.io/api/v1';

const PENDING_STATUSES = ['draft', 'review', 'scheduled'];

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
  } catch (err) {
    err('[ContentPulse][bg] key validation network error', err);
    return { ok: false, status: 0, error: `Network error: ${err.message}` };
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
  } catch (err) {
    err('[ContentPulse][bg] getWebsites error', err);
    return { ok: false, status: 0, error: err.message };
  }
}

async function fetchByStatus(apiKey, status, websiteId) {
  let url = `${API_BASE}/content?status=${encodeURIComponent(status)}&per_page=100&sort=scheduled_at&direction=asc`;
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
  } catch (err) {
    err('[ContentPulse][bg] getArticles error', err);
    return { ok: false, status: 0, error: err.message };
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

function normalizeArticle(item) {
  const version = item.current_version || {};
  const title = item.title || version.title || 'Untitled';
  const bodyHtml = version.rendered_html || '';

  const scheduledDate = item.linkedin_scheduled_at || item.scheduled_at || null;

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

  return {
    id: item.id,
    title,
    status: item.status || 'draft',
    scheduled_date: scheduledDate,
    excerpt: typeof version.excerpt === 'string' ? version.excerpt : '',
    body_html: bodyHtml,
    image_url: imageUrl,
    external_url: typeof item.external_url === 'string' ? item.external_url : null,
    share_post: sharePost,
    seo,
  };
}

function cpPageFill(titleText, bodyHtml, bodyText, isFreshTab) {
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
          if (c.length) out.push({ type: 'paragraph', content: c });
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
      try {
        tiptap.commands.setContent(htmlToDoc(bodyHtml || ''), true);
        if (typeof tiptap.commands.focus === 'function') tiptap.commands.focus('start');
        return true;
      } catch (err) {
        warn('[ContentPulse][page] tiptap setContent failed', err);
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
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return true;
      } catch (err) {
        warn('[ContentPulse][page] paste simulation failed', err);
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

    const bodyFilled = (el) => {
      return getEditorText(el && el.editor, el).length >= wipedThreshold;
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
        const t = el && el.editor;
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

      // Tiptap setContent goes first: it replaces the whole document through
      // the editor's own state, so the editor never "re-syncs" our content
      // away (the fill-clear-refill flicker) and a second fill overwrites
      // instead of appending.
      const tryTiptap = () => {
        if (settled) return;
        const el = findBodyEditor() || lastBodyEl;
        const t = el && el.editor;
        if (t && t.commands && typeof t.commands.setContent === 'function') {
          try {
            applyTiptap(t);
          } catch (err) {
            warn('[ContentPulse][page] tiptap setContent threw', err);
          }
          verifyAfterSettle('tiptap', tryPaste);
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
            tryFallback();
          }
        });
      };

      const tryFallback = () => {
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
            if (el.editor || Date.now() - start >= 8000) return el;
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
          const t = el && el.editor;
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

async function pageFill(tabId, title, bodyHtml, bodyText, isFreshTab) {
  if (!tabId) {
    return { ok: false, error: 'No tab id for page fill' };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpPageFill,
      args: [title || '', bodyHtml || '', bodyText || '', !!isFreshTab],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] pageFill result', result);
    return result || { ok: false, error: 'No result from page fill' };
  } catch (err) {
    err('[ContentPulse][bg] pageFill executeScript error', err);
    return { ok: false, error: err.message };
  } 
}

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
async function fetchImageAsBase64(imageUrl) {
  const res = await fetch(imageUrl);
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
  } catch (err) {
    err('[ContentPulse][bg] pageFillSeo executeScript error', err);
    return { ok: false, error: err.message };
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

function isEditorUrl(url) {
  if (!url) return false;
  return url.startsWith('https://www.linkedin.com/article/') || url.startsWith('https://www.linkedin.com/pulse/');
}

// A LinkedIn article is live once its URL settles on the /pulse/<slug> permalink.
// The editor (/article/new/) and the in-progress draft never match this, so a
// later transition to a /pulse/ URL is a reliable "published" signal.
function publishedLinkedInUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^https:\/\/www\.linkedin\.com\/pulse\/[^/?#]+/);
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
  const liveUrl = publishedLinkedInUrl(currentUrl);
  // Ignore the editor and any URL identical to where we started filling; only a
  // transition to a real /pulse/ permalink counts as published.
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

function openAndFill(article) {
  const title = article?.title || '';
  const bodyHtml = article?.body_html || article?.body || '';
  const contentId = article?.id || null;
  const platform = article?.platform || 'linkedin_pulse';
  const shareText = composeShareText(article?.share_post);
  log('[ContentPulse][bg] openAndFill ->', title);

  // LinkedIn forces a share-post dialog when the Pulse article is published;
  // arm a watcher on the editor tab so the prepared copy is filled in the
  // moment that dialog opens.
  const armShareFill = (tabId) => {
    if (shareText) injectShareDialogFill(tabId, shareText, false);
  };

  // The article's website carries the connected LinkedIn profile/page name;
  // verify/switch the editor's "Publish as" entity to it after the fill.
  const publishAs = article?.publish_as || '';
  const imageUrl = article?.image_url || '';
  const credit = article?.credit || '';
  const seo = article?.seo || null;
  const hasSeo = !!(seo && ((seo.meta_title || '').trim() || (seo.meta_description || '').trim()));
  // Run sequentially - each step opens its own dialog on the page and they
  // would fight each other if fired at the same time. Order: publisher ->
  // cover image + credit -> SEO settings (filled and saved).
  const afterFill = async (tabId) => {
    if (publishAs) await pageEnsurePublisher(tabId, publishAs);
    if (imageUrl) await pageFillCoverImage(tabId, imageUrl, credit);
    if (hasSeo) await pageFillSeo(tabId, seo.meta_title || '', seo.meta_description || '');
  };

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs[0];

    if (activeTab && isEditorUrl(activeTab.url)) {
      log('[ContentPulse][bg] active tab is already the editor, filling in place');
      watchTabForPublish(activeTab.id, contentId, platform, activeTab.url, shareText);
      pageFill(activeTab.id, title, bodyHtml, '').then(() => afterFill(activeTab.id));
      armShareFill(activeTab.id);
      return;
    }

    log('[ContentPulse][bg] no editor in the active tab, opening a new one');
    // If we already learned this publisher's URN, open the editor publishing
    // as it right away (?author=<urn>) - no Publish-as clicking needed.
    const configuredUrn = typeof article?.publish_as_urn === 'string' ? article.publish_as_urn.trim() : '';
    getKnownPublisherUrn(publishAs).then((knownUrn) => {
      // Prefer the URN returned by the API. The local cache is only a fallback
      // for older sessions whose website list predates author_urn propagation.
      const urn = configuredUrn || knownUrn || '';
      const editorUrl = urn ? `${LINKEDIN_EDITOR_URL}?author=${encodeURIComponent(urn)}` : LINKEDIN_EDITOR_URL;
      if (urn) log('[ContentPulse][bg] opening editor with known author urn', urn);
      chrome.tabs.create({ url: editorUrl }, (tab) => {
        const targetTabId = tab.id;
        watchTabForPublish(targetTabId, contentId, platform, editorUrl, shareText);

        const listener = (tabId, changeInfo) => {
          if (tabId !== targetTabId || changeInfo.status !== 'complete') {
            return;
          }
          log('[ContentPulse][bg] editor tab ready, filling via executeScript');
          chrome.tabs.onUpdated.removeListener(listener);
          pageFill(targetTabId, title, bodyHtml, '', true).then(() => afterFill(targetTabId));
          armShareFill(targetTabId);
        };

        chrome.tabs.onUpdated.addListener(listener);
      });
    });
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

    case 'pageFill':

      pageFill(sender?.tab?.id, message.title, message.bodyHtml, message.bodyText).then(sendResponse);
      return true;

    case 'openAndFill':
      openAndFill(message.article);
      sendResponse({ ok: true });
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

    default:
      sendResponse({ ok: false, error: `Unknown action: ${message?.action}` });
      return false;
  }
});
