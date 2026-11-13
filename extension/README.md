# GSC Terminal

Google Search Console performance data as TradingView-style charts: candlesticks, Heikin Ashi, moving averages, Bollinger Bands, RSI, YoY overlay, crossover signals and event markers. Charts use TradingView's open-source [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (v5.3, Apache 2.0, bundled in `lib/`).

## Inside Search Console (no setup)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open any Search Console performance report, for example `search.google.com/u/6/search-console/performance/search-analytics/ai?resource_id=…`. About a second after Search Console draws its own chart, the terminal takes over the page below the Search Console header.

How it works:

- **Data access:** a small bridge script reads the report request Search Console itself made, including property, report (Search results, Generative AI, Discover, News), search type and every filter you set. It then replays that request with a 1 to 16 month range, using your logged-in session for that `/u/N` account. No OAuth, no API quota, and it works for any of your signed-in Google accounts.
- **Generative AI report:** only impressions exist there, so the other metrics are disabled. That report has no public API equivalent.
- **Changing filters:** **◧ GSC** in the toolbar, or **Alt+T**, switches back to the native view, so you can change filters or dates with Search Console's own controls. Then click **📈 Terminal** (bottom right) and the terminal reloads with those filters. Turning back to the native view also turns off auto-replace until you click Terminal again.
- **Switching properties:** the property dropdown lists your properties and navigates Search Console to the one you pick.
- **GSC notes:** Search Console's own annotations (such as data-anomaly notes) appear as grey "GSC note" markers.
- **Caveat:** this mode depends on Search Console's internal data format (the `batchexecute` RPC). If Google changes it, the terminal shows an error and the native report remains usable. API mode is unaffected.

## Standalone tab (CSV / demo)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
Click the toolbar icon to open the terminal in its own tab. Without API setup you can use **Import CSV** (the `Dates.csv` from a GSC performance export) or **Load demo data**.

## API mode setup (optional, about 10 minutes, once)

API mode adds the standalone tab with your own filters.

1. Note the extension ID shown on `chrome://extensions`. It stays the same as long as you load it from the same folder. To pin it, add a `"key"` to `manifest.json`.
2. In Google Cloud Console, open or create a project and enable the **Google Search Console API**.
3. Under **OAuth consent screen**, choose External, set Testing mode, and add your own Google account as a test user.
4. Under **Credentials**, choose **Create OAuth client ID** → application type **Chrome Extension** → paste the extension ID.
5. In `manifest.json`, replace `YOUR_CLIENT_ID.apps.googleusercontent.com` with the client ID. Then reload the extension.
6. Open the terminal and click **Connect Google**. The only scope requested is `webmasters.readonly`.

Sign-in uses `chrome.identity.getAuthToken`, which works in Google Chrome only. Edge, Brave and Arc would need a `launchWebAuthFlow` variant.

## How candles are built

| Field | Meaning |
|---|---|
| Close | Value for the bar. Clicks and impressions are **per-day averages** on 1W/1M (per-hour on 4H), so weeks and months are comparable. CTR is clicks/impressions; position is impression-weighted. |
| Open | The previous bar's close, so the body shows the period-over-period change. |
| High / Low | The most extreme single day (or hour) inside the bar. Long wicks mean high volatility within the period, such as weekday/weekend swings. |
| Volume | Total impressions in the bar (total clicks when the metric is Impressions). |
| Grey bar | Partial data: on or after the API's `firstIncompleteDate` / `firstIncompleteHour`. |

On **Position** the scale is inverted, so up and green always mean "better".

- **Timeframes:** 1D, 1W and 1M, from daily data (up to 16 months).
- **MA periods** are set per timeframe (1D 7/28, 1W 4/13, 1M 3/12). On 1D the windows cover whole weekly cycles, so seasonality evens out. Change them under Filters.
- **Sig** places GX/DX markers where the fast MA crosses the slow MA.
- **YoY** overlays the value from 364 days earlier (12 months on 1M). It needs 16M of history.
- **Events:** double-click any bar to add a label such as "Core update" or "Migration". Events are stored per property in `chrome.storage`.
- **Filters:** query/page (contains, equals, regex, negations), country (ISO-3166 alpha-3, e.g. `nld`), device, and search type (web, image, video, news, discover, googleNews).

## Shortcuts

`1` `2` `3` switch timeframe (1D, 1W, 1M). `c` `i` `r` `p` switch metric (clicks, impressions, CTR, position).

## Files

- `chart.html`, `chart.css`, `chart.js`: the terminal UI
- `lib/indicators.js`: candle aggregation, Heikin Ashi, SMA/EMA, Bollinger, RSI, crossovers, YoY, GSC CSV parser (pure functions, Node-testable)
- `lib/gsc.js`: Search Console API client
- `content.js`: page takeover inside Search Console (overlay iframe, URL tracking, Alt+T)
- `gsc-bridge.js`: runs in the Search Console page; captures and replays the report's own data request
- `background.js`: toolbar icon opens the standalone tab
