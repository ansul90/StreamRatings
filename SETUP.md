# StreamRatings — Setup Guide

## 1. Generate Icons (one-time)

If you have ImageMagick installed:
```bash
bash assets/generate-icons.sh
```

Otherwise, drop three PNG files into `assets/`:
- `icon16.png`  — 16×16 px
- `icon48.png`  — 48×48 px
- `icon128.png` — 128×128 px

## 2. Get a Free OMDb API Key

1. Go to https://www.omdbapi.com/apikey.aspx
2. Select the **FREE** tier (1,000 requests/day)
3. Enter your email — key will be emailed to you
4. Activate the key via the link in the email

## 3. Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** ON (top-right)
3. Click **Load unpacked**
4. Select this folder (`StreamRatings/`)
5. The extension icon (★) will appear in your toolbar

## 4. Configure Your API Key

1. Click the ★ extension icon in the toolbar
2. Paste your OMDb API key
3. Click **Save** — it will validate the key live
4. Done!

## 5. Use It

- Navigate to **https://www.netflix.com**
- Browse any row of titles
- IMDB and RT badges will appear on cards within a second

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No badges appear | Check the API key is saved in the popup |
| Badges show N/A | The title wasn't matched — this can happen with localized titles |
| Too many N/A | Open DevTools console on Netflix, look for `[StreamRatings]` logs |
| "Invalid key" on save | Double-check key from OMDb email; activate it first |

## Architecture

```
manifest.json              — MV3 extension config
background/service-worker.js — API calls + cache (chrome.storage.local)
content/netflix.js         — DOM observer + badge injection
styles/badge.css           — Badge styles (injected into Netflix pages)
popup/popup.html + popup.js — Settings UI
```

## Cache

Ratings are cached for **7 days** in `chrome.storage.local`.
Clear the cache anytime via the popup's "Clear Rating Cache" button.
