// ContentPulse background: medium editor.
function cpMediumPageFill(titleText, bodyHtml, bodyText, imageMeta) {
  return new Promise((resolve) => {
    const CP_DEBUG = false;
    const log = (...args) => { if (CP_DEBUG) console.log('[ContentPulse][medium-page]', ...args); };

    const EDITOR_SELECTORS = [
      '.postArticle-content.editable[contenteditable="true"]',
      'div.js-postField[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"][g_editable="true"]',
      'div.editable[role="textbox"][contenteditable="true"]',
    ];

    const findEditor = () => {
      for (const s of EDITOR_SELECTORS) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      return null;
    };

    const waitFor = async (condition, timeoutMs, stepMs = 200) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = condition();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, stepMs));
      }
    };

    const setEditableText = (el, value) => {
      const text = String(value || '').slice(0, 500);
      try {
        el.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, text);
        if ((el.textContent || '').trim() !== text.trim()) {
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, text);
        }
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text,
        }));
        return (el.textContent || '').replace(/\u00a0/g, ' ').trim() === text.trim();
      } catch (e) {
        log('editable text fill failed', e);
        return false;
      }
    };

    const getImageFigures = (editor) =>
      Array.from(editor.querySelectorAll('figure[data-testid="editorImageParagraph"], figure.graf--figure')).filter(
        (figure) => figure.querySelector('img.graf-image, img'),
      );

    const imageUploadedToMedium = (figure) => {
      const image = figure?.querySelector('img.graf-image, img');
      if (!image) return false;
      try {
        const host = new URL(image.currentSrc || image.src, location.href).hostname.toLowerCase();
        return host.endsWith('.medium.com') || host === 'medium.com' || host.endsWith('.mediumusercontent.com');
      } catch (e) {
        return false;
      }
    };

    const fillImageMetadata = async (editor) => {
      const meta = Array.isArray(imageMeta) ? imageMeta : [];
      if (!meta.length) return { imageCount: 0, captionsSet: 0, altTextSet: 0 };

      const figures = await waitFor(() => {
        const found = getImageFigures(editor);
        return found.length >= meta.length ? found.slice(0, meta.length) : null;
      }, 30000);
      if (!figures) {
        log('image metadata wait timed out', { expected: meta.length });
        return { imageCount: getImageFigures(editor).length, captionsSet: 0, altTextSet: 0, imagesUploaded: false };
      }

      const uploadedFigures = await waitFor(() => {
        const current = getImageFigures(editor).slice(0, meta.length);
        return current.length >= meta.length && current.every(imageUploadedToMedium) ? current : null;
      }, 45000);
      if (!uploadedFigures) {
        return { imageCount: getImageFigures(editor).length, captionsSet: 0, altTextSet: 0, imagesUploaded: false };
      }

      let captionsSet = 0;
      let altTextSet = 0;
      for (let index = 0; index < figures.length; index += 1) {
        // Medium replaces the selected figure after caption/alt-text saves;
        // always resolve the current node instead of retaining a stale DOM
        // reference from the initial query.
        const figure = getImageFigures(editor)[index];
        if (!figure) continue;
        const item = meta[index] || {};
        const caption = String(item.caption || '').trim().slice(0, 250);
        const alt = String(item.alt || item.caption || '').trim().slice(0, 500);
        const captionField = figure.querySelector('figcaption.imageCaption, figcaption[contenteditable="true"]');
        if (caption && captionField && setEditableText(captionField, caption)) captionsSet += 1;

        // Medium exposes alt text from the selected-image toolbar. Fill it via
        // the same UI so the value is stored in Medium's model, not just on
        // the DOM image element.
        if (alt) {
          const currentFigure = getImageFigures(editor)[index] || figure;
          const image = currentFigure.querySelector('img.graf-image, img');
          if (image) {
            try { image.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
            image.click();
          }
          const altButton = await waitFor(
            () => Array.from(document.querySelectorAll('button[data-action="alt"]')).find((button) => button.offsetParent !== null),
            5000,
          );
          if (altButton) {
            altButton.click();
            const altEditor = await waitFor(
              () => document.querySelector('.js-textAreaEditor[contenteditable="true"][role="textbox"]'),
              5000,
            );
            if (altEditor && setEditableText(altEditor, alt)) {
              const saveButton = await waitFor(
                () => Array.from(document.querySelectorAll('button')).find((button) => button.offsetParent !== null && /^save$/i.test((button.textContent || '').trim())),
                3000,
              );
              if (saveButton) {
                saveButton.click();
                await new Promise((resolve) => setTimeout(resolve, 250));
                if ((image.alt || '').trim() === alt) altTextSet += 1;
              }
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { imageCount: figures.length, captionsSet, altTextSet, imagesUploaded: true };
    };

    const pasteHtml = (editor, html) => {
      if (!html.trim()) return;
      const data = new DataTransfer();
      data.setData('text/html', html);
      data.setData('text/plain', html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      editor.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }));
    };

    const imagePasteParts = (html, metadata) => {
      const parts = [];
      const figurePattern = /<figure\b[^>]*>[\s\S]*?<\/figure>/gi;
      let cursor = 0;
      let imageIndex = 0;
      let match;
      while ((match = figurePattern.exec(html))) {
        if (!/<img\b/i.test(match[0])) continue;
        parts.push({ type: 'html', html: html.slice(cursor, match.index) });
        parts.push({ type: 'image', meta: metadata[imageIndex] || {} });
        imageIndex += 1;
        cursor = match.index + match[0].length;
      }
      parts.push({ type: 'html', html: html.slice(cursor) });
      return parts;
    };

    const pasteImageFile = async (editor, item, index) => {
      if (!item?.b64 || !item?.mime) return { ok: false, reason: 'missing-image-bytes', index };
      const binary = atob(item.b64);
      const bytes = new Uint8Array(binary.length);
      for (let byteIndex = 0; byteIndex < binary.length; byteIndex += 1) bytes[byteIndex] = binary.charCodeAt(byteIndex);
      let uploadBlob = new Blob([bytes], { type: item.mime });
      let uploadMime = item.mime;
      try {
        if (!['image/jpeg', 'image/png', 'image/gif'].includes(uploadMime)) {
          const bitmap = await createImageBitmap(uploadBlob);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          bitmap.close();
          uploadBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          if (!uploadBlob) return { ok: false, reason: 'image-format-conversion-failed', index };
          uploadMime = 'image/png';
        }
      } catch (error) {
        return { ok: false, reason: `image-format-conversion-failed: ${error?.message || error}`, index };
      }
      const extension = uploadMime === 'image/png' ? 'png' : uploadMime === 'image/gif' ? 'gif' : 'jpg';
      const file = new File([uploadBlob], `contentpulse-${index + 1}.${extension}`, { type: uploadMime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const beforeCount = getImageFigures(editor).length;
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect?.();
      const bounds = editor.getBoundingClientRect();
      const clientX = rect?.width || rect?.height
        ? Math.round(rect.left + rect.width / 2)
        : Math.round(bounds.left + bounds.width / 2);
      const clientY = rect?.width || rect?.height
        ? Math.round(rect.top + rect.height / 2)
        : Math.round(bounds.top + Math.min(bounds.height - 8, 80));
      const target = document.elementFromPoint(clientX, clientY) || editor;
      const dragEvent = (type) => new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transfer,
        clientX,
        clientY,
      });
      target.dispatchEvent(dragEvent('dragenter'));
      target.dispatchEvent(dragEvent('dragover'));
      target.dispatchEvent(dragEvent('drop'));
      const uploaded = await waitFor(() => {
        const figures = getImageFigures(editor);
        const added = figures[beforeCount];
        return figures.length > beforeCount && imageUploadedToMedium(added) ? added : null;
      }, 45000);
      if (!uploaded) {
        // Medium may render an external-image placeholder before rejecting the
        // drop. Remove only the failed insertion so retries never leave an
        // empty image block at the cursor.
        const figures = getImageFigures(editor);
        for (const figure of figures.slice(beforeCount)) {
          if (!imageUploadedToMedium(figure)) figure.remove();
        }
      }
      return uploaded ? { ok: true } : { ok: false, reason: 'medium-image-upload-incomplete', index };
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

    setToast('ContentPulse: Filling content, please wait...', 'progress');

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
        setToast('ContentPulse: Could not detect Medium editor, please try again', 'error');
        resolve({ ok: false, reason: 'no-editor', attempts });
        return;
      }

      try {
        // Medium treats the first block as the title automatically. Pasting
        // remote/data-URI <img> markup only creates an external-image
        // placeholder (data-external-src); it does not upload the bytes.
        // Paste text/formatted HTML in order, and paste each image as a real
        // clipboard File so Medium runs its native uploader at that position.
        const fullHtml = titleText ? `<h3>${titleText}</h3>${bodyHtml}` : bodyHtml;

        editorEl.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editorEl);
        sel.removeAllRanges();
        sel.addRange(range);

        (async () => {
          const parts = imagePasteParts(fullHtml, Array.isArray(imageMeta) ? imageMeta : []);
          let firstInsert = true;
          for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            const part = parts[partIndex];
            if (part.type === 'html') {
              if (!part.html.trim()) continue;
              pasteHtml(editorEl, part.html);
              firstInsert = false;
              await new Promise((r) => setTimeout(r, 250));
              continue;
            }
            const result = await pasteImageFile(editorEl, part.meta, partIndex);
            if (!result.ok) {
              scrollToTop();
              setToast('ContentPulse: Medium did not finish uploading all images. Please retry or add them manually.', 'error');
              resolve({ ok: false, ...result, imageCount: getImageFigures(editorEl).length, imagesUploaded: false });
              return;
            }
            firstInsert = false;
          }
          if (firstInsert) pasteHtml(editorEl, fullHtml);
          const metadata = await fillImageMetadata(editorEl);
          scrollToTop();
          if (Array.isArray(imageMeta) && imageMeta.length && !metadata.imagesUploaded) {
            setToast('ContentPulse: Medium did not finish uploading all images. Please retry or add them manually.', 'error');
            resolve({ ok: false, reason: 'medium-image-upload-incomplete', ...metadata });
            return;
          }
          setToast(
            metadata.imageCount
              ? `ContentPulse: Article filled with ${metadata.imageCount} image${metadata.imageCount === 1 ? '' : 's'} and SEO text`
              : 'ContentPulse: Article filled successfully',
            'ok',
          );
          resolve({ ok: true, attempts, ...metadata });
        })();
      } catch (e) {
        log('fill error', e);
        setToast('ContentPulse: Could not fill the editor, please try again', 'error');
        resolve({ ok: false, error: e.message, attempts });
      }
    };
    tick();
  });
}

