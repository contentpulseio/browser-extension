// ContentPulse in-page panel for LinkedIn (Honey-style).
//
// Injects a floating ContentPulse bubble on the right edge of every LinkedIn
// page. Clicking it slides open a persistent panel that embeds the extension
// UI (popup.html) in an iframe, so users do not have to reopen the toolbar
// popup for every step. Open state is remembered per tab across navigations.
(() => {
  if (window.top !== window) return; // never inject inside iframes
  if (window.__cpPanelInjected) return;
  window.__cpPanelInjected = true;

  const OPEN_KEY = 'cpPanelOpen';
  const Z = 2147483646;

  const logoUrl = chrome.runtime.getURL('assets/cp-logo-64.png');
  const panelUrl = chrome.runtime.getURL('popup.html?embedded=1');

  // Pin the bubble's look in EVERY interaction state. LinkedIn's own button
  // CSS (hover/focus/active ripple + gradient overlays via pseudo-elements)
  // can bleed onto our injected <button>; inline styles alone cannot beat
  // pseudo-elements or !important page rules, so we ship our own !important
  // stylesheet and disable ::before/::after entirely.
  const guard = document.createElement('style');
  guard.id = 'cp-panel-fab-style';
  guard.textContent = [
    '#cp-panel-fab, #cp-panel-fab:hover, #cp-panel-fab:focus, #cp-panel-fab:focus-visible, #cp-panel-fab:active {',
    '  background: #52227a !important;',
    '  background-image: none !important;',
    '  border: none !important;',
    '  outline: none !important;',
    '  box-shadow: 0 4px 14px rgba(0,0,0,.25) !important;',
    '}',
    '#cp-panel-fab::before, #cp-panel-fab::after {',
    '  content: none !important;',
    '  display: none !important;',
    '}',
  ].join('\n');
  document.documentElement.appendChild(guard);

  // ── Floating bubble ──
  const fab = document.createElement('button');
  fab.id = 'cp-panel-fab';
  fab.type = 'button';
  fab.title = 'Open ContentPulse Publisher';
  fab.setAttribute('aria-label', 'Open ContentPulse Publisher');
  fab.style.cssText = [
    'position:fixed',
    'top:35%',
    'right:0',
    `z-index:${Z}`,
    'width:52px',
    'height:48px',
    'padding:0 6px 0 10px',
    'border:none',
    'border-radius:24px 0 0 24px',
    'background:#52227a',
    'box-shadow:0 4px 14px rgba(0,0,0,.25)',
    'cursor:pointer',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'transition:width .15s ease',
  ].join(';');

  const fabImg = document.createElement('img');
  fabImg.src = logoUrl;
  fabImg.alt = 'ContentPulse';
  fabImg.style.cssText = 'width:30px;height:30px;border-radius:8px;display:block;pointer-events:none';
  fab.appendChild(fabImg);

  fab.addEventListener('mouseenter', () => (fab.style.width = '58px'));
  fab.addEventListener('mouseleave', () => (fab.style.width = '52px'));

  // ── Panel shell (header + iframe) ──
  let panel = null;

  function buildPanel() {
    const wrap = document.createElement('div');
    wrap.id = 'cp-panel';
    wrap.style.cssText = [
      'position:fixed',
      'top:70px',
      'right:14px',
      `z-index:${Z}`,
      'width:420px',
      'max-width:calc(100vw - 28px)',
      'height:min(660px, calc(100vh - 90px))',
      'display:flex',
      'flex-direction:column',
      'background:#fff',
      'border:1px solid #e5e7eb',
      'border-radius:14px',
      'box-shadow:0 18px 50px rgba(0,0,0,.28)',
      'overflow:hidden',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:8px 12px',
      'background:#52227a',
      'color:#fff',
      'font:600 13px/1.2 -apple-system,Segoe UI,sans-serif',
      'flex:0 0 auto',
    ].join(';');

    const headImg = document.createElement('img');
    headImg.src = logoUrl;
    headImg.alt = '';
    headImg.style.cssText = 'width:18px;height:18px;border-radius:5px';
    const headTxt = document.createElement('span');
    headTxt.textContent = 'ContentPulse Publisher';
    headTxt.style.cssText = 'flex:1';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.title = 'Close panel';
    closeBtn.setAttribute('aria-label', 'Close ContentPulse panel');
    closeBtn.textContent = '\u00d7';
    closeBtn.style.cssText = [
      'border:none',
      'background:rgba(255,255,255,.18)',
      'color:#fff',
      'width:24px',
      'height:24px',
      'border-radius:7px',
      'font-size:16px',
      'line-height:1',
      'cursor:pointer',
    ].join(';');
    closeBtn.addEventListener('click', () => setOpen(false));

    head.appendChild(headImg);
    head.appendChild(headTxt);
    head.appendChild(closeBtn);

    const frame = document.createElement('iframe');
    frame.src = panelUrl;
    frame.title = 'ContentPulse Publisher';
    frame.style.cssText = 'flex:1;width:100%;border:none;background:#f7f9fb';

    wrap.appendChild(head);
    wrap.appendChild(frame);
    return wrap;
  }

  function isOpen() {
    return panel !== null && document.body.contains(panel);
  }

  function setOpen(open) {
    if (open && !isOpen()) {
      panel = buildPanel();
      document.body.appendChild(panel);
      fab.style.display = 'none';
    } else if (!open && isOpen()) {
      panel.remove();
      panel = null;
      fab.style.display = 'flex';
    }
    try {
      sessionStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch (e) {}
  }

  fab.addEventListener('click', () => setOpen(true));

  document.body.appendChild(fab);

  // Restore the panel if it was open before an in-tab navigation/reload.
  let wasOpen = false;
  try {
    wasOpen = sessionStorage.getItem(OPEN_KEY) === '1';
  } catch (e) {}
  if (wasOpen) setOpen(true);
})();
