// ContentPulse background: linkedin editor.
function cpPageFill(titleText, bodyHtml, bodyText, isFreshTab, useSystemClipboard, debugEnabled, structuredBodyDoc) {
  return new Promise((resolve) => {
    const CP_DEBUG = (() => {
      try {
        return debugEnabled === true || new URL(location.href).searchParams.get('cp_debug') === '1';
      } catch (e) {
        return debugEnabled === true;
      }
    })();
    const log = (...args) => {
      if (!CP_DEBUG) return;
      console.log(...args.map((value) => {
        if (!value || typeof value !== 'object') return value;
        try { return JSON.stringify(value); } catch (e) { return String(value); }
      }));
    };
    const warn = (...args) => {
      if (CP_DEBUG) console.warn(...args);
    };
    const MAX_ATTEMPTS = 30;
    const INTERVAL_MS = 500;
    let attempts = 0;

    log('[ContentPulse][page] fill started', {
      url: location.href,
      titleLength: titleText?.length || 0,
      bodyHtmlLength: bodyHtml?.length || 0,
      bodyTextLength: bodyText?.length || 0,
      isFreshTab: !!isFreshTab,
      useSystemClipboard: !!useSystemClipboard,
    });

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
      if (structuredBodyDoc?.type === 'doc' && Array.isArray(structuredBodyDoc.content)) {
        log('[ContentPulse][page] using isolated-world HTML parse', {
          blockCount: structuredBodyDoc.content.length,
          blockTypes: structuredBodyDoc.content.map((block) => block.type),
        });
        return structuredBodyDoc;
      }
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
          el.querySelectorAll(':scope > li').forEach((li) => {
            const item = para(li);
            if (item.content?.length) items.push({ type: 'listItem', content: [item] });
          });
          if (items.length) out.push({ type: tag === 'ul' ? 'bulletList' : 'orderedList', content: items });
        } else if (tag === 'blockquote') {
          const quoted = para(el);
          if (quoted.content?.length) out.push({ type: 'blockquote', content: [quoted] });
        } else if (tag === 'pre') {
          out.push({ type: 'codeBlock', content: [{ type: 'text', text: el.textContent || '' }] });
        } else if (tag === 'hr') {
          out.push({ type: 'horizontalRule' });
        } else if (tag === 'figure' || tag === 'img') {
          // LinkedIn's uploader owns image insertion and its temporary caret
          // paragraph; a placeholder here leaves a permanent blank line.

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
        log('[ContentPulse][page] htmlToDoc input', {
          length: typeof html === 'string' ? html.length : 0,
          topLevelTags: Array.from(new DOMParser().parseFromString(html || '', 'text/html').body.children)
            .map((node) => node.tagName.toLowerCase())
            .slice(0, 30),
          prefix: String(html || '').slice(0, 900),
        });
        Array.from(dp.body.children).forEach(pushBlock);
      } catch (err) {
        warn('[ContentPulse][page] htmlToDoc parse error', err);
      }
      if (!out.length) {
        const t = (dp.body.textContent || '').trim();
        if (t) out.push({ type: 'paragraph', content: [{ type: 'text', text: t }] });
      }
      const doc = { type: 'doc', content: out.length ? out : [{ type: 'paragraph' }] };
      log('[ContentPulse][page] htmlToDoc complete', {
        blockCount: doc.content.length,
        blockTypes: doc.content.map((block) => block.type),
      });
      return doc;
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
      if (!titleEl) {
        warn('[ContentPulse][page] title editor not found');
        return false;
      }
      if (titleEl.tagName === 'TEXTAREA' || titleEl.tagName === 'INPUT') {
        const ok = setNative(titleEl, titleText || '');
        log('[ContentPulse][page] title filled', { ok, selector: titleEl.id || titleEl.className || titleEl.tagName });
        return ok;
      }
      const tq = findQuill(titleEl.closest('.ql-container'));
      const ok = tq ? setViaQuill(tq, titleText || '') : setRichText(titleEl, titleText || '');
      log('[ContentPulse][page] title filled', { ok, via: tq ? 'quill' : 'rich-text' });
      return ok;
    };

    const applyTiptap = (tiptap) => {
      // JSON first: our htmlToDoc conversion matches LinkedIn's TipTap schema
      // (headings, paragraphs, lists, inline marks). Raw HTML is not parsed
      // correctly by LinkedIn's editor (it strips formatting).
      try {
        const doc = htmlToDoc(bodyHtml || '');
        log('[ContentPulse][page] applying TipTap JSON', { blocks: doc.content.length });
        tiptap.commands.setContent(doc, true);
        if (typeof tiptap.commands.focus === 'function') tiptap.commands.focus('start');
        const liveEditor = document.querySelector('.ProseMirror');
        log('[ContentPulse][page] TipTap JSON applied', {
          htmlLength: liveEditor?.innerHTML?.length || 0,
          html: liveEditor?.innerHTML?.slice(0, 1200) || '',
          textLength: liveEditor?.textContent?.length || 0,
          editorTextLength: tiptap.getText?.().length || 0,
          editorHtmlLength: tiptap.getHTML?.().length || 0,
          editorBlockTypes: tiptap.getJSON?.().content?.map((node) => node.type) || [],
          editorStructure: tiptap.getJSON?.().content?.slice(0, 20).map((node) => ({
            type: node.type,
            text: (node.textContent || '').slice(0, 120),
            marks: node.content?.flatMap((child) => child.marks?.map((mark) => mark.type) || []) || [],
          })) || [],
        });
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
          const editors = document.querySelectorAll('[contenteditable="true"], textarea, input');
          editors.forEach((editor) => {
            let parent = editor.parentElement;
            for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) {
              if (parent.scrollHeight > parent.clientHeight + 4) parent.scrollTop = 0;
            }
          });
          const title = findTitle();
          if (title) title.scrollIntoView({ block: 'start' });
        } catch (e) {}
      };
      doScroll();
      setTimeout(doScroll, 400);
      setTimeout(doScroll, 1200);
    };

    const finish = (bodyOk, titleOk, method, attempts) => {
      log('[ContentPulse][page] fill finished', {
        ok: bodyOk,
        titleOk,
        bodyOk,
        method,
        attempts,
        bodyLength: findBodyEditor()?.textContent?.length || 0,
        bodyHtmlLength: findBodyEditor()?.innerHTML?.length || 0,
      });
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

    // Empty the editor before any insert so a re-fill REPLACES the existing
    // body instead of appending below it.
    const clearBody = (el) => {
      log('[ContentPulse][page] clearing body', {
        hasEditor: !!findTiptapEditor(el),
        previousLength: el?.textContent?.length || 0,
      });
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
      const el = findBodyEditor() || lastBodyEl;
      log('[ContentPulse][page] fill body attempt', {
        titleOk,
        attempts,
        foundBody: !!el,
        hasTiptap: !!findTiptapEditor(el),
      });

      // One deterministic write only. Chaining TipTap, synthetic paste,
      // insertHTML and plain-text fallbacks made LinkedIn visibly replace the
      // article several times and could leave the lowest-fidelity result last.
      clearBody(el);
      const tiptap = findTiptapEditor(el);
      let method = 'native-html';
      let inserted = false;

      // Direct cp-link fills do not have a popup clipboard token. Prefer
      // LinkedIn's own TipTap document API whenever it is available so those
      // fills preserve headings, lists, links, and inline marks as well.
      if (tiptap) {
        inserted = applyTiptap(tiptap);
        method = 'tiptap-json';
      }
      if (!inserted) {
        method = useSystemClipboard ? 'clipboard-paste' : 'native-html';
        inserted = useSystemClipboard ? pasteFromSystemClipboard(el) : insertFormattedHtml(el);
      }

      log('[ContentPulse][page] body insertion selected', { inserted, method });

      setTimeout(() => {
        const current = findBodyEditor() || el;
        log('[ContentPulse][page] body after settle', {
          htmlLength: current?.innerHTML?.length || 0,
          html: current?.innerHTML?.slice(0, 1200) || '',
          textLength: current?.textContent?.length || 0,
          editorTextLength: findTiptapEditor(current)?.getText?.().length || 0,
          editorHtmlLength: findTiptapEditor(current)?.getHTML?.().length || 0,
        });
        finish(bodyFilled(current), titleOk, method, attempts);
      }, SETTLE_MS);
    };

    const tick = () => {
      attempts += 1;
      const bodyEl = findBodyEditor();
      log('[ContentPulse][page] editor probe', {
        attempts,
        maxAttempts: MAX_ATTEMPTS,
        foundBody: !!bodyEl,
        hasTiptap: !!findTiptapEditor(bodyEl),
      });

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
            log('[ContentPulse][page] editor changed while stabilizing', { previousLength: len, nextLength: curLen });
            el = cur;
            len = curLen;
            stableSince = Date.now();
          }
          if (el && Date.now() - stableSince >= STABLE_MS) {
            // Give tiptap up to 8s to attach so the fill can go through the
            // editor's own API (immune to the bootstrap re-sync wipe).
            if (findTiptapEditor(el) || Date.now() - start >= 8000) {
              log('[ContentPulse][page] editor stable', {
                elapsedMs: Date.now() - start,
                hasTiptap: !!findTiptapEditor(el),
                length: len,
              });
              return el;
            }
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
        log('[ContentPulse][page] fill delay elapsed', { graceMs: GRACE_MS });
        const stableEl = await waitForStableEditor();
        if (stableEl) lastBodyEl = stableEl;
        if (isFreshTab) await primeEditor();
        const titleOk = fillTitle();
        // Updating LinkedIn's title can rehydrate its article component and
        // replace/reset the ProseMirror instance. Wait for that save/render
        // cycle before performing the one body write, including cp deep links
        // opened in an already-existing tab.
        const postTitleEditor = await waitForStableEditor();
        if (postTitleEditor) lastBodyEl = postTitleEditor;
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

async function pageFill(tabId, title, bodyHtml, bodyText, isFreshTab, useSystemClipboard, debugEnabled = false) {
  if (!tabId) {
    return { ok: false, error: 'No tab id for page fill' };
  }
  try {
    const parsed = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: parseLinkedInHtmlToDoc,
      args: [bodyHtml || ''],
    });
    const structuredBodyDoc = parsed && parsed[0] ? parsed[0].result : null;
    const run = async (world, clipboard) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        // LinkedIn's TipTap instance is attached to page-world DOM nodes. The
        // primary fill must therefore always run in MAIN. An isolated-world
        // clipboard paste is retained only as a fallback for editors that do
        // not expose a structured editor API.
        world,
        func: cpPageFill,
        args: [title || '', bodyHtml || '', bodyText || '', !!isFreshTab, !!clipboard, !!debugEnabled, structuredBodyDoc],
      });
      return results && results[0] ? results[0].result : null;
    };

    const primary = await run('MAIN', false);
    log('[ContentPulse][bg] pageFill MAIN result', primary);
    if (primary?.ok || !useSystemClipboard) return primary || { ok: false, error: 'No result from page fill' };

    const fallback = await run('ISOLATED', true);
    log('[ContentPulse][bg] pageFill isolated clipboard fallback result', fallback);
    return fallback || primary || { ok: false, error: 'No result from page fill' };
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
