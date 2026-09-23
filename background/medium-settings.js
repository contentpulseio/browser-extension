// ContentPulse background: medium settings.
function cpMediumSettingsFill(topicNames, seoTitle, seoDescription, canonicalUrl) {
  return new Promise((resolve) => {
    const CP_DEBUG = false;
    const log = (...args) => { if (CP_DEBUG) console.log('[ContentPulse][medium-settings]', ...args); };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    const waitFor = async (cond, timeoutMs, stepMs = 300) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const val = cond();
        if (val) return val;
        if (Date.now() >= deadline) return null;
        await sleep(stepMs);
      }
    };

    const setNative = (el, value) => {
      const isTextarea = el.tagName === 'TEXTAREA';
      const proto = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    (async () => {
      setToast('ContentPulse: Filling Medium settings...', 'progress');
      let filledTags = 0;
      let filledSeoTitle = false;
      let filledSeoDescription = false;
      let filledCanonical = false;

      // ── Fill tags (Reader Interests) ──
      // Medium's tag input: input[role="combobox"] with placeholder "Add a topic..."
      // inside #reader_interests.
      if (topicNames && topicNames.length > 0) {
        const topics = topicNames.slice(0, 5);
        log('filling topics', topics);

        const findTagInput = () => {
          const container = document.getElementById('reader_interests');
          if (container) {
            const inp = container.querySelector('input[role="combobox"]') || container.querySelector('input');
            if (inp) return inp;
          }
          const inputs = document.querySelectorAll('input[role="combobox"], input[placeholder*="topic" i]');
          return inputs.length > 0 ? inputs[0] : null;
        };

        const tagInput = await waitFor(findTagInput, 8000);
        if (tagInput) {
          for (const topic of topics) {
            tagInput.focus();
            setNative(tagInput, topic);

            // Wait for suggestions dropdown, then pick the first matching option.
            await sleep(700);

            const suggestion = await waitFor(() => {
              const menu = document.getElementById('tagMultiSelectMenu')
                || document.querySelector('[role="listbox"]');
              if (menu) {
                const first = menu.querySelector('[role="option"], li, button');
                if (first) return first;
              }
              return null;
            }, 2500, 200);

            if (suggestion) {
              suggestion.click();
              filledTags++;
              log('clicked suggestion for', topic);
            } else {
              tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              tagInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              filledTags++;
              log('pressed Enter for', topic);
            }
            await sleep(500);
          }
        } else {
          log('tag input not found');
        }
      }

      // ── Fill SEO Title ──
      if (seoTitle && seoTitle.trim()) {
        log('filling SEO title', seoTitle);
        const seoSection = document.getElementById('seo_settings');
        if (seoSection) {
          const seoTitleInput = seoSection.querySelector('input[type="text"], input:not([type])');
          if (seoTitleInput) {
            seoTitleInput.focus();
            setNative(seoTitleInput, seoTitle.slice(0, 60));
            filledSeoTitle = true;
            log('SEO title filled');

            await sleep(500);

            // The Save button sits in a sibling div within the shared
            // wrapper (.mi or the nearest ancestor containing both the
            // input and the button). Walk up to find a container that
            // holds a <button> with "Save" text.
            let saveBtn = null;
            let ancestor = seoTitleInput.parentElement;
            for (let i = 0; i < 6 && ancestor; i++) {
              const btns = ancestor.querySelectorAll('button');
              for (const b of btns) {
                if ((b.textContent || '').trim() === 'Save') { saveBtn = b; break; }
              }
              if (saveBtn) break;
              ancestor = ancestor.parentElement;
            }
            if (saveBtn) {
              saveBtn.click();
              log('SEO title saved');
              await sleep(800);
            } else {
              log('SEO title Save button not found');
            }
          }
        }
      }

      // ── Fill SEO Description ──
      if (seoDescription && seoDescription.trim()) {
        log('filling SEO description', seoDescription);
        const seoSection = document.getElementById('seo_settings');
        if (seoSection) {
          const seoDescTextarea = seoSection.querySelector('textarea');
          if (seoDescTextarea) {
            seoDescTextarea.focus();
            setNative(seoDescTextarea, seoDescription.slice(0, 156));
            filledSeoDescription = true;
            log('SEO description filled');

            await sleep(500);

            let saveBtn = null;
            let ancestor = seoDescTextarea.parentElement;
            for (let i = 0; i < 6 && ancestor; i++) {
              const btns = ancestor.querySelectorAll('button');
              for (const b of btns) {
                if ((b.textContent || '').trim() === 'Save') { saveBtn = b; break; }
              }
              if (saveBtn) break;
              ancestor = ancestor.parentElement;
            }
            if (saveBtn) {
              saveBtn.click();
              log('SEO description saved');
              await sleep(800);
            } else {
              log('SEO description Save button not found');
            }
          }
        }
      }

      // ── Fill canonical URL ──
      if (canonicalUrl && canonicalUrl.trim()) {
        log('filling canonical URL', canonicalUrl);
        const findCanonicalInput = () => {
          const headings = document.querySelectorAll('h2, h3, label');
          for (const h of headings) {
            const txt = (h.textContent || '').toLowerCase();
            if (txt.includes('canonical') || txt.includes('originally published')) {
              const container = h.closest('div.lo, div.e, section, fieldset');
              if (container) {
                const inp = container.querySelector('input');
                if (inp) return inp;
              }
            }
          }
          return null;
        };

        const canonicalInput = await waitFor(findCanonicalInput, 5000);
        if (canonicalInput) {
          canonicalInput.focus();
          setNative(canonicalInput, canonicalUrl);
          canonicalInput.dispatchEvent(new Event('blur', { bubbles: true }));
          filledCanonical = true;
          log('canonical URL filled');
        } else {
          log('canonical URL input not found');
        }
      }

      const parts = [];
      if (filledTags > 0) parts.push(`${filledTags} tag${filledTags > 1 ? 's' : ''}`);
      if (filledSeoTitle) parts.push('SEO title');
      if (filledSeoDescription) parts.push('SEO description');
      if (filledCanonical) parts.push('canonical URL');

      if (parts.length > 0) {
        setToast(`ContentPulse: Filled ${parts.join(', ')}`, 'ok');
        resolve({ ok: true, filledTags, filledSeoTitle, filledSeoDescription, filledCanonical });
      } else {
        setToast('ContentPulse: No settings fields could be filled', 'error');
        resolve({ ok: false, filledTags: 0, filledSeoTitle: false, filledSeoDescription: false, filledCanonical: false });
      }
    })();
  });
}

