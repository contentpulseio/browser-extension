// ContentPulse background: linkedin publisher.
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
