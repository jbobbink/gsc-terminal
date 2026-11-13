/* GSC Terminal: chart page controller. */
(() => {
  'use strict';
  const LC = window.LightweightCharts;
  const I = window.GscInd;
  const $ = s => document.querySelector(s);
  const hasChrome = !!(window.chrome && chrome.runtime && chrome.runtime.id);

  // ---------- persistent state ----------
  const DEFAULTS = {
    site: '', metric: 'clicks', tf: 'W', type: 'candles', months: 16,
    // MA periods per timeframe; daily/hourly use multiples of the weekly/daily cycle so seasonality cancels out
    ma: { H: [24, 168], '4H': [6, 42], D: [7, 28], W: [4, 13], M: [3, 12] },
    ind: { vol: true, sma: true, bb: false, rsi: false, yoy: false, sig: true, ev: true },
    filters: { query: '', queryOp: 'contains', page: '', pageOp: 'contains', country: '', device: '', searchType: 'web' },
  };
  const store = {
    async get(k, d) {
      if (hasChrome && chrome.storage) { const r = await chrome.storage.local.get(k); return r[k] !== undefined ? r[k] : d; }
      try { const v = JSON.parse(localStorage.getItem(k)); return v != null ? v : d; } catch { return d; }
    },
    async set(k, v) {
      if (hasChrome && chrome.storage) return chrome.storage.local.set({ [k]: v });
      try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    },
  };
  let S = structuredClone(DEFAULTS);
  const save = () => store.set('state', S);

  // ---------- data ----------
  const PARAMS = new URLSearchParams(location.search);
  const EMBED = PARAMS.get('embed') === '1';
  let source = EMBED ? 'page' : 'api';   // 'page' (inside Search Console) | 'api' | 'csv' | 'demo'
  let local = { name: '', daily: null, hourly: null };
  let page = { site: PARAMS.get('site') || '', report: 'SEARCH', filters: '', metrics: null, lastUpdate: null, nonce: 0 };
  const cache = new Map();
  let candles = [], events = [], firstIncomplete = null, rowsNotes = [];
  let chart = null, mainSeries = null, lastView = null;

  const isHourlyTf = tf => tf === 'H' || tf === '4H';
  const symbolKey = () => source === 'api' ? S.site : source === 'page' ? page.site : source + ':' + local.name;

  // Ask the Search Console page (bridge in the parent frame) for the current report's series.
  let reqId = 0;
  const pending = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window.parent || !e.data) return;
    if (e.data.type === 'gscterm:data' && pending.has(e.data.id)) {
      const { resolve, reject, timer } = pending.get(e.data.id);
      clearTimeout(timer); pending.delete(e.data.id);
      e.data.ok ? resolve(e.data.data) : reject(new Error(e.data.error));
    }
    if (e.data.type === 'gscterm:reload') {
      if (e.data.site) page.site = e.data.site;
      source = 'page'; page.nonce++; syncUi(); load();
    }
  });
  function bridge(months) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Search Console page did not answer. Reload the GSC tab.')); }, 30000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ type: 'gscterm:fetch', id, months }, 'https://search.google.com');
    });
  }

  async function getRows() {
    const hourly = isHourlyTf(S.tf);
    if (source === 'page') {
      if (hourly) throw new Error('Hourly bars are only available in API mode (toolbar icon → standalone tab). Use 1D/1W/1M here.');
      const key = JSON.stringify(['page', page.site, page.nonce, S.months]);
      if (!cache.has(key)) cache.set(key, bridge(S.months).then(d => {
        Object.assign(page, { site: d.site, report: d.report, filters: d.filters, metrics: d.metrics, lastUpdate: d.lastUpdate });
        if (d.properties && d.properties.length) fillProps(d.properties);
        return { rows: d.rows, firstIncomplete: null };
      }).catch(e => { cache.delete(key); throw e; }));
      const res = await cache.get(key);
      syncMetrics();
      return res;
    }
    if (source !== 'api') {
      const rows = hourly ? local.hourly : local.daily;
      if (!rows) throw new Error('No hourly data for ' + (source === 'csv' ? 'CSV imports' : 'this source') + '. Use 1D/1W/1M.');
      return { rows, firstIncomplete: null };
    }
    if (!S.site) throw new Error('Pick a property');
    const key = JSON.stringify([S.site, hourly, hourly ? 0 : S.months, S.filters]);
    if (!cache.has(key)) {
      cache.set(key, Gsc.fetchSeries(S.site, { granularity: hourly ? 'hour' : 'day', months: S.months, filters: S.filters })
        .catch(e => { cache.delete(key); throw e; }));
    }
    return cache.get(key);
  }

  async function load() {
    status(null);
    try {
      setBusy(true);
      const res = await getRows();
      firstIncomplete = res.firstIncomplete;
      if (!res.rows.length) throw new Error('No rows returned for this property / filter combination.');
      const noClicks = source === 'page' && page.metrics && !page.metrics.includes('clicks');
      candles = I.toCandles(res.rows, S.tf, S.metric, noClicks ? 'impressions' : undefined);
      rowsNotes = res.rows.filter(r => r.note).map(r => r.t);
      events = await store.get('events:' + symbolKey(), []);
      render();
    } catch (e) {
      status('<h2>Could not load data</h2><p>' + esc(e.message) + '</p>', [['Retry', load]]);
    } finally { setBusy(false); }
  }

  // ---------- formatting ----------
  const compact = v => {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 1 : 2) + 'K';
    return a >= 100 ? v.toFixed(0) : v.toFixed(1);
  };
  const fmt = v => v == null || isNaN(v) ? '–' :
    S.metric === 'ctr' ? v.toFixed(2) + '%' : S.metric === 'position' ? v.toFixed(2) : compact(v);
  const pct = (a, b) => b ? ((a - b) / Math.abs(b)) * 100 : 0;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tfLabel = { H: '1H', '4H': '4H', D: '1D', W: '1W', M: '1M' };
  const metricLabel = { clicks: 'CLICKS', impressions: 'IMPR', ctr: 'CTR', position: 'POS' };
  const unitNote = () => (S.metric === 'clicks' || S.metric === 'impressions') && !['D', 'H'].includes(S.tf)
    ? (isHourlyTf(S.tf) ? 'avg/hour' : 'avg/day') : '';
  const timeStr = t => {
    const d = new Date(t * 1000).toISOString();
    return isHourlyTf(S.tf) ? d.slice(0, 16).replace('T', ' ') : d.slice(0, 10);
  };

  // "good" direction: lower is better for position
  const better = (a, b) => S.metric === 'position' ? a < b : a > b;
  const UP = '#26a69a', DOWN = '#ef5350', GREY = '#787b86';

  // ---------- rendering ----------
  function render() {
    const el = $('#chart');
    const sameView = lastView && lastView.tf === S.tf && lastView.sym === symbolKey() && lastView.n === candles.length && lastView.t0 === (candles[0] && candles[0].time) && chart;
    const keepRange = sameView ? chart.timeScale().getVisibleLogicalRange() : null;
    if (chart) chart.remove();

    chart = LC.createChart(el, {
      autoSize: true,
      layout: { background: { color: '#131722' }, textColor: '#d1d4dc', fontSize: 13,
        panes: { separatorColor: '#2a2e39' } },
      grid: { vertLines: { color: '#1f2430' }, horzLines: { color: '#1f2430' } },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: { borderColor: '#2a2e39', timeVisible: isHourlyTf(S.tf), secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: LC.CrosshairMode.Normal },
    });

    const data = S.type === 'ha' ? I.heikinAshi(candles) : candles;
    const closes = candles.map(c => c.close);
    const pf = { priceFormat: { type: 'custom', formatter: fmt, minMove: 0.01 } };
    const upC = S.metric === 'position' ? DOWN : UP, downC = S.metric === 'position' ? UP : DOWN;

    if (S.type === 'candles' || S.type === 'ha') {
      mainSeries = chart.addSeries(LC.CandlestickSeries, { upColor: upC, downColor: downC, borderUpColor: upC,
        borderDownColor: downC, wickUpColor: upC, wickDownColor: downC, ...pf });
      mainSeries.setData(data.map(c => {
        const p = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
        if (c.partial) Object.assign(p, { color: 'rgba(120,123,134,.25)', borderColor: GREY, wickColor: GREY });
        return p;
      }));
    } else if (S.type === 'line') {
      mainSeries = chart.addSeries(LC.LineSeries, { color: '#2962ff', lineWidth: 2, ...pf });
      mainSeries.setData(data.map(c => ({ time: c.time, value: c.close, ...(c.partial ? { color: GREY } : {}) })));
    } else {
      mainSeries = chart.addSeries(LC.AreaSeries, { lineColor: '#2962ff', topColor: 'rgba(41,98,255,.35)', bottomColor: 'rgba(41,98,255,0)', lineWidth: 2, ...pf });
      mainSeries.setData(data.map(c => ({ time: c.time, value: c.close })));
    }

    const lineOpts = (color, extra) => Object.assign({ color, lineWidth: 1, priceLineVisible: false,
      lastValueVisible: false, crosshairMarkerVisible: false }, extra);
    const toLine = arr => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
    const ind = {};
    let pane = 0;
    const [maFast, maSlow] = S.ma[S.tf];

    if (S.ind.vol) {
      const vol = chart.addSeries(LC.HistogramSeries, { priceFormat: { type: 'volume' },
        lastValueVisible: false, priceLineVisible: false }, ++pane);
      vol.setData(candles.map(c => ({ time: c.time, value: c.volume,
        color: c.partial ? 'rgba(120,123,134,.35)' : (better(c.close, c.open) ? 'rgba(38,166,154,.35)' : 'rgba(239,83,80,.35)') })));
    }
    if (S.ind.bb) {
      const bb = I.bollinger(closes, 20, 2);
      chart.addSeries(LC.LineSeries, lineOpts('rgba(156,39,176,.8)')).setData(toLine(bb.up));
      chart.addSeries(LC.LineSeries, lineOpts('rgba(156,39,176,.5)', { lineStyle: LC.LineStyle.Dotted })).setData(toLine(bb.mid));
      chart.addSeries(LC.LineSeries, lineOpts('rgba(156,39,176,.8)')).setData(toLine(bb.lo));
      ind.bb = bb;
    }
    let fast = null, slow = null;
    if (S.ind.sma || S.ind.sig) { fast = I.sma(closes, maFast); slow = I.sma(closes, maSlow); }
    if (S.ind.sma) {
      chart.addSeries(LC.LineSeries, lineOpts('#f7c948', { lineWidth: 1.5 })).setData(toLine(fast));
      chart.addSeries(LC.LineSeries, lineOpts('#2196f3', { lineWidth: 1.5 })).setData(toLine(slow));
      ind.fast = fast; ind.slow = slow;
    }
    if (S.ind.yoy) {
      const y = I.yoy(candles, S.tf);
      if (y.length) chart.addSeries(LC.LineSeries, lineOpts('#ff9800', { lineStyle: LC.LineStyle.Dashed, lineWidth: 1.5 })).setData(y);
      ind.yoy = new Map(y.map(p => [p.time, p.value]));
    }
    if (S.ind.rsi) {
      const r = I.rsi(closes, 14);
      const rs = chart.addSeries(LC.LineSeries, lineOpts('#7e57c2', { lastValueVisible: true, priceFormat: { type: 'custom', formatter: v => v.toFixed(0) } }), ++pane);
      rs.setData(toLine(r));
      rs.createPriceLine({ price: 70, color: '#555', lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      rs.createPriceLine({ price: 30, color: '#555', lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      ind.rsi = r;
    }

    // main pane only: position is inverted so "up" always means better
    mainSeries.priceScale().applyOptions({ invertScale: S.metric === 'position', scaleMargins: { top: 0.14, bottom: 0.06 } });
    const panes = chart.panes();
    if (panes.length > 1) { panes[0].setStretchFactor(1); for (let k = 1; k < panes.length; k++) panes[k].setStretchFactor(0.2); }

    // markers: MA crossovers + user events
    const markers = [];
    if (S.ind.sig && fast) {
      for (const x of I.crosses(fast, slow)) {
        const good = S.metric === 'position' ? x.dir < 0 : x.dir > 0;
        markers.push({ time: candles[x.i].time, position: good ? 'belowBar' : 'aboveBar',
          shape: good ? 'arrowUp' : 'arrowDown', color: good ? UP : DOWN, text: good ? 'GX' : 'DX' });
      }
    }
    if (S.ind.ev) {
      const times = new Set(candles.map(c => c.time));
      for (const e of events) {
        const t = I.bucketStart(I.dateToTs(e.date), S.tf);
        if (times.has(t)) markers.push({ time: t, position: 'aboveBar', shape: 'square', color: '#e0e3eb', text: e.label, size: 0.6 });
      }
    }
    if (rowsNotes.length && S.ind.ev) {
      const times = new Set(candles.map(c => c.time));
      for (const t of rowsNotes) {
        const b = I.bucketStart(t, S.tf);
        if (times.has(b)) markers.push({ time: b, position: 'belowBar', shape: 'circle', color: '#787b86', text: 'GSC note', size: 0.5 });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    if (markers.length) LC.createSeriesMarkers(mainSeries, markers);

    if (keepRange) chart.timeScale().setVisibleLogicalRange(keepRange);
    else chart.timeScale().fitContent();
    lastView = { tf: S.tf, sym: symbolKey(), n: candles.length, t0: candles[0] && candles[0].time };

    chart.subscribeCrosshairMove(p => legend(p && p.time != null ? candles.findIndex(c => c.time === p.time) : -1, ind));
    chart.subscribeDblClick(p => { if (p && p.time != null) addEvent(p.time); });
    legend(-1, ind);
    stats();
  }

  function legend(i, ind) {
    if (i < 0) { i = candles.length - 1; while (i > 0 && candles[i].partial) i--; }
    const c = candles[i]; if (!c) return;
    const ch = pct(c.close, c.open), cls = better(c.close, c.open) ? 'up' : c.close === c.open ? '' : 'down';
    const site = source === 'api' ? Gsc.label(S.site) : source === 'page' ? Gsc.label(page.site) + (page.report !== 'SEARCH' ? ' · ' + page.report : '') : local.name;
    const f = S.filters, fl = source === 'page' ? page.filters : source !== 'api' ? '' : [f.query && 'q:' + f.query, f.page && 'p:' + f.page, f.country, f.device, f.searchType !== 'web' && f.searchType].filter(Boolean).join(' · ');
    const extra = [];
    if (ind.fast && ind.fast[i] != null) extra.push(`<span class="k">MA${S.ma[S.tf][0]}</span> <span style="color:#f7c948">${fmt(ind.fast[i])}</span>`);
    if (ind.slow && ind.slow[i] != null) extra.push(`<span class="k">MA${S.ma[S.tf][1]}</span> <span style="color:#2196f3">${fmt(ind.slow[i])}</span>`);
    if (ind.bb && ind.bb.mid[i] != null) extra.push(`<span class="k">BB</span> <span style="color:#ab47bc">${fmt(ind.bb.lo[i])} – ${fmt(ind.bb.up[i])}</span>`);
    if (ind.yoy && ind.yoy.has(c.time)) { const y = ind.yoy.get(c.time); extra.push(`<span class="k">YoY</span> <span style="color:#ff9800">${fmt(y)} (${pct(c.close, y) >= 0 ? '+' : ''}${pct(c.close, y).toFixed(1)}%)</span>`); }
    if (ind.rsi && ind.rsi[i] != null) extra.push(`<span class="k">RSI</span> <span style="color:#7e57c2">${ind.rsi[i].toFixed(0)}</span>`);
    $('#legend').innerHTML =
      `<div class="sym">${esc(site.toUpperCase())} <small>· ${metricLabel[S.metric]} · ${tfLabel[S.tf]}${unitNote() ? ' · ' + unitNote() : ''}${fl ? ' · ' + esc(fl) : ''}</small></div>
       <div class="row"><span class="k">${timeStr(c.time)}</span>
         <span class="k">O</span> <span class="${cls}">${fmt(c.open)}</span>
         <span class="k">H</span> <span class="${cls}">${fmt(c.high)}</span>
         <span class="k">L</span> <span class="${cls}">${fmt(c.low)}</span>
         <span class="k">C</span> <span class="${cls}">${fmt(c.close)}</span>
         <span class="${cls}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span>
         <span class="k">Vol</span> ${compact(c.volume)}${c.partial ? ' <span class="muted">· partial</span>' : ''}</div>
       ${extra.length ? `<div class="row">${extra.join(' ')}</div>` : ''}`;
  }

  const hasClicks = () => !(source === 'page' && page.metrics && !page.metrics.includes('clicks'));
  function stats() {
    const done = candles.filter(c => !c.partial);
    const last = candles[candles.length - 1], prev = done[done.length - 2] || candles[0];
    const lastDone = done[done.length - 1] || last;
    const clicks = candles.reduce((s, c) => s + c.clicks, 0), impr = candles.reduce((s, c) => s + c.impressions, 0);
    const hi = Math.max(...candles.map(c => c.close)), lo = Math.min(...candles.map(c => c.close));
    const ch = pct(lastDone.close, prev.close);
    $('#statsbar').innerHTML = [
      `Last complete <b>${fmt(lastDone.close)}</b> <span class="${better(lastDone.close, prev.close) ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</span>`,
      `Range high <b>${fmt(S.metric === 'position' ? lo : hi)}</b> low <b>${fmt(S.metric === 'position' ? hi : lo)}</b>`,
      hasClicks() ? `Clicks <b>${compact(clicks)}</b>` : '', `Impr <b>${compact(impr)}</b>`,
      hasClicks() ? `CTR <b>${impr ? (clicks / impr * 100).toFixed(2) : 0}%</b>` : '',
      `${candles.length} bars`,
      firstIncomplete ? `Incomplete from <b>${esc(firstIncomplete.slice(0, 16).replace('T', ' '))}</b>` : '',
      source === 'demo' ? '<span style="color:#ff9800">DEMO DATA</span>' : '',
      source === 'page' && page.lastUpdate ? `GSC updated <b>${new Date(page.lastUpdate).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</b>` : '',
    ].filter(Boolean).join('');
  }

  // ---------- events ----------
  async function addEvent(time) {
    const date = I.tsToDate(time);
    const label = prompt('Event label for ' + date + ' (e.g. "Core update", "Migration")');
    if (!label) return;
    events.push({ date, label: label.slice(0, 24) });
    events.sort((a, b) => a.date.localeCompare(b.date));
    await store.set('events:' + symbolKey(), events);
    S.ind.ev = true; syncUi(); save();
    render(); renderEvents();
  }
  function renderEvents() {
    $('#eventList').innerHTML = events.length ? events.map((e, i) =>
      `<li><span>${e.date}</span><span>${esc(e.label)}</span><button data-i="${i}" title="Delete">✕</button></li>`).join('')
      : '<li class="muted">No events yet</li>';
  }
  $('#eventList').addEventListener('click', async e => {
    const i = e.target.dataset.i; if (i == null) return;
    events.splice(+i, 1);
    await store.set('events:' + symbolKey(), events);
    renderEvents(); render();
  });

  // ---------- UI wiring ----------
  function syncUi() {
    for (const [id, key] of [['#metric', 'metric'], ['#tf', 'tf'], ['#type', 'type']]) {
      document.querySelectorAll(id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === S[key]));
    }
    document.querySelectorAll('#ind button').forEach(b => b.classList.toggle('on', !!S.ind[b.dataset.v]));
    document.querySelectorAll('#tf button').forEach(b => { b.disabled = (source === 'csv' || source === 'page') && isHourlyTf(b.dataset.v); });
    $('#filtersBtn').hidden = source === 'page';
    $('#backToGsc').hidden = !EMBED;
    $('#months').value = String(S.months);
    for (const k of Object.keys(DEFAULTS.filters)) $('#' + k).value = S.filters[k];
    $('#maFast').value = S.ma[S.tf][0]; $('#maSlow').value = S.ma[S.tf][1];
    $('#filtersBtn').classList.toggle('on', !!(S.filters.query || S.filters.page || S.filters.country || S.filters.device || S.filters.searchType !== 'web'));
  }
  function bindSeg(id, key, reload) {
    $(id).addEventListener('click', e => {
      const v = e.target.closest('button')?.dataset.v; if (!v || S[key] === v) return;
      S[key] = v; save(); syncUi();
      reload ? load() : render();
    });
  }
  bindSeg('#metric', 'metric', true);
  bindSeg('#tf', 'tf', true);
  bindSeg('#type', 'type', false);
  $('#ind').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    S.ind[v] = !S.ind[v]; save(); syncUi(); if (candles.length) render();
  });
  $('#months').addEventListener('change', e => { S.months = +e.target.value; save(); load(); });
  $('#site').addEventListener('change', e => {
    if (source === 'page') return window.parent.postMessage({ type: 'gscterm:navigate', site: e.target.value }, 'https://search.google.com');
    S.site = e.target.value; source = 'api'; save(); syncUi(); load();
  });
  $('#backToGsc').addEventListener('click', () => window.parent.postMessage({ type: 'gscterm:hide' }, 'https://search.google.com'));
  document.addEventListener('keydown', e => {
    if (EMBED && e.altKey && (e.key === 't' || e.key === 'T' || e.code === 'KeyT')) { e.preventDefault(); window.parent.postMessage({ type: 'gscterm:hide' }, 'https://search.google.com'); }
  });

  // CTR is derived from clicks/impressions, so it needs both; position needs position.
  function metricAvailable(m) {
    const a = page.metrics || ['clicks', 'impressions', 'ctr', 'position'];
    return m === 'ctr' ? a.includes('clicks') && a.includes('impressions') : a.includes(m);
  }
  function syncMetrics() {
    if (source !== 'page') { document.querySelectorAll('#metric button').forEach(b => { b.disabled = false; b.title = ''; }); return; }
    document.querySelectorAll('#metric button').forEach(b => {
      b.disabled = !metricAvailable(b.dataset.v);
      b.title = b.disabled ? 'Not available in this Search Console report' : '';
    });
    if (!metricAvailable(S.metric)) { S.metric = page.metrics.includes('impressions') ? 'impressions' : page.metrics[0]; syncUi(); }
  }
  function fillProps(props) {
    const sel = $('#site');
    if (sel.dataset.filled === page.site) return;
    sel.textContent = '';
    for (const p of props) { const o = document.createElement('option'); o.value = p.site; o.textContent = p.label + (p.site.startsWith('sc-domain:') ? ' (domain)' : ''); sel.append(o); }
    if (!props.some(p => p.site === page.site)) { const o = document.createElement('option'); o.value = page.site; o.textContent = Gsc.label(page.site); sel.prepend(o); }
    sel.value = page.site; sel.dataset.filled = page.site;
  }
  $('#refresh').addEventListener('click', () => { cache.clear(); load(); });
  $('#filtersBtn').addEventListener('click', () => { $('#filters').hidden = !$('#filters').hidden; $('#menu').hidden = true; });
  $('#more').addEventListener('click', () => { $('#menu').hidden = !$('#menu').hidden; $('#filters').hidden = true; });
  $('#applyFilters').addEventListener('click', () => {
    for (const k of Object.keys(DEFAULTS.filters)) S.filters[k] = $('#' + k).value.trim();
    const f = Math.max(2, +$('#maFast').value || DEFAULTS.ma[S.tf][0]);
    S.ma[S.tf] = [f, Math.max(f + 1, +$('#maSlow').value || DEFAULTS.ma[S.tf][1])];
    save(); syncUi(); load();
  });
  $('#clearFilters').addEventListener('click', () => { S.filters = structuredClone(DEFAULTS.filters); save(); syncUi(); load(); });
  $('#importCsv').addEventListener('click', () => $('#csvFile').click());
  $('#csvFile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const rows = I.parseGscCsv(await file.text());
      if (!rows.length) throw new Error('No dated rows found. Export the "Dates" tab from the GSC performance report.');
      source = 'csv'; local = { name: file.name.replace(/\.csv$/i, ''), daily: rows, hourly: null };
      if (isHourlyTf(S.tf)) S.tf = 'D';
      $('#menu').hidden = true; syncUi(); load();
    } catch (err) { status('<h2>CSV import failed</h2><p>' + esc(err.message) + '</p>', [['OK', () => status(null)]]); }
    e.target.value = '';
  });
  $('#exportCsv').addEventListener('click', () => {
    const head = 'time,open,high,low,close,volume,clicks,impressions,partial';
    const body = candles.map(c => [timeStr(c.time), c.open, c.high, c.low, c.close, c.volume, c.clicks, c.impressions, c.partial ? 1 : 0].join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([head + '\n' + body.join('\n')], { type: 'text/csv' }));
    a.download = `${(source === 'api' ? Gsc.label(S.site) : local.name).replace(/[^\w.-]+/g, '_')}_${S.metric}_${S.tf}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#demo').addEventListener('click', () => { loadDemo(); $('#menu').hidden = true; });
  $('#eventsBtn').addEventListener('click', () => { renderEvents(); $('#events').hidden = !$('#events').hidden; $('#menu').hidden = true; });
  $('#connect').addEventListener('click', () => connect(true));

  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const tfKeys = { 1: 'D', 2: 'W', 3: 'M' };
    const mKeys = { c: 'clicks', i: 'impressions', r: 'ctr', p: 'position' };
    if (tfKeys[e.key] && !((source === 'csv' || source === 'page') && isHourlyTf(tfKeys[e.key]))) { S.tf = tfKeys[e.key]; save(); syncUi(); load(); }
    else if (mKeys[e.key] && !(page.metrics && source === 'page' && !metricAvailable(mKeys[e.key]))) { S.metric = mKeys[e.key]; save(); syncUi(); load(); }
  });

  function setBusy(b) { document.body.style.cursor = b ? 'progress' : ''; $('#refresh').disabled = b; }
  function status(html, actions) {
    const el = $('#status');
    if (!html) { el.hidden = true; return; }
    el.innerHTML = '<div>' + html + '<div class="actions"></div></div>';
    for (const [label, fn] of actions || []) {
      const b = document.createElement('button'); b.textContent = label; b.onclick = fn; el.querySelector('.actions').append(b);
    }
    el.hidden = false;
  }

  // ---------- demo data ----------
  function loadDemo() {
    let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const today = I.dateToTs(new Date().toISOString().slice(0, 10));
    const daily = [];
    for (let d = 486; d >= 1; d--) {
      const t = today - d * I.DAY, dow = new Date(t * 1000).getUTCDay();
      const trend = 900 * Math.pow(1.0018, 486 - d);
      const update = d < 160 && d > 120 ? 0.72 + (160 - d) * 0.002 : 1;      // simulated core-update hit
      const season = dow === 0 || dow === 6 ? 0.68 : 1;
      const impressions = Math.round(trend * 33 * season * update * (0.92 + rnd() * 0.16));
      const position = Math.max(1, 9.5 - (486 - d) * 0.006 + (update < 1 ? 1.4 : 0) + (rnd() - 0.5) * 0.6);
      const ctr = 0.042 * Math.pow(6 / position, 0.6);
      daily.push({ t, impressions, clicks: Math.round(impressions * ctr * (0.9 + rnd() * 0.2)), position, partial: d <= 2 });
    }
    const hourly = [];
    const nowH = Math.floor(Date.now() / 3600000) * 3600 - 3 * 3600;
    for (let h = 240; h >= 0; h--) {
      const t = nowH - h * 3600, hr = new Date(t * 1000).getUTCHours();
      const diurnal = 0.35 + 0.65 * Math.max(0, Math.sin(((hr - 5) / 24) * 2 * Math.PI) * 0.5 + 0.5);
      const impressions = Math.round(2600 * diurnal * (0.85 + rnd() * 0.3));
      const position = 7 + (rnd() - 0.5);
      hourly.push({ t, impressions, clicks: Math.round(impressions * 0.05 * (0.85 + rnd() * 0.3)), position, partial: h < 6 });
    }
    source = 'demo'; local = { name: 'demo-site.com', daily, hourly };
    syncUi(); load();
  }

  // ---------- boot ----------
  async function connect(interactive) {
    try {
      await Gsc.getToken(interactive);
      $('#connect').hidden = true;
      const sites = await Gsc.listSites();
      $('#site').innerHTML = sites.map(s => `<option value="${esc(s)}">${esc(Gsc.label(s))}${s.startsWith('sc-domain:') ? ' (domain)' : ''}</option>`).join('');
      const want = new URLSearchParams(location.search).get('site');
      if (want && sites.includes(want)) S.site = want;
      else if (want) { const m = sites.find(s => Gsc.label(s) === Gsc.label(want)); if (m) S.site = m; }
      if (!sites.includes(S.site)) S.site = sites[0] || '';
      $('#site').value = S.site; source = 'api'; save(); syncUi();
      if (!sites.length) return status('<h2>No verified properties</h2><p>This Google account has no Search Console properties with access.</p>', [['Load demo data', loadDemo]]);
      load();
      return true;
    } catch (e) {
      $('#connect').hidden = false;
      if (interactive) status('<h2>Sign-in failed</h2><p>' + esc(e.message) + '</p>', [['Try again', () => connect(true)], ['Import CSV', () => $('#csvFile').click()], ['Load demo data', loadDemo]]);
      return false;
    }
  }

  async function boot() {
    S = Object.assign(structuredClone(DEFAULTS), await store.get('state', {}));
    if (isHourlyTf(S.tf)) S.tf = 'W';
    S.ind = Object.assign({}, DEFAULTS.ind, S.ind); S.ma = Object.assign({}, DEFAULTS.ma, S.ma); S.filters = Object.assign({}, DEFAULTS.filters, S.filters);
    syncUi();
    const params = PARAMS;
    if (params.get('demo') === '1') return loadDemo();
    if (EMBED) {
      $('#connect').hidden = true;
      const o = document.createElement('option'); o.value = page.site; o.textContent = Gsc.label(page.site); $('#site').append(o);
      if (isHourlyTf(S.tf)) S.tf = 'W';
      syncUi();
      return load();
    }

    const manifest = hasChrome ? chrome.runtime.getManifest() : {};
    const clientId = manifest.oauth2 && manifest.oauth2.client_id || '';
    if (!hasChrome || !chrome.identity || /YOUR_CLIENT_ID/.test(clientId)) {
      $('#site').innerHTML = '<option>API not configured</option>';
      return status(`<h2>Search Console API not configured yet</h2>
        <p>Add your OAuth client ID to <code>manifest.json</code> (see README) to pull data live.
        Meanwhile you can import the <b>Dates</b> CSV from a GSC performance export, or look around with demo data.</p>`,
        [['Import CSV', () => $('#csvFile').click()], ['Load demo data', loadDemo]]);
    }
    if (!(await connect(false))) {
      status('<h2>Connect Search Console</h2><p>Sign in with the Google account that has access to your properties. Read-only scope.</p>',
        [['Connect Google', () => connect(true)], ['Import CSV', () => $('#csvFile').click()], ['Load demo data', loadDemo]]);
    }
  }
  boot();
})();
