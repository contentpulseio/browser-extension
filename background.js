const API_BASE = 'https://contentpulse.io/api/v1';

const PENDING_STATUSES = ['draft', 'review', 'scheduled'];

console.log('[ContentPulse][bg] service worker booted');

function getStored(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, (items) => resolve(items)));
}

async function validateKey(apiKey) {
  console.log('[ContentPulse][bg] validating API key via /auth/me');
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });

    if (res.status === 200) {
      const body = await res.json();
      console.log('[ContentPulse][bg] key valid, user:', body?.user?.email);
      return { ok: true, status: 200, user: body.user ?? null, tenant: body.tenant ?? null };
    }

    console.warn('[ContentPulse][bg] key validation failed, status', res.status);
    return { ok: false, status: res.status, error: 'Invalid API key, please check your ContentPulse settings' };
  } catch (err) {
    console.error('[ContentPulse][bg] key validation network error', err);
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
    console.log('[ContentPulse][bg] GET', url);
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
    const websites = list.map((w) => ({ id: w.id, name: w.name || 'Untitled site' }));
    console.log('[ContentPulse][bg] fetched', websites.length, 'websites');
    return { ok: true, status: 200, websites };
  } catch (err) {
    console.error('[ContentPulse][bg] getWebsites error', err);
    return { ok: false, status: 0, error: err.message };
  }
}

async function fetchByStatus(apiKey, status, websiteId) {
  let url = `${API_BASE}/content?status=${encodeURIComponent(status)}&per_page=100&sort=scheduled_at&direction=asc`;
  if (websiteId) {
    url += `&website_id=${encodeURIComponent(websiteId)}`;
  }
  console.log('[ContentPulse][bg] GET', url);
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

    console.log('[ContentPulse][bg] fetched', merged.length, 'pending/scheduled articles');
    return { ok: true, status: 200, articles: merged };
  } catch (err) {
    console.error('[ContentPulse][bg] getArticles error', err);
    return { ok: false, status: 0, error: err.message };
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

  return {
    id: item.id,
    title,
    status: item.status || 'draft',
    scheduled_date: scheduledDate,
    excerpt: typeof version.excerpt === 'string' ? version.excerpt : '',
    body_html: bodyHtml,
    image_url: imageUrl,
    seo,
  };
}

