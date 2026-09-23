// ContentPulse background: linkedin media.
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

    const commitCaption = async (field, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      field.focus();
      setter.call(field, value);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      field.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      field.blur();
      // LinkedIn's Ember model persists the caption on focusout, not merely
      // when the DOM value changes. Verify after that commit boundary.
      await sleep(600);
      return field.isConnected && (field.value || '').trim() === value;
    };

    const isVisible = (el) => !!(el && el.offsetParent !== null);
    const findInput = () => document.getElementById('media-editor-file-selector__file-input');
    const findCreditField = () => {
      const candidates = Array.from(
        document.querySelectorAll(
          'textarea.article-editor-cover-image-v2__caption, textarea[placeholder*="credit" i], textarea[aria-label*="credit" i], textarea[placeholder*="caption" i], textarea[aria-label*="caption" i]',
        ),
      ).filter(isVisible);
      return candidates[0] || null;
    };

    const fillCoverCaption = async (value) => {
      const caption = String(value || '').trim().slice(0, 150);
      if (!caption) return false;
      const field = await waitFor(findCreditField, 8000);
      if (!field) return false;
      if ((field.value || '').trim() === caption) return true;
      return commitCaption(field, caption);
    };

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
        const creditOk = await fillCoverCaption(creditText);
        toast(
          creditOk
            ? 'ContentPulse: Existing cover image caption updated'
            : (creditText || '').trim()
              ? 'ContentPulse: Existing cover image found, but its caption could not be updated'
              : 'ContentPulse: Cover image already set - no caption supplied',
          creditOk || !(creditText || '').trim() ? 'ok' : 'error',
        );
        resolve({ ok: true, skipped: true, reason: 'cover-exists', creditOk });
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
          const creditValue = creditText.trim().slice(0, 150);
          for (let attempt = 0; coverImg && !creditOk && attempt < 3; attempt += 1) {
            creditOk = await fillCoverCaption(creditValue);
            if (!creditOk) await sleep(1000);
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

// Runs in LinkedIn's page. Inline images use a different uploader from the
// cover image: the toolbar opens an "Add image or video" dialog, then the
// resulting figure exposes a native textarea for its caption.
function cpFillInlineImage(b64, mime, captionText, anchorText, debugEnabled) {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const debug = (() => {
      try {
        return debugEnabled === true || new URL(location.href).searchParams.get('cp_debug') === '1';
      } catch (e) {
        return debugEnabled === true;
      }
    })();
    const debugLog = (event, detail) => {
      if (debug) console.info('[ContentPulse][LinkedIn inline image]', event, JSON.stringify(detail || {}));
    };
    const waitFor = async (cond, timeoutMs, stepMs = 200) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = cond();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };
    const commitCaption = async (field, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      field.focus();
      setter.call(field, value);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      field.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      field.blur();
      await sleep(600);
      return field.isConnected && (field.value || '').trim() === value;
    };
    // LinkedIn renders the article toolbar in a fixed/sticky layer. For those
    // controls offsetParent is legitimately null even while the element is
    // visible and clickable, so offsetParent is not a valid visibility test.
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        Number(style.opacity || 1) > 0
      );
    };
    const editor = () => document.querySelector('[data-test-article-editor-content-textbox], div.ProseMirror[contenteditable="true"]');
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const imageButton = () =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => visible(button) && button.querySelector('svg[data-test-icon="image-medium"], use[href="#image-medium"]'),
      );
    const imageDialog = () =>
      Array.from(document.querySelectorAll('[role="dialog"], .artdeco-modal')).find(
        (el) => visible(el) && /add image or video/i.test(el.textContent || ''),
      );
    const restorePicker = (() => {
      const originalClick = HTMLInputElement.prototype.click;
      const originalShowPicker = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.click = function (...args) {
        if (this.type === 'file') return undefined;
        return originalClick.apply(this, args);
      };
      if (originalShowPicker) {
        HTMLInputElement.prototype.showPicker = function (...args) {
          if (this.type === 'file') return undefined;
          return originalShowPicker.apply(this, args);
        };
      }
      return () => {
        HTMLInputElement.prototype.click = originalClick;
        if (originalShowPicker) HTMLInputElement.prototype.showPicker = originalShowPicker;
      };
    })();

    (async () => {
      try {
        const body = editor();
        const button = imageButton();
        if (!body || !button) {
          resolve({ ok: false, reason: 'inline-image-toolbar-not-found' });
          return;
        }

        // Place the image after the source section's heading. Falling back to
        // the end keeps older/plain articles working when no matching heading
        // is present. If that section already has an imported image, insert
        // after it so repeated images retain source order.
        let insertionPlaceholder = null;
        let insertionReference = null;
        const setInsertionPoint = () => {
          const wanted = normalizeText(anchorText);
          const headings = Array.from(body.querySelectorAll('h1, h2, h3, h4, h5, h6')).reverse();
          const captionHint = normalizeText(captionText);
          // Some rendered article variants omit the source-side anchor while
          // keeping the chart title in the caption. Prefer that exact title
          // match so a stale/missing anchor cannot send the image elsewhere.
          const headingByCaption = captionHint
            ? headings
                .filter((el) => {
                  const headingText = normalizeText(el.textContent);
                  return headingText && captionHint.includes(headingText);
                })
                .sort((a, b) => normalizeText(b.textContent).length - normalizeText(a.textContent).length)[0]
            : null;
          const heading = headingByCaption || (wanted ? headings.find((el) => normalizeText(el.textContent) === wanted) : null);
          let insertionNode = heading;
          let placeholder = null;
          if (heading) {
            let sibling = heading.nextElementSibling;
            while (sibling && !/^H[1-6]$/i.test(sibling.tagName)) {
              if (sibling.matches('figure.article-editor-figure-image')) insertionNode = sibling;
              else if (!placeholder && sibling.matches('p') && !normalizeText(sibling.textContent)) placeholder = sibling;
              sibling = sibling.nextElementSibling;
            }
          }
          const range = document.createRange();
          if (placeholder && insertionNode === heading) {
            // Reuse a real source-side empty paragraph when one exists.
            placeholder.scrollIntoView({ block: 'center', inline: 'nearest' });
            placeholder.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            placeholder.click();
            placeholder.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            body.focus();
            range.selectNodeContents(placeholder);
            range.collapse(true);
          } else if (insertionNode) {
            // A block boundary is a valid insertion point: don't manufacture
            // a visible blank line just to anchor the upload. If LinkedIn
            // ignores this bookmark, the post-upload placement repair below
            // still restores the image under its heading.
            range.setStartAfter(insertionNode);
          } else {
            range.selectNodeContents(body);
            range.collapse(false);
          }
          range.collapse(true);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          body.focus();
          const selectedNode = selection.anchorNode;
          if (placeholder && insertionNode === heading && !(placeholder.contains(selectedNode) || selectedNode === placeholder)) {
            return false;
          }
          insertionPlaceholder = placeholder;
          insertionReference = insertionNode;
          debugLog('insertion-point', {
            headingFound: !!heading,
            heading: heading?.textContent?.trim().slice(0, 120) || '',
            anchorMatched: !!heading && normalizeText(heading.textContent) === wanted,
            placeholderReused: !!placeholder,
            captionPreview: String(captionText || '').trim().slice(0, 120),
          });
          return !!heading;
        };

        if (!setInsertionPoint()) {
          resolve({ ok: false, reason: 'inline-image-slot-focus-failed' });
          return;
        }
        // Allow LinkedIn's editor observer to register the clicked line and
        // preserve that selection bookmark before the upload dialog opens.
        await sleep(150);

        const beforeCount = body.querySelectorAll('figure.article-editor-figure-image').length;
        const existingInputs = new Set(Array.from(document.querySelectorAll('input[type="file"]')));
        button.click();
        // LinkedIn reuses the same input id for the cover-image and inline
        // media dialogs. Selecting by id (or excluding that id) is therefore
        // unreliable after a cover has already been uploaded. Scope the file
        // input to the active "Add image or video" dialog instead.
        let dialog = await waitFor(imageDialog, 1500);
        const input = await waitFor(
          () => {
            const inputs = dialog
              ? Array.from(dialog.querySelectorAll('input[type="file"]'))
              : Array.from(document.querySelectorAll('input[type="file"]')).filter((candidate) => !existingInputs.has(candidate));
            return inputs[inputs.length - 1] || null;
          },
          8000,
        );
        if (!input) {
          resolve({ ok: false, reason: 'inline-image-file-input-not-found' });
          return;
        }

        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        const file = new File([bytes], `contentpulse-inline.${ext}`, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        dialog = dialog || (await waitFor(imageDialog, 10000));
        if (!dialog) {
          resolve({ ok: false, reason: 'inline-image-dialog-not-found' });
          return;
        }
        const next = await waitFor(
          () => Array.from(dialog.querySelectorAll('button')).find((el) => visible(el) && /^next$/i.test((el.textContent || '').trim()) && !el.disabled),
          8000,
        );
        if (!next) {
          resolve({ ok: false, reason: 'inline-image-next-not-found' });
          return;
        }
        next.click();

        const figure = await waitFor(
          () => {
            const figures = Array.from(body.querySelectorAll('figure.article-editor-figure-image'));
            return figures.length > beforeCount ? figures[figures.length - 1] : null;
          },
          60000,
        );
        if (!figure) {
          resolve({ ok: false, reason: 'inline-image-not-inserted' });
          return;
        }

        // Some LinkedIn builds ignore the selection bookmark and append the
        // uploaded figure to the document tail. The upload itself succeeded,
        // so repair only that placement: put the new figure directly after
        // the heading/previous figure captured above and notify the editor's
        // DOM observer. This is the same location a focused blank line uses.
        if (
          insertionReference?.isConnected &&
          insertionReference.parentNode === body &&
          figure.parentNode === body &&
          figure !== insertionReference.nextElementSibling
        ) {
          insertionReference.parentNode.insertBefore(figure, insertionReference.nextElementSibling);
          body.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertFromPaste',
          }));
          await sleep(250);
        }

        // A chart may have no figcaption in the API HTML even though its
        // section heading is available as the insertion anchor. Use that
        // chart title as the native LinkedIn caption in that case.
        const captionSource = String(captionText || '').trim() ? 'explicit' : String(anchorText || '').trim() ? 'anchor-heading' : 'none';
        const caption = String(captionText || anchorText || '').trim().slice(0, 250);
        let captionOk = !caption;
        let captionFieldFound = false;
        if (caption) {
          const field = await waitFor(
            () => figure.querySelector('textarea.article-editor-figure-caption, textarea[data-test-inline-image-caption]'),
            10000,
          );
          if (field) {
            captionFieldFound = true;
            captionOk = await commitCaption(field, caption);
          }
        }

        // The temporary paragraph is only a selection anchor. LinkedIn can
        // leave it behind after the upload, or recreate it while committing
        // the caption. Clean it after the image/caption transaction settles,
        // and only remove empty paragraphs between the captured insertion
        // reference and this figure. This preserves intentional spacing
        // elsewhere in the article while removing the extra line introduced
        // solely to open the inline-image uploader.
        const isEmptyAnchor = (node) =>
          !!node &&
          node.matches?.('p') &&
          !normalizeText(node.textContent) &&
          !node.querySelector('img, figure');
        const cleanupInsertionAnchors = () => {
          const removable = new Set();
          if (isEmptyAnchor(insertionPlaceholder)) removable.add(insertionPlaceholder);

          if (
            insertionReference?.isConnected &&
            insertionReference.parentNode === body &&
            figure?.isConnected &&
            figure.parentNode === body
          ) {
            let sibling = insertionReference.nextElementSibling;
            while (sibling && sibling !== figure) {
              if (!isEmptyAnchor(sibling)) break;
              removable.add(sibling);
              sibling = sibling.nextElementSibling;
            }
          }

          // LinkedIn's block-image uploader creates a trailing empty text
          // paragraph so users can continue typing after the image. Between
          // existing article blocks that paragraph is redundant and renders
          // as a conspicuous blank line; retain it only when the image is the
          // final block, where ProseMirror needs a caret target.
          let trailingParagraph = figure?.nextElementSibling;
          const trailingAnchors = [];
          while (isEmptyAnchor(trailingParagraph)) {
            trailingAnchors.push(trailingParagraph);
            trailingParagraph = trailingParagraph.nextElementSibling;
          }
          // The editor may create a second empty caret paragraph while the
          // upload selection is being committed. Remove the whole empty run
          // only when a real block follows it; keep the terminal caret block.
          if (trailingParagraph) trailingAnchors.forEach((node) => removable.add(node));

          if (!removable.size) return 0;
          for (const node of removable) node.remove();
          body.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'deleteContentBackward',
          }));
          return removable.size;
        };

        // Let LinkedIn finish its caption render before removing the anchor;
        // otherwise its editor observer can immediately recreate the blank
        // line we just removed.
        await sleep(250);
        const cleanedParagraphs = cleanupInsertionAnchors();
        debugLog('image-complete', {
          captionRequested: !!caption,
          captionSource,
          captionLength: caption.length,
          captionFieldFound,
          captionOk,
          cleanedParagraphs,
          terminalCaretKept: !!figure.nextElementSibling && isEmptyAnchor(figure.nextElementSibling),
        });
        resolve({ ok: true, captionOk, captionFieldFound, cleanedParagraphs });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      } finally {
        restorePicker();
      }
    })();
  });
}

async function pageFillInlineImages(tabId, images, debugEnabled = false) {
  const list = Array.isArray(images) ? images.filter((image) => image && image.url) : [];
  const results = [];
  for (const image of list) {
    try {
      const imageData = image.b64 && image.mime
        ? { b64: image.b64, mime: image.mime }
        : await fetchImageAsBase64(image.url);
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: cpFillInlineImage,
        args: [imageData.b64, imageData.mime, image.caption || '', image.anchorText || '', debugEnabled],
      });
      const result = injected && injected[0] ? injected[0].result : null;
      results.push(result || { ok: false, reason: 'no-result' });
    } catch (e) {
      results.push({ ok: false, error: `Could not download ${image.url}: ${e.message}` });
    }
  }
  log('[ContentPulse][bg] pageFillInlineImages results', results);
  return results;
}
