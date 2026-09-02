# Free App Enricher

Self-hosted, zero-cost backend for enriching Google Play and Apple App Store app data. Pairs with the included Google Apps Script spreadsheet add-on.

**No paid APIs. No Apify. No tokens.**

- **Google Play**: uses [`google-play-scraper`](https://github.com/facundoolano/google-play-scraper) (open-source Node.js scraper)
- **Apple App Store**: uses Apple's public [iTunes Lookup API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html) + lightweight website contact crawling

---

## What you get

| Field | Google Play | App Store |
|-------|-------------|-----------|
| App ID / Bundle ID | ✅ | ✅ |
| App Name | ✅ | ✅ |
| Developer | ✅ | ✅ |
| Developer Email | ✅ (from page + site crawl) | ✅ (from site crawl) |
| Developer Website | ✅ | ✅ (sellerUrl) |
| Developer Profile | ✅ | ✅ |
| Developer Address | ✅ | ❌ |
| Developer Phone | ✅ | ❌ |
| Privacy Policy | ✅ | ❌ |
| Installs | ✅ | ❌ |
| Rating / Rating Count | ✅ | ✅ |
| Category | ✅ | ✅ |
| Price / Currency | ✅ | ✅ |
| Version | ✅ | ✅ |
| Store Updated At | ✅ | ✅ |
| Icon URL | ✅ | ✅ |
| Store URL | ✅ | ✅ |

---

## Quick start (local)

```bash
git clone <your-repo>
cd free-app-enricher
npm install
# Optional: copy .env and set a key
cp .env.example .env
node server.js
```

Test:
```bash
curl http://localhost:3000/health
```

```bash
curl -X POST http://localhost:3000/enrich-batch \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://play.google.com/store/apps/details?id=com.google.android.apps.translate"]}'
```

---

## Deploy for free (pick one)

### Render (Recommended — simplest)

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New Web Service**.
3. Connect your GitHub repo.
4. Set:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variable** (optional): `ENRICHER_API_KEY` = any secret string
5. Click **Create Web Service**.
6. Copy the public URL (e.g. `https://free-app-enricher.onrender.com`).
7. Paste it into the Google Sheet via **Free App Enricher → 2b. Set enricher server URL (manual fallback)**.

> Render free tier spins down after 15 min of inactivity (first request may take 30–60 sec to wake up). Upgrade to paid ($7/mo) for always-on.

---

### Railway

1. Push repo to GitHub.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Add environment variable `ENRICHER_API_KEY` if desired.
4. Railway auto-detects Node.js and exposes a public URL.
5. Copy URL into the Google Sheet add-on.

---

### Fly.io

```bash
# Install flyctl first: https://fly.io/docs/hands-on/install-flyctl/
fly launch --name free-app-enricher --region fra
fly secrets set ENRICHER_API_KEY=your-secret-key
fly deploy
```

---

## Connect to the Google Sheet

1. Open the Google Apps Script editor from your Sheet (**Extensions → Apps Script**).
2. Paste the contents of `Code.gs` (the Apps Script file you already have).
3. Save the project.
4. Refresh the Sheet. You will see a new menu: **Free App Enricher**.
5. Click **Set URL auto-update channel** and paste the `AUTO-UPDATE CODE` shown in the tunnel window (e.g. `app-enricher-xxxxxxxx`). The sheet will fetch the current tunnel URL automatically.
6. (Optional) Click **Set service API key** if you configured `ENRICHER_API_KEY`.

> If you are not using the self-healing tunnel (e.g. you are on Render/Railway or using a static URL), use **Set enricher server URL (manual fallback)** instead.
7. Click **Test service connection** to verify.
8. Click **Setup store tabs** to create the **Google Play** and **App Store** sheets.
9. Paste app URLs into the **App URL** column and click **Start automatic enrichment**.

---

## API Contract

Your Apps Script expects exactly these endpoints:

### `GET /health`
Response:
```json
{ "ok": true }
```

### `POST /enrich-batch`
Headers:
```
Content-Type: application/json
Authorization: Bearer <ENRICHER_API_KEY>   (optional)
```

Body:
```json
{
  "urls": [
    "https://play.google.com/store/apps/details?id=com.example.app",
    "https://apps.apple.com/us/app/example/id1234567890"
  ]
}
```

Response:
```json
{
  "ok": true,
  "results": [
    {
      "inputUrl": "https://play.google.com/store/apps/details?id=com.example.app",
      "ok": true,
      "data": {
        "storeLabel": "Google Play",
        "appId": "com.example.app",
        "bundleId": "com.example.app",
        "appName": "Example App",
        "developer": "Example Dev",
        "developerEmail": "dev@example.com",
        "developerWebsite": "https://example.com",
        "developerProfile": "...",
        "developerPhone": "...",
        "developerAddress": "...",
        "developerContactPage": "...",
        "developerSocialProfiles": ["https://twitter.com/example"],
        "privacyPolicy": "...",
        "installs": "1,000,000+",
        "rating": 4.5,
        "ratingCount": 12345,
        "category": "Tools",
        "price": 0,
        "currency": "USD",
        "version": "1.2.3",
        "updatedAt": 1576868577000,
        "icon": "https://...",
        "storeUrl": "https://..."
      }
    }
  ]
}
```

---

## Limits & notes

- **Batch size**: up to 50 URLs per request (enforced by the service; the Apps Script also enforces this).
- **Rate limiting**: Google Play scraping is subject to Google's throttling. If you hit 503/captcha responses, add delays between batches or deploy with a residential IP/proxy.
- **App Store**: Apple's iTunes Lookup API is free and has generous limits, but does not expose developer email, privacy policy, or install count. Contact crawling attempts to fill the email gap by fetching the developer website.
- **Contact crawling**: best-effort. It fetches the developer homepage, looks for email regexes and social links, and optionally follows a "Contact" page. It will not bypass Cloudflare or heavy anti-bot protection.

---

## License

MIT