function cpPageFill(titleText, bodyHtml, bodyText) {
  return new Promise((resolve) => {
    const MAX_ATTEMPTS = 30;
    const INTERVAL_MS = 500;
    let attempts = 0;

    let toastEl = null;
    const setToast = (msg, state) => {
      try {
        if (!toastEl || !document.body.contains(toastEl)) {
          toastEl = document.createElement('div');
          toastEl.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px;transition:background .2s;display:flex;align-items:center;gap:9px';
          document.body.appendChild(toastEl);
        }
        const bg = state === 'ok' ? '#0a7d33' : state === 'error' ? '#b3261e' : '#1f2937';
        toastEl.style.background = bg;
        const spinner = state === 'progress' ? '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:cp-spin .7s linear infinite"></span>' : '';
        toastEl.innerHTML = spinner + '<span></span>';
        toastEl.lastChild.textContent = msg;
        if (!document.getElementById('cp-spin-style')) {
          const s = document.createElement('style');
          s.id = 'cp-spin-style';
          s.textContent = '@keyframes cp-spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(s);
        }
        if (state !== 'progress') {
          const ref = toastEl;
          setTimeout(() => {
            if (ref) ref.remove();
            if (toastEl === ref) toastEl = null;
          }, 3000);
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
        console.warn('[ContentPulse][page] htmlToDoc parse error', err);
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
        console.warn('[ContentPulse][page] quill.setText failed', err);
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
        console.warn('[ContentPulse][page] native set failed', err);
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
        console.warn('[ContentPulse][page] paste failed', err);
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
        if (typeof tiptap.commands.focus === 'function') tiptap.commands.focus('end');
        return true;
      } catch (err) {
        console.warn('[ContentPulse][page] tiptap setContent failed', err);
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
        console.warn('[ContentPulse][page] paste simulation failed', err);
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

    const expectedLen = (bodyText || '').trim().length;
    const wipedThreshold = Math.min(20, Math.max(5, Math.floor(expectedLen * 0.2)));

    let lastBodyEl = null;

    const bodyFilled = (el) => {
      if (expectedLen === 0) return true;
      return getEditorText(el && el.editor, el).length >= wipedThreshold;
    };

    const finish = (bodyOk, titleOk, method, attempts) => {
      setToast(
        bodyOk ? 'ContentPulse: Article filled successfully' : 'ContentPulse: Could not fill the editor, please try again',
        bodyOk ? 'ok' : 'error',
      );
      resolve({ ok: bodyOk, titleOk, bodyOk, method, attempts });
    };

    setToast('ContentPulse: Filling content, please wait...', 'progress');

    // Timing tuned to LinkedIn's real behaviour the user observed: the FIRST
    // formatted paste never sticks — LinkedIn mounts/re-renders the editor right
    // after it and discards the content — while a SECOND formatted paste ~1s
    // later holds. So we wait longer before the first paste, and after EACH paste
    // we judge PERSISTENCE only after a settle delay (not the instant it lands),
    // re-asserting the SAME formatted paste until it survives the re-render.
    const GRACE_MS = 2200; // let the editor fully mount before the first paste
    const SETTLE_MS = 1200; // wait after each paste for the re-render, THEN judge
    const MAX_PASTE_ATTEMPTS = 3; // re-assert the formatted paste until it holds

    // Fill the body with the FORMATTED paste (the exact path the working "Copy
    // formatted" button relies on, so LinkedIn converts the rich HTML natively
    // and formatting is preserved), then VERIFY it PERSISTED after SETTLE_MS. If
    // the re-render wiped it, re-assert the same formatted paste. We only ever
    // downgrade to tiptap/plain-text if the paste path is structurally
    // unavailable — never as a "second fill" that clobbers formatting.
    const fillBodyVerified = (titleOk, attempts) => {
      let settled = false;
      let pasteTries = 0;

      const settle = (ok, method) => {
        if (settled) return;
        settled = true;
        finish(ok, titleOk, method, attempts);
      };

      const verifyAfterSettle = (method, onFail) => {
        setTimeout(() => {
          if (settled) return;
          const el = findBodyEditor() || lastBodyEl;
          if (bodyFilled(el)) {
            console.log('[ContentPulse][page] body persisted via', method);
            settle(true, method);
            return;
          }
          onFail();
        }, SETTLE_MS);
      };

      const tryPaste = () => {
        if (settled) return;
        pasteTries += 1;
        const el = findBodyEditor() || lastBodyEl;
        try {
          pasteHtml(el);
        } catch (err) {
          console.warn('[ContentPulse][page] formatted paste threw', err);
        }
        console.log('[ContentPulse][page] formatted paste attempt', pasteTries);
        verifyAfterSettle('paste', () => {
          if (pasteTries < MAX_PASTE_ATTEMPTS) {
            console.log('[ContentPulse][page] paste did not persist — re-asserting formatted paste');
            tryPaste();
          } else {
            tryTiptap();
          }
        });
      };

      const tryTiptap = () => {
        if (settled) return;
        const el = findBodyEditor() || lastBodyEl;
        const t = el && el.editor;
        if (t && t.commands && typeof t.commands.setContent === 'function') {
          try {
            applyTiptap(t);
          } catch (err) {
            console.warn('[ContentPulse][page] tiptap setContent threw', err);
          }
          verifyAfterSettle('tiptap', tryFallback);
        } else {
          tryFallback();
        }
      };

      const tryFallback = () => {
        if (settled) return;
        const el = findBodyEditor() || lastBodyEl;
        try {
          fillBodyNonTiptap(el);
        } catch (err) {
          console.warn('[ContentPulse][page] fallback fill threw', err);
        }
        verifyAfterSettle('fallback', () => settle(bodyFilled(findBodyEditor() || el), 'exhausted'));
      };

      tryPaste();
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

      setTimeout(() => {
        const titleOk = fillTitle();
        fillBodyVerified(titleOk, attempts);
      }, GRACE_MS);
    };

    tick();
  });
}

// Injected into the LinkedIn editor page (MAIN world) to fill the Article
// settings SEO fields. The SEO title/description live in LinkedIn's "Article
// settings" modal (input[name="seoTitle"] max 60, textarea[name="seoDescription"]
// max 160), so the modal must already be open. Values are set via the native
// setter + input/change events so LinkedIn's Ember-bound inputs register the
// change, and are sliced to the field limits (programmatic value assignment does
// not honour maxlength).
function cpPageFillSeo(seoTitle, seoDescription) {
  return new Promise((resolve) => {
    const toast = (msg, state) => {
      try {
        const el = document.createElement('div');
        el.style.cssText =
          'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px';
        el.style.background = state === 'ok' ? '#0a7d33' : '#b3261e';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3000);
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
        console.warn('[ContentPulse][page] SEO native set failed', err);
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

    const titleEl = findSeoTitle();
    const descEl = findSeoDescription();

    if (!titleEl && !descEl) {
      toast('ContentPulse: Open the Settings (SEO) panel, then try again', 'error');
      resolve({ ok: false, reason: 'no-seo-fields' });
      return;
    }

    let titleOk = false;
    let descOk = false;
    if (titleEl && (seoTitle || '').trim() !== '') {
      titleOk = setNative(titleEl, (seoTitle || '').slice(0, 60));
    }
    if (descEl && (seoDescription || '').trim() !== '') {
      descOk = setNative(descEl, (seoDescription || '').slice(0, 160));
    }

    const ok = titleOk || descOk;
    toast(ok ? 'ContentPulse: SEO fields filled' : 'ContentPulse: Could not fill the SEO fields', ok ? 'ok' : 'error');
    resolve({ ok, titleOk, descOk });
  });
}

async function pageFill(tabId, title, bodyHtml, bodyText) {
  if (!tabId) {
    return { ok: false, error: 'No tab id for page fill' };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpPageFill,
      args: [title || '', bodyHtml || '', bodyText || ''],
    });
    const result = results && results[0] ? results[0].result : null;
    console.log('[ContentPulse][bg] pageFill result', result);
    return result || { ok: false, error: 'No result from page fill' };
  } catch (err) {
    console.error('[ContentPulse][bg] pageFill executeScript error', err);
    return { ok: false, error: err.message };
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
    console.log('[ContentPulse][bg] pageFillSeo result', result);
    return result || { ok: false, error: 'No result from SEO fill' };
  } catch (err) {
    console.error('[ContentPulse][bg] pageFillSeo executeScript error', err);
    return { ok: false, error: err.message };
  }
}

const LINKEDIN_EDITOR_URL = 'https://www.linkedin.com/article/new/';

function isEditorUrl(url) {
  if (!url) return false;
  return url.startsWith('https://www.linkedin.com/article/') || url.startsWith('https://www.linkedin.com/pulse/');
}

function stripHtmlSW(html) {
  return (html || '')
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function openAndFill(article) {
  const title = article?.title || '';
  const bodyHtml = article?.body_html || article?.body || '';
  const bodyText = stripHtmlSW(bodyHtml);
  console.log('[ContentPulse][bg] openAndFill ->', title);

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs[0];

    if (activeTab && isEditorUrl(activeTab.url)) {
      console.log('[ContentPulse][bg] active tab is already the editor, filling in place');
      pageFill(activeTab.id, title, bodyHtml, bodyText);
      return;
    }

    console.log('[ContentPulse][bg] no editor in the active tab, opening a new one');
    chrome.tabs.create({ url: LINKEDIN_EDITOR_URL }, (tab) => {
      const targetTabId = tab.id;

      const listener = (tabId, changeInfo) => {
        if (tabId !== targetTabId || changeInfo.status !== 'complete') {
          return;
        }
        console.log('[ContentPulse][bg] editor tab ready, filling via executeScript');
        chrome.tabs.onUpdated.removeListener(listener);
        pageFill(targetTabId, title, bodyHtml, bodyText);
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// Fill the SEO title/description in the currently open LinkedIn editor. Unlike
// body fill we never open a new tab: the SEO fields live in the editor's Article
// settings modal, which the user must open first, so we only act on an active
// editor tab and otherwise return a helpful hint.
function fillSeoActive(seo) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const activeTab = tabs && tabs[0];

      if (!activeTab || !isEditorUrl(activeTab.url)) {
        resolve({
          ok: false,
          error: 'Open the LinkedIn article editor and its Settings (SEO) panel first, then click Fill SEO.',
        });
        return;
      }

      const res = await pageFillSeo(activeTab.id, seo?.meta_title || '', seo?.meta_description || '');
      resolve(res);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[ContentPulse][bg] message:', message?.action);

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

    default:
      sendResponse({ ok: false, error: `Unknown action: ${message?.action}` });
      return false;
  }
});