async function mediumPageFill(tabId, title, bodyHtml, bodyText, imageMeta) {
  if (!tabId) return { ok: false, error: 'No tab id for Medium page fill' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpMediumPageFill,
      args: [title || '', bodyHtml || '', bodyText || '', imageMeta || []],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] mediumPageFill result', result);
    return result || { ok: false, error: 'No result from Medium page fill' };
  } catch (e) {
    log('[ContentPulse][bg] mediumPageFill error', e);
    return { ok: false, error: e.message };
  }
}

async function mediumPageShowError(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (text) => {
        let toast = document.getElementById('contentpulse-toast');
        if (!toast) {
          toast = document.createElement('div');
          toast.id = 'contentpulse-toast';
          Object.assign(toast.style, {
            position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
            maxWidth: '360px', padding: '12px 16px', borderRadius: '8px',
            fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
            fontSize: '14px', color: '#fff', background: '#c0392b',
            boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
          });
          document.body.appendChild(toast);
        }
        toast.textContent = `ContentPulse: ${text}`;
        setTimeout(() => toast.remove(), 6000);
      },
      args: [message],
    });
  } catch (error) {
    warn('[ContentPulse][bg] Could not show Medium image error', error);
  }
}

// ── Substack page fill ──────────────────────────────────────────────
// Runs in the page (MAIN world). Substack's editor has textarea inputs for
// title/subtitle and a TipTap/ProseMirror contenteditable for the body.
