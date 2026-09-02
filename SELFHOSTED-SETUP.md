# Self-hosted setup (local PC) — $0 per app

## What runs where

- **Your PC**: `server.js` (port 3000) + a tunnel giving it a public URL
- **Google Sheets**: `free-app-enricher-selfhosted.gs` calls your server through that URL
  (Google's cloud cannot reach `localhost` directly — the tunnel is required)

## First-time setup

1. **Start everything**: double-click `start-enricher.bat`
   (starts `node server.js` + `tunnel.js`, a self-healing pinggy tunnel using
   Windows' built-in SSH — nothing extra to install)
2. **Copy the AUTO-UPDATE CODE** shown in the tunnel window after ~15 seconds
   (looks like `app-enricher-xxxxxxxxxxxxxxxx`). The window also shows the
   current tunnel URL, e.g. `https://rejoj-193-53-89-10.free.pinggy.net`.
3. **In your Google Sheet**, paste `free-app-enricher-selfhosted.gs` into Apps Script, then:
   - `Free App Enricher → 2. Set URL auto-update channel` → paste the AUTO-UPDATE CODE
     (this is the one-time step — the sheet now always finds the current URL by itself)
   - `Free App Enricher → 3. Test server connection` → should say "Server connection successful"
4. Run `4. Start automatic enrichment` as before. Same menu, same tabs, same batch logic.

> Manual fallback: if you cannot use the auto-update channel, use `2b. Set enricher server URL (manual fallback)` and paste the current tunnel URL. You will have to re-paste it every time the tunnel renews.

## Notes

- **Free pinggy tunnels expire after 60 minutes — handled automatically.** `tunnel.js`
  renews the tunnel every ~50 minutes (and after any drop) and publishes the new URL
  to your private channel. If you set menu item 2 once, the sheet picks up every new
  URL on its own — even mid-batch. No re-pasting, ever.
- The auto-update channel code stays the same across restarts (stored in `ntfy-topic.txt`).
  If you move the folder to another PC, copy that file along to keep the same code.
- Keep both console windows open while enrichment runs; closing them stops enrichment
  (rows are recoverable — the sheet resumes when the server is back).
- Optional security: start the server with an API key —
  `set ENRICHER_API_KEY=your-secret && node server.js` — and enter the same key in menu item 2b.
- Alternative tunnels if pinggy is blocked on your network:
  - localtunnel: `node node_modules\localtunnel\bin\lt.js --port 3000` (gives a `loca.lt` URL)
  - cloudflared: `tools\cloudflared.exe tunnel --url http://localhost:3000` (gives a `trycloudflare.com` URL)
  (both require manual URL pasting via menu item 2b — no auto-update)
- Server endpoints: `GET /health`, `POST /enrich-batch` (sync), `POST /jobs` + `GET /jobs/:id` (async, used by the sheet).
