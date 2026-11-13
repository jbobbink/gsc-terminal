// GSC Terminal: replaces Search Console performance reports with the terminal (overlay iframe).
// DOM is built with DOM APIs only: Search Console enforces Trusted Types, so innerHTML is not allowed.
(() => {
  if (window.__gsctermContent) return;
  window.__gsctermContent = true;

  const EXT_ORIGIN = 'chrome-extension://' + chrome.runtime.id;
  document.documentElement.dataset.gsctermExt = chrome.runtime.id; // lets the MAIN-world bridge verify our iframe

  const isPerf = () => /\/search-console\/performance\//.test(location.pathname);
  const site = () => new URL(location.href).searchParams.get('resource_id') || '';
  let auto = true, visible = false, lastHref = location.href, reloadTimer = null;

  const overlay = document.createElement('div');
  overlay.id = 'gscterm-overlay';
  Object.assign(overlay.style, { position: 'fixed', left: '0', right: '0', bottom: '0', top: '64px', zIndex: '2147483000',
    background: '#131722', display: 'none', borderTop: '1px solid #2a2e39' });
  const frame = document.createElement('iframe');
  Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });
  frame.allow = 'clipboard-write';
  overlay.appendChild(frame);

  const btn = document.createElement('button');
  btn.id = 'gscterm-btn';
  btn.textContent = '📈 Terminal';
  btn.title = 'Show this report in GSC Terminal';
  Object.assign(btn.style, { position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483001', padding: '8px 14px',
    background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: '6px', display: 'none',
    font: '600 13px -apple-system, Roboto, sans-serif', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,.3)' });
  btn.addEventListener('click', () => show(true));

  function headerBottom() {
    const h = document.querySelector('header');
    const b = h ? h.getBoundingClientRect().bottom : 64;
    return Math.max(0, Math.round(b)) + 'px';
  }

  function frameUrl() {
    const q = new URLSearchParams({ embed: '1', site: site(), path: location.pathname });
    return chrome.runtime.getURL('chart.html') + '?' + q;
  }

  function show(userAction) {
    if (!isPerf()) return;
    overlay.style.top = headerBottom();
    if (!frame.src) frame.src = frameUrl();
    else post({ type: 'gscterm:reload', site: site(), path: location.pathname });
    overlay.style.display = 'block';
    btn.style.display = 'none';
    visible = true;
    if (userAction && !auto) setAuto(true);
  }
  function hide(userAction) {
    overlay.style.display = 'none';
    btn.style.display = isPerf() ? 'block' : 'none';
    visible = false;
    if (userAction) setAuto(false);
  }
  function setAuto(v) { auto = v; chrome.storage.local.set({ autoReplace: v }); }
  function post(msg) { if (frame.contentWindow) frame.contentWindow.postMessage(msg, EXT_ORIGIN); }

  // Messages from the terminal iframe
  window.addEventListener('message', e => {
    if (e.origin !== EXT_ORIGIN || !e.data) return;
    if (e.data.type === 'gscterm:hide') hide(true);
    if (e.data.type === 'gscterm:navigate' && e.data.site) {
      const u = new URL(location.href);
      u.searchParams.set('resource_id', e.data.site);
      location.href = u.toString();
    }
  });

  // Search Console is a single-page app: follow URL changes (filters, dates, report switches).
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (!isPerf()) { overlay.style.display = 'none'; btn.style.display = 'none'; visible = false; return; }
    if (visible) {
      // give GSC a moment to fetch the new view so the bridge sees the new filters
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => post({ type: 'gscterm:reload', site: site(), path: location.pathname }), 1500);
    } else if (auto) show(false);
    else btn.style.display = 'block';
  }, 400);

  window.addEventListener('resize', () => { if (visible) overlay.style.top = headerBottom(); });
  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 't' || e.key === 'T') && isPerf()) { visible ? hide(true) : show(true); e.preventDefault(); }
  }, true);

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(btn);
  chrome.storage.local.get('autoReplace', r => {
    auto = r.autoReplace !== false;
    if (!isPerf()) return;
    // wait for GSC to render its chart once, so the bridge has the report's request to replay
    if (auto) setTimeout(() => show(false), 1200); else btn.style.display = 'block';
  });
})();