async function mediumSettingsFill(tabId, topicNames, seoTitle, seoDescription, canonicalUrl) {
  if (!tabId) return { ok: false, error: 'No tab id for Medium settings fill' };
  const hasTopics = topicNames && topicNames.length > 0;
  const hasSeo = (seoTitle && seoTitle.trim()) || (seoDescription && seoDescription.trim());
  const hasCanonical = canonicalUrl && canonicalUrl.trim();
  if (!hasTopics && !hasSeo && !hasCanonical) {
    return { ok: true, skipped: true };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: cpMediumSettingsFill,
      args: [topicNames || [], seoTitle || '', seoDescription || '', canonicalUrl || ''],
    });
    const result = results && results[0] ? results[0].result : null;
    log('[ContentPulse][bg] mediumSettingsFill result', result);
    return result || { ok: false, error: 'No result from Medium settings fill' };
  } catch (e) {
    log('[ContentPulse][bg] mediumSettingsFill error', e);
    return { ok: false, error: e.message };
  }
}

// After filling the Medium editor, navigate to the settings page and fill
// tags, SEO fields, and canonical URL. The settings URL is derived from the
// draft URL: /p/<id>/edit → /p/<id>/settings.
async function mediumAfterFill(tabId, tags, categories, canonicalUrl, seoTitle, seoDescription) {
  const topicNames = tags.length > 0 ? tags : categories;
  const hasWork = topicNames.length > 0 || canonicalUrl || (seoTitle && seoTitle.trim()) || (seoDescription && seoDescription.trim());
  if (!hasWork) return;

  // Commit the last editor change before opening settings. Medium autosaves on
  // input/blur; waiting for its saved indicator prevents settings work from
  // racing the draft save.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const editor = document.querySelector('.postArticle-content[contenteditable="true"], [contenteditable="true"].js-postField');
      editor?.blur();
      document.activeElement?.blur?.();
    },
    args: [],
  }).catch(() => {});

  // Wait for Medium to auto-save the draft. Poll for the "Draft Saved"
  // indicator in the editor's metabar; if it never confirms, leave the editor
  // untouched and do not risk navigating away with unsaved content.
  const draftSaved = await new Promise((resolve) => {
    let elapsed = 0;
    const check = async () => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const el = document.querySelector('.js-metabarMessage');
            return el ? el.textContent : '';
          },
          args: [],
        });
        const text = (results && results[0] ? results[0].result : '') || '';
        if (text.toLowerCase().includes('saved')) {
          resolve(true);
          return;
        }
      } catch (_) { /* ignore */ }
      elapsed += 1000;
      if (elapsed >= 8000) {
        resolve(false);
        return;
      }
      setTimeout(check, 1000);
    };
    setTimeout(check, 1500);
  });
  log('[ContentPulse][bg] draft saved status:', draftSaved);
  if (!draftSaved) {
    warn('[ContentPulse][bg] Medium did not confirm draft save; leaving editor open and skipping settings');
    return;
  }

  const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
  if (!tabInfo?.url) return;

  // Settings live on a separate tab: navigating the editor itself can trigger
  // Medium's unsaved-changes confirmation even after autosave. Keep the filled
  // editor alive, run settings in a temporary tab, then explicitly restore it.
  const draftMatch = tabInfo.url.match(/medium\.com\/p\/([a-f0-9]+)\/edit/);
  const newStoryMatch = tabInfo.url.match(/medium\.com\/new-story/);
  let settingsUrl = '';
  if (draftMatch) {
    settingsUrl = `https://medium.com/p/${draftMatch[1]}/settings`;
  } else if (newStoryMatch) {
    // Medium assigns the persisted draft URL after first save. Re-read it
    // before settings work; if it is still a new story, keep the editor open.
    const refreshed = await chrome.tabs.get(tabId).catch(() => null);
    const persisted = refreshed?.url?.match(/medium\.com\/p\/([a-f0-9]+)\/edit/);
    if (persisted) settingsUrl = `https://medium.com/p/${persisted[1]}/settings`;
  } else {
    return;
  }
  if (!settingsUrl) return;

  let settingsTabId = null;
  try {
    log('[ContentPulse][bg] opening Medium settings in a temporary tab', settingsUrl);
    const settingsTab = await chrome.tabs.create({ url: settingsUrl, active: false });
    settingsTabId = settingsTab?.id || null;
    if (!settingsTabId) return;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimeout);
        chrome.tabs.onUpdated.removeListener(loadListener);
        setTimeout(resolve, 1200);
      };
      const loadTimeout = setTimeout(finish, 12000);
      const loadListener = (updatedTabId, changeInfo) => {
        if (updatedTabId === settingsTabId && changeInfo.status === 'complete') finish();
      };
      chrome.tabs.onUpdated.addListener(loadListener);
      chrome.tabs.get(settingsTabId, (current) => {
        if (current?.status === 'complete') finish();
      });
    });

    const result = await mediumSettingsFill(settingsTabId, topicNames.slice(0, 5), seoTitle, seoDescription, canonicalUrl);
    log('[ContentPulse][bg] Medium settings fill complete', result);
  } finally {
    if (settingsTabId) await chrome.tabs.remove(settingsTabId).catch(() => {});
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => window.scrollTo({ top: 0, behavior: 'instant' }),
      args: [],
    }).catch(() => {});
  }
}

// ── End Medium page fill ───────────────────────────────────────────

// Runs in the page (MAIN world). Makes sure the LinkedIn article editor's
// "Publish as" entity matches the wanted name (personal profile or a company
// page). Opens the actor toggle, picks the matching radio, saves, verifies.
