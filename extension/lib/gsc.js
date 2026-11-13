/* GSC Terminal: Search Console API client (chrome.identity OAuth). */
(function (root) {
  'use strict';
  const API = 'https://www.googleapis.com/webmasters/v3';

  function getToken(interactive) {
    return new Promise((resolve, reject) => {
      if (!(root.chrome && chrome.identity && chrome.identity.getAuthToken)) {
        return reject(new Error('chrome.identity unavailable (Chrome only; Edge/Brave need launchWebAuthFlow)'));
      }
      chrome.identity.getAuthToken({ interactive }, res => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(typeof res === 'string' ? res : res && res.token);
      });
    });
  }
  function dropToken(token) {
    return new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r));
  }

  async function call(path, body, retried) {
    const token = await getToken(true);
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) { await dropToken(token); return call(path, body, true); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status));
    return json;
  }

  async function listSites() {
    const j = await call('/sites');
    return (j.siteEntry || [])
      .filter(s => s.permissionLevel !== 'siteUnverifiedUser')
      .map(s => s.siteUrl)
      .sort((a, b) => label(a).localeCompare(label(b)));
  }
  function label(site) {
    return site.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  function iso(d) { return d.toISOString().slice(0, 10); }

  function filterGroups(f) {
    const filters = [];
    if (f.query) filters.push({ dimension: 'query', operator: f.queryOp || 'contains', expression: f.query });
    if (f.page) filters.push({ dimension: 'page', operator: f.pageOp || 'contains', expression: f.page });
    if (f.country) filters.push({ dimension: 'country', operator: 'equals', expression: f.country.toLowerCase() });
    if (f.device) filters.push({ dimension: 'device', operator: 'equals', expression: f.device });
    return filters.length ? [{ groupType: 'and', filters }] : undefined;
  }

  /**
   * Returns { rows: [{t, clicks, impressions, position, partial}], firstIncomplete }
   * granularity 'day' => up to `months` back (max 16), dataState=all (includes fresh data)
   * granularity 'hour' => last 10 days, dataState=hourly_all
   */
  async function fetchSeries(site, opts) {
    const I = root.GscInd;
    const hourly = opts.granularity === 'hour';
    const end = new Date();
    const start = new Date(end);
    if (hourly) start.setUTCDate(start.getUTCDate() - 10);
    else start.setUTCMonth(start.getUTCMonth() - Math.min(opts.months || 16, 16));
    const body = {
      startDate: iso(start), endDate: iso(end),
      dimensions: [hourly ? 'hour' : 'date'],
      dataState: hourly ? 'hourly_all' : 'all',
      type: opts.filters.searchType || 'web',
      rowLimit: 25000,
      dimensionFilterGroups: filterGroups(opts.filters),
    };
    const j = await call('/sites/' + encodeURIComponent(site) + '/searchAnalytics/query', body);
    const meta = j.metadata || {};
    const firstInc = hourly ? meta.firstIncompleteHour : meta.firstIncompleteDate;
    const incTs = firstInc ? (hourly ? I.hourKeyToTs(firstInc) : I.dateToTs(firstInc)) : Infinity;
    const rows = (j.rows || []).map(r => {
      const t = hourly ? I.hourKeyToTs(r.keys[0]) : I.dateToTs(r.keys[0]);
      return { t, clicks: r.clicks, impressions: r.impressions, position: r.position, partial: t >= incTs };
    }).sort((a, b) => a.t - b.t);
    return { rows, firstIncomplete: firstInc || null };
  }

  root.Gsc = { listSites, fetchSeries, label, getToken };
})(typeof self !== 'undefined' ? self : this);
