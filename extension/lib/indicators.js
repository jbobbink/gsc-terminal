/* GSC Terminal: data shaping + technical indicators. Pure functions, no DOM. */
(function (root) {
  'use strict';

  const DAY = 86400;

  // ---- time helpers (all times are UTC epoch seconds) ----
  function dateToTs(yyyyMmDd) {
    const [y, m, d] = yyyyMmDd.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 1000;
  }
  function tsToDate(ts) {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
  // Hourly keys come back as ISO with offset (Pacific). Shift to browser-local wall clock,
  // because the chart renders timestamps as if they were UTC.
  function hourKeyToTs(key, tzOffsetMin) {
    const epoch = Date.parse(key) / 1000;
    const off = tzOffsetMin != null ? tzOffsetMin : -new Date(epoch * 1000).getTimezoneOffset();
    return epoch + off * 60;
  }
  function bucketStart(ts, tf) {
    switch (tf) {
      case 'H': return ts - (ts % 3600);
      case '4H': return ts - (ts % (4 * 3600));
      case 'D': return ts - (ts % DAY);
      case 'W': {
        const dayStart = ts - (ts % DAY);
        const dow = (new Date(dayStart * 1000).getUTCDay() + 6) % 7; // Mon=0
        return dayStart - dow * DAY;
      }
      case 'M': {
        const d = new Date(ts * 1000);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
      }
      default: throw new Error('unknown timeframe ' + tf);
    }
  }

  // ---- metric helpers ----
  function rowValue(r, metric) {
    switch (metric) {
      case 'clicks': return r.clicks;
      case 'impressions': return r.impressions;
      case 'ctr': return r.impressions ? (r.clicks / r.impressions) * 100 : 0;
      case 'position': return r.position;
    }
  }
  function aggValue(rows, metric) {
    let c = 0, i = 0, pw = 0;
    for (const r of rows) { c += r.clicks; i += r.impressions; pw += r.position * r.impressions; }
    switch (metric) {
      case 'clicks': return c / rows.length;        // average per base period (day or hour)
      case 'impressions': return i / rows.length;
      case 'ctr': return i ? (c / i) * 100 : 0;
      case 'position': return i ? pw / i : avg(rows.map(r => r.position));
    }
  }
  function avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }

  /**
   * rows: [{ t, clicks, impressions, position, partial? }] sorted by t (base granularity: day or hour)
   * Candle semantics (for any timeframe):
   *   close = bucket value (avg per day/hour for volume metrics, weighted for ctr/position)
   *   open  = previous bucket close (so the body is period-over-period change)
   *   high/low = most extreme single day/hour in the bucket (wicks = intra-period volatility)
   *   volume = summed impressions (or clicks when the metric is impressions)
   */
  function toCandles(rows, tf, metric, volumeKey) {
    const vKey = volumeKey || (metric === 'impressions' ? 'clicks' : 'impressions');
    const groups = new Map();
    for (const r of rows) {
      const k = bucketStart(r.t, tf);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const keys = [...groups.keys()].sort((a, b) => a - b);
    // Expected base periods per bucket: a week or month with fewer days (first/last bucket) is incomplete.
    const expected = k => {
      if (tf === 'W') return 7;
      if (tf === 'M') { const d = new Date(k * 1000); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); }
      if (tf === '4H') return 4;
      return 1;
    };
    const out = [];
    let prevClose = null;
    for (const k of keys) {
      const g = groups.get(k);
      const vals = g.map(r => rowValue(r, metric));
      const close = aggValue(g, metric);
      const open = prevClose == null ? vals[0] : prevClose;
      const high = Math.max(open, close, ...vals);
      const low = Math.min(open, close, ...vals);
      const volume = g.reduce((s, r) => s + r[vKey], 0);
      const clicks = g.reduce((s, r) => s + r.clicks, 0);
      const impressions = g.reduce((s, r) => s + r.impressions, 0);
      out.push({ time: k, open, high, low, close, volume, clicks, impressions, n: g.length,
        partial: g.some(r => r.partial) || ((k === keys[0] || k === keys[keys.length - 1]) && g.length < expected(k)) });
      prevClose = close;
    }
    return out;
  }

  function heikinAshi(c) {
    const out = [];
    for (let i = 0; i < c.length; i++) {
      const x = c[i];
      const close = (x.open + x.high + x.low + x.close) / 4;
      const open = i === 0 ? (x.open + x.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
      out.push(Object.assign({}, x, { open, close,
        high: Math.max(x.high, open, close), low: Math.min(x.low, open, close) }));
    }
    return out;
  }

  // ---- indicators (input: number[], output: (number|null)[] aligned) ----
  function sma(v, n) {
    const out = new Array(v.length).fill(null);
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i];
      if (i >= n) s -= v[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }
  function ema(v, n) {
    const out = new Array(v.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < v.length; i++) {
      if (i === n - 1) prev = avg(v.slice(0, n));
      else if (i >= n) prev = v[i] * k + prev * (1 - k);
      if (i >= n - 1) out[i] = prev;
    }
    return out;
  }
  function bollinger(v, n, k) {
    const mid = sma(v, n), up = [], lo = [];
    for (let i = 0; i < v.length; i++) {
      if (mid[i] == null) { up.push(null); lo.push(null); continue; }
      let ss = 0;
      for (let j = i - n + 1; j <= i; j++) ss += (v[j] - mid[i]) ** 2;
      const sd = Math.sqrt(ss / n);
      up.push(mid[i] + k * sd); lo.push(mid[i] - k * sd);
    }
    return { mid, up, lo };
  }
  // Wilder RSI
  function rsi(v, n) {
    const out = new Array(v.length).fill(null);
    if (v.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  // indices where fast crosses slow: +1 = cross up, -1 = cross down
  function crosses(fast, slow) {
    const out = [];
    for (let i = 1; i < fast.length; i++) {
      if ([fast[i], slow[i], fast[i - 1], slow[i - 1]].some(x => x == null)) continue;
      const a = fast[i - 1] - slow[i - 1], b = fast[i] - slow[i];
      if (a <= 0 && b > 0) out.push({ i, dir: 1 });
      else if (a >= 0 && b < 0) out.push({ i, dir: -1 });
    }
    return out;
  }

  // Year-over-year series aligned to candle times. D/W/H shift 364 days (same weekday), M shifts 12 months.
  function yoy(candles, tf) {
    const byTime = new Map(candles.map(c => [c.time, c.close]));
    const out = [];
    for (const c of candles) {
      let prior;
      if (tf === 'M') {
        const d = new Date(c.time * 1000);
        prior = Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1) / 1000;
      } else prior = c.time - 364 * DAY;
      if (byTime.has(prior)) out.push({ time: c.time, value: byTime.get(prior) });
    }
    return out;
  }

  // Parse GSC UI export ("Dates.csv" / "Chart.csv"): Date,Clicks,Impressions,CTR,Position
  function parseGscCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const head = splitCsv(lines[0]).map(h => h.trim().toLowerCase());
    const idx = name => head.findIndex(h => h === name || h.startsWith(name));
    const iD = idx('date'), iC = idx('clicks'), iI = idx('impressions'), iP = idx('position');
    if (iD < 0 || iC < 0 || iI < 0) throw new Error('CSV needs Date, Clicks, Impressions (and ideally Position) columns');
    const num = s => Number(String(s).replace(/[%\s]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
    const rows = [];
    for (const line of lines.slice(1)) {
      const f = splitCsv(line);
      if (!/^\d{4}-\d{2}-\d{2}/.test(f[iD] || '')) continue;
      rows.push({ t: dateToTs(f[iD].slice(0, 10)), clicks: num(f[iC]), impressions: num(f[iI]),
        position: iP >= 0 ? num(f[iP]) : 0 });
    }
    return rows.sort((a, b) => a.t - b.t);
  }
  function splitCsv(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  const api = { DAY, dateToTs, tsToDate, hourKeyToTs, bucketStart, rowValue, toCandles, heikinAshi,
    sma, ema, bollinger, rsi, crosses, yoy, parseGscCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GscInd = api;
})(typeof self !== 'undefined' ? self : this);
