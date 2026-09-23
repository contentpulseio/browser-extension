// ContentPulse background: platform services.
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
  } catch (e) {
    log('[ContentPulse][bg] pageFillSeo executeScript error', e);
    return { ok: false, error: e.message };
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
