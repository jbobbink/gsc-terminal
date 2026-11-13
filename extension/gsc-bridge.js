/* GSC Terminal bridge. Runs in the Search Console page (MAIN world).
 * 1. Watches the page's own batchexecute traffic to learn the current time-series request
 *    (property, report type, search type and every filter set in the GSC UI).
 * 2. Replays that request with a longer date range on behalf of the terminal iframe,
 *    using the signed-in session of this /u/N account. No OAuth needed.
 * Only answers postMessage requests coming from this extension's own iframe.
 */
(() => {
  'use strict';
  if (window.__gsctermBridge) return;
  window.__gsctermBridge = true;

  const nativeFetch = window.fetch.bind(window);
  const S = { captured: null, rpcId: 'OLiH4d' };

  // A time series payload: [descriptor, [points, totals, ?, lastUpdate], ...]
  // descriptor = [siteUrl, 27, null, null, null, [[1 = date dimension], null, [range], [filters], ..., reportType]]
  function isSeries(d) {
    return Array.isArray(d) && Array.isArray(d[0]) && typeof d[0][0] === 'string' && d[0][1] === 27 &&
      Array.isArray(d[0][5]) && Array.isArray(d[0][5][0]) && d[0][5][0][0] === 1 &&
      Array.isArray(d[1]) && Array.isArray(d[1][0]) && d[1][0].length > 1 &&
      Array.isArray(d[1][0][0]) && typeof d[1][0][0][0] === 'number';
  }

  function framesFrom(text) {
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('[[')) continue;
      let arr; try { arr = JSON.parse(line); } catch { continue; }
      for (const fr of arr) {
        if (!Array.isArray(fr) || fr[0] !== 'wrb.fr' || typeof fr[2] !== 'string') continue;
        try { out.push({ rpc: fr[1], data: JSON.parse(fr[2]) }); } catch {}
      }
    }
    return out;
  }

  // Passive capture of the page's own requests (never modifies them).
  window.fetch = function (input, init) {
    const p = nativeFetch(input, init);
    try {
      const url = String(input && input.url || input);
      if (url.includes('/batchexecute')) {
        p.then(r => r.clone().text()).then(t => {
          for (const f of framesFrom(t)) if (isSeries(f.data)) { S.captured = { desc: f.data[0], at: Date.now() }; S.rpcId = f.rpc; }
        }).catch(() => {});
      }
    } catch {}
    return p;
  };

  function inlineData() {
    const out = [];
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t || !t.includes('AF_initDataCallback')) continue;
      const m = t.match(/data:([\s\S]*), sideChannel/);
      if (!m) continue;
      try { out.push(JSON.parse(m[1])); } catch {}
    }
    return out;
  }

  const currentSite = () => new URL(location.href).searchParams.get('resource_id');

  function descriptor() {
    const site = currentSite();
    if (S.captured && S.captured.desc[0] === site) return S.captured.desc;
    for (const d of inlineData()) if (isSeries(d) && d[0][0] === site) return d[0];
    return null;
  }

  function properties() {
    for (const d of inlineData()) {
      const list = Array.isArray(d) && Array.isArray(d[0]) ? d[0] : null;
      if (list && list.length && list.every(x => Array.isArray(x) && typeof x[0] === 'string' && /^(https?:\/\/|sc-domain:)/.test(x[0]))) {
        return list.map(x => ({ site: x[0], label: typeof x[5] === 'string' ? x[5] : x[0] }));
      }
    }
    return [];
  }

  async function rpc(id, args) {
    const W = window.WIZ_global_data;
    if (!W || !W.SNlM0e) throw new Error('Search Console session tokens not found on this page. Reload the page.');
    const base = (location.pathname.match(/^\/u\/\d+/) || [''])[0];
    const qs = new URLSearchParams({ rpcids: id, 'source-path': location.pathname, 'f.sid': W.FdrFJe || '', bl: W.cfb2h || '',
      hl: 'en', 'soc-app': '1', 'soc-platform': '1', 'soc-device': '1', _reqid: String(100000 + Math.floor(Math.random() * 900000)), rt: 'c' });
    const body = new URLSearchParams({ 'f.req': JSON.stringify([[[id, JSON.stringify(args), null, 'generic']]]), at: W.SNlM0e });
    const res = await nativeFetch(base + '/_/SearchConsoleAggReportUi/data/batchexecute?' + qs, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
    });
    if (!res.ok) throw new Error('Search Console returned HTTP ' + res.status);
    const frames = framesFrom(await res.text()).filter(f => f.rpc === id);
    if (!frames.length) throw new Error('Unexpected Search Console response (internal format may have changed).');
    return frames[0].data;
  }

  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);

  function metricOrder(d, len) {
    // Prefer the metric names GSC embeds in the payload; fall back to the value count.
    const names = [];
    JSON.stringify(d.slice(2), (k, v) => { if (typeof v === 'string' && /^(CLICKS|IMPRESSIONS|CTR|POSITION)$/.test(v) && !names.includes(v)) names.push(v); return v; });
    if (names.length === len) return names.map(n => n.toLowerCase());
    if (len === 4) return ['clicks', 'impressions', 'ctr', 'position'];
    if (len === 3) return ['clicks', 'impressions', 'ctr'];
    if (len === 2) return ['clicks', 'impressions'];
    return ['impressions'];
  }

  function reportName(desc) {
    const path = location.pathname;
    if (/\/ai(\/|$)/.test(path)) return 'AI';
    if (path.includes('/discover')) return 'DISCOVER';
    if (path.includes('/googlenews') || path.includes('/news')) return 'NEWS';
    const types = (desc[5][3] || []).filter(f => f && f[0] === 6).map(f => f[1] && f[1][0]).filter(Boolean);
    return types.length && types[0] !== 'WEB' ? types[0] : 'SEARCH';
  }

  function filterLabel() {
    const p = new URL(location.href).searchParams, parts = [];
    const ops = { '*': '∋', '-': '∌', '!': '=', '~': '≈' };
    for (const k of ['query', 'page', 'country', 'device', 'search_appearance']) {
      const v = p.get(k);
      if (v) parts.push(k + ' ' + (ops[v[0]] ? ops[v[0]] + ' ' + v.slice(1) : v));
    }
    return parts.join(' · ');
  }

  async function fetchSeries(months) {
    const desc = descriptor();
    if (!desc) throw new Error('Could not find this report\'s chart data on the page yet. Wait for the GSC chart to load, then press refresh.');
    const args = JSON.parse(JSON.stringify(desc));
    args[5][2] = [[null, null, null, Math.min(16, Math.max(1, months | 0))]];
    const d = await rpc(S.rpcId, args);
    if (!isSeries(d)) throw new Error('No time series returned for this view.');
    const pts = d[1][0];
    const order = metricOrder(d, (pts[0][1] || []).length);
    const rows = pts.map(p => {
      const v = p[1] || [], r = { t: Math.floor(p[0] / 86400000) * 86400, clicks: 0, impressions: 0, position: 0, partial: p[4] === 1 || p[4] === true };
      order.forEach((m, i) => { if (m !== 'ctr') r[m] = num(v[i]); });
      if (p[2]) r.note = true;
      return r;
    });
    return { rows, metrics: order, site: desc[0], report: reportName(desc), filters: filterLabel(),
      lastUpdate: typeof d[1][2] === 'number' ? d[1][2] : null, properties: properties() };
  }

  window.addEventListener('message', async e => {
    const ext = document.documentElement.dataset.gsctermExt;
    const m = e.data;
    if (!ext || e.origin !== 'chrome-extension://' + ext || !m || m.type !== 'gscterm:fetch' || !e.source) return;
    try {
      const data = await fetchSeries(m.months || 16);
      e.source.postMessage({ type: 'gscterm:data', id: m.id, ok: true, data }, e.origin);
    } catch (err) {
      e.source.postMessage({ type: 'gscterm:data', id: m.id, ok: false, error: String(err && err.message || err) }, e.origin);
    }
  });
})();
