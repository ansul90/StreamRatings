# StreamRatings

A Chrome extension that overlays **IMDb scores** and **Rotten Tomatoes Tomatometer** ratings directly on movie and show cards across popular Indian and global streaming platforms — so you can judge a title before you click on it.

![Supported platforms: Netflix, Prime Video, Hotstar, SonyLIV, Zee5](https://img.shields.io/badge/Platforms-Netflix%20%7C%20Prime%20%7C%20Hotstar%20%7C%20SonyLIV%20%7C%20Zee5-blue)
![Manifest Version 3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-green)

---

## Features

- **IMDb badge** on every catalog card — color-coded green / yellow / red by score
- **Rotten Tomatoes Tomatometer %** shown alongside the IMDb score when available
- **Clickable IMDb link** on the badge — opens the title's IMDb page in a new tab
- **Hover tooltip** with star rating, vote count, and RT % details
- **Quality threshold filter** — grey out cards below your chosen IMDb score (slider from 0–9 in 0.5 steps; 0 = off)
- **7-day local cache** — avoids redundant API calls; clear anytime from the popup
- **Works across five platforms:** Netflix, Prime Video, Hotstar, SonyLIV, Zee5

---

## How It Works

```
Streaming page (DOM)
       │
       ▼
Content Script (MutationObserver)
  ─ Detects title cards, extracts title + year
       │  chrome.runtime.sendMessage GET_RATING
       ▼
Service Worker (background)
  ─ Checks chrome.storage.local cache (7-day TTL)
  ─ Queries OMDb API  →  IMDb score + basic RT data
  ─ Falls back to direct Rotten Tomatoes HTML fetch
  ─ Returns { imdbRating, rtScore, imdbID, … }
       │
       ▼
Content Script
  ─ Injects .sr-badge onto the card
  ─ Applies .sr-greyed-out if score < threshold
```

---

## Project Structure

```
StreamRatings/
├── manifest.json                  # Chrome MV3 extension manifest
├── background/
│   └── service-worker.js          # API fetching, caching, threshold broadcast
├── content/
│   ├── netflix.js                 # Netflix DOM observer + badge injection
│   ├── primevideo.js              # Prime Video DOM observer + badge injection
│   ├── hotstar.js                 # Hotstar DOM observer + badge injection
│   ├── sonyliv.js                 # SonyLIV DOM observer + badge injection
│   └── zee5.js                    # Zee5 DOM observer + badge injection
├── popup/
│   ├── popup.html                 # Extension popup UI
│   └── popup.js                   # Popup logic (API key, threshold, cache)
├── styles/
│   └── badge.css                  # Injected badge, tooltip, and grey-out styles
├── assets/
│   ├── generate-icons.sh          # ImageMagick icon generation script
│   ├── generate-icons.py          # Python icon generation script
│   ├── icon16.png                 # Extension toolbar icon (16×16)
│   ├── icon48.png                 # Extension management icon (48×48)
│   └── icon128.png                # Chrome Web Store icon (128×128)
└── SETUP.md                       # Quick-start reference
```

---

## Prerequisites

- **Google Chrome** (or any Chromium-based browser that supports MV3 extensions)
- A free **OMDb API key** (see step 2 below)

---

## Installation & Setup

### Step 1 — Clone the repository

```bash
git clone <your-repo-url>
cd StreamRatings
```

### Step 2 — Get a free OMDb API key

StreamRatings uses the [OMDb API](https://www.omdbapi.com/) to fetch IMDb ratings.

1. Visit **https://www.omdbapi.com/apikey.aspx**
2. Choose the **FREE** tier (1,000 requests/day — more than enough for casual browsing)
3. Enter your email address and submit
4. Open the activation email and click the confirmation link
5. Your API key will be shown on the confirmation page — copy it

### Step 3 — Load the extension in Chrome

1. Open Chrome and navigate to **`chrome://extensions`**
2. Toggle **Developer mode** ON (switch in the top-right corner)
3. Click **Load unpacked**
4. Select the **`StreamRatings/`** folder (the root of this repository)
5. The StreamRatings icon will appear in your Chrome toolbar (you may need to pin it via the puzzle-piece Extensions menu)

### Step 4 — Enter your API key

1. Click the **StreamRatings icon** in the toolbar to open the popup
2. Paste your OMDb API key into the **API Key** field
3. Click **Save** — the extension validates the key live and shows a confirmation
4. That's it. The key is stored securely in `chrome.storage.sync` and syncs across your Chrome profile

---

## Using the Extension

1. Go to any supported streaming site:
   - **Netflix** — https://www.netflix.com
   - **Prime Video** — https://www.primevideo.com
   - **Hotstar** — https://www.hotstar.com
   - **SonyLIV** — https://www.sonyliv.com
   - **Zee5** — https://www.zee5.com
2. Browse any row of titles — IMDb and RT badges appear on cards within about a second
3. Hover over a badge to see the full tooltip (vote count, stars, RT %)
4. Click a badge to open the title's IMDb page

### Quality Threshold

Open the popup and use the **IMDb Threshold** slider to automatically grey out titles below your chosen score. Set to **0** to disable filtering. Changes apply instantly to all open tabs without a page reload.

### Clearing the Cache

Ratings are cached for **7 days** to avoid hitting the API on every visit. To force a refresh, click **Clear Rating Cache** in the popup.

---

## Permissions Explained

| Permission | Why it's needed |
|---|---|
| `storage` | Save your API key (`sync`) and the ratings cache (`local`) |
| `tabs` | Find open streaming tabs to push threshold changes without a reload |
| `https://www.omdbapi.com/*` | Fetch IMDb data from the OMDb API |
| `https://www.rottentomatoes.com/*` | Fetch Rotten Tomatoes scores when OMDb doesn't include them |
| Streaming site URLs | Inject content scripts and badge styles |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No badges appear | Ensure your API key is saved in the popup and shows as valid |
| Badges show **N/A** | The title wasn't matched — common with localized titles or very new releases |
| Too many N/A results | Open Chrome DevTools on the streaming page (`F12`) and filter the console for `[StreamRatings]` |
| "Invalid key" on save | Double-check the key from the OMDb email; make sure you clicked the activation link |
| Extension not loading | Ensure **Developer mode** is on and you selected the root `StreamRatings/` folder, not a subfolder |
| Badges disappeared after update | Go to `chrome://extensions`, find StreamRatings, and click the refresh icon |

---

## Configuration Reference

All settings are managed through the popup UI:

| Setting | Storage | Default | Description |
|---|---|---|---|
| OMDb API Key | `chrome.storage.sync` | — | Required. Get one free at omdbapi.com |
| IMDb Threshold | `chrome.storage.sync` | 0 (off) | Grey out cards with IMDb score below this value |
| Rating Cache | `chrome.storage.local` | — | 7-day TTL; cleared via the popup button |

---

## Development Notes

- Built with **Chrome Manifest V3** (service worker, no persistent background page)
- Each content script uses a `MutationObserver` to handle SPA navigation without full page reloads
- Hotstar, SonyLIV, and Zee5 include additional URL-change observers to handle client-side routing
- The service worker handles OMDb fallback logic: primary `?t=` title lookup → Roman numeral retry → `?s=` search candidates; RT scores are fetched separately when missing
- No build step or bundler required — load directly as an unpacked extension

---

## License

MIT
