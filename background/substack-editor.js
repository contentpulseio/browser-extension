// ContentPulse background: substack editor.
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
        'input[role="combobox"][aria-autocomplete="list"], input[role="combobox"][placeholder="Select or create tags"], input[placeholder="Select or create tags"]',
      );

      const setNativeInput = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const normalizeTagText = (value) => String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase();

      const findTagChoice = (tag) => {
        const normalizedTag = normalizeTagText(tag);
        const createLabel = `create "${normalizedTag}"`;
        const candidates = Array.from(document.querySelectorAll(
          '[role="option"], [role="listbox"] button, [role="listbox"] [role="button"], button',
        ));
        return candidates.find((candidate) => {
          const text = normalizeTagText(candidate.textContent);
          return text === normalizedTag || text === createLabel;
        }) || null;
      };

      const tagIsSelected = (tag) => {
        const normalizedTag = normalizeTagText(tag);
        return Array.from(document.querySelectorAll(
          '[data-selected-tag], button[class*="chip"], [role="option"][aria-selected="true"]',
        )).some((candidate) => normalizeTagText(candidate.textContent) === normalizedTag);
      };

      const activateTagChoice = (choice) => {
        if (!choice) return;
        choice.focus?.();
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
          choice.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        choice.click?.();
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
            if (tagIsSelected(tag)) {
              filled += 1;
              continue;
            }
            input.focus();
            setNativeInput(input, tag);

            const option = await waitFor(
              () => findTagChoice(tag),
              2500,
              150,
            );
            if (option) {
              activateTagChoice(option);
            } else {
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            }
            const selected = await waitFor(() => tagIsSelected(tag), 2000, 150);
            if (!selected) {
              input.focus();
              input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
              }));
              input.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
              }));
            }
            if (await waitFor(() => tagIsSelected(tag), 1500, 150)) filled += 1;
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

    const scrollToTop = () => {
      const run = () => {
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
        } catch (e) {}
      };
      run();
      setTimeout(run, 400);
      setTimeout(run, 1200);
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
          scrollToTop();
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
      // Substack's file-settings component listens to `onInput` (not
      // `onChange`). Keep this identical to its native file-selection path;
      // dispatching both events can start two overlapping image uploads and
      // leave the thumbnail component stuck on Loading… .
      const inputEvent = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromDrop' })
        : new Event('input', { bubbles: true, composed: true });
      input.dispatchEvent(inputEvent);

      // These are Substack's current file-sidebar fields. They provide useful
      // title/description metadata for the thumbnail and improve its SEO and
      // accessibility even though the thumbnail has no visible caption field.
      const preview = await waitFor(() => {
        const scope = document.querySelector('.post-editor-file-edit-sidebar') || document;
        return Array.from(scope.querySelectorAll('img')).find((img) => (img.currentSrc || img.src || '').length > 0) || null;
      }, 20000, 250);
      const titleOk = setNative(
        document.querySelector('input[placeholder="Add a title..."]'),
        String(seoTitle || '').slice(0, 500),
      );
      const descriptionOk = setNative(
        document.querySelector('textarea[placeholder="Add a description..."]'),
        String(seoDescription || '').slice(0, 500),
      );
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
