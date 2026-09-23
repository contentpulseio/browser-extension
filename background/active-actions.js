// ContentPulse background: active actions.
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
