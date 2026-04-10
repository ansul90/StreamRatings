/**
 * StreamRatings — Background Service Worker
 *
 * Responsibilities:
 *  - Receive GET_RATING messages from the content script
 *  - Check chrome.storage.local cache before hitting OMDb API
 *  - Fetch from OMDb when cache misses or is stale (TTL: 7 days)
 *  - If OMDb has no RT score, scrape rottentomatoes.com directly
 *  - Return structured rating data (IMDB + RT) back to the caller
 */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OMDB_BASE_URL = "https://www.omdbapi.com/";
const CACHE_KEY_PREFIX = "sr_cache_";

// ── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_RATING") {
    handleGetRating(message.title, message.year)
      .then(sendResponse)
      .catch((err) => {
        console.error("[StreamRatings] Error fetching rating:", err);
        sendResponse(null);
      });
    return true; // Keep the message channel open for async response
  }
});

// ── Core Handler ─────────────────────────────────────────────────────────────

/**
 * Returns cached or freshly fetched rating data for a given title.
 * @param {string} title - The movie or show title extracted from the Netflix card
 * @returns {Promise<RatingData|null>}
 *
 * @typedef {Object} RatingData
 * @property {string} imdbRating  - e.g. "7.8" or "N/A"
 * @property {string} imdbVotes   - e.g. "1,234,567" or "N/A"
 * @property {string} tomatoMeter - e.g. "94" or "N/A"
 * @property {string} metascore   - e.g. "78" or "N/A"
 * @property {string} type        - "movie" | "series"
 * @property {string} imdbID      - e.g. "tt1234567"
 * @property {string} genre       - e.g. "Drama, Thriller"
 * @property {string} rated       - e.g. "PG-13", "TV-MA"
 * @property {string} runtime     - e.g. "148 min"
 * @property {string} year        - e.g. "2010"
 * @property {number} cachedAt    - Unix timestamp of when this was cached
 */
async function handleGetRating(title, year) {
  const cacheKey = buildCacheKey(title);

  const cached = await getFromCache(cacheKey);
  if (cached) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn("[StreamRatings] No OMDb API key configured.");
    return null;
  }

  const data = await fetchFromOmdb(title, apiKey, year);
  // Only cache entries that have real data or are confirmed not-found.
  // Do NOT cache stub entries (Response:"True" but imdbRating:"N/A") — those
  // would lock us into showing N/A for 7 days even after OMDb populates them.
  if (data && data.confirmed) {
    const { confirmed: _, ...cacheable } = data;
    await saveToCache(cacheKey, cacheable);
    return cacheable;
  }

  return data;
}

// ── OMDb API ─────────────────────────────────────────────────────────────────

/**
 * Fetches rating data from OMDb for the given title, then supplements with
 * a direct RT scrape if OMDb has no Tomatometer data.
 *
 * Strategy:
 *  1. Try ?t= (direct title lookup) first — this is OMDb's best-match result
 *     and should be trusted as-is. We no longer override a series result with
 *     a movie result, since that caused "Friends" (TV, 8.9) to be replaced by
 *     "Friends with Benefits" (movie, 6.5).
 *  2. If direct lookup returns N/A, retry with Roman numeral variant.
 *  3. If still no result, fall back to ?s= search candidates.
 *  4. If OMDb has no Tomatometer score, scrape RT directly.
 */
async function fetchFromOmdb(title, apiKey, year) {
  const direct = await fetchByTitle(title, apiKey, year);

  // Trust the direct ?t= result when it has a real IMDb rating.
  // Do NOT override it with a search candidate — that caused false movie
  // matches for TV series titles (e.g. "Friends" → "Friends with Benefits").
  if (direct && direct.imdbRating !== "N/A") {
    const result = await enrichWithRtScore(direct, title);
    return { ...result, confirmed: true };
  }

  // Retry with Roman numeral variant (Netflix uses "2", OMDb often uses "II").
  const romanTitle = toRomanNumeralTitle(title);
  if (romanTitle !== title) {
    const romanResult = await fetchByTitle(romanTitle, apiKey, year);
    if (romanResult && romanResult.imdbRating !== "N/A") {
      const result = await enrichWithRtScore(romanResult, romanTitle);
      return { ...result, confirmed: true };
    }
  }

  // Fall back to ?s= search candidates only when direct lookup failed entirely.
  const candidates = await fetchAllRatedCandidates(title, apiKey);
  if (candidates.length > 0) {
    const result = await enrichWithRtScore(candidates[0], title);
    return { ...result, confirmed: true };
  }

  // Nothing worked — return N/A placeholder (never cached) so a badge still shows.
  const fallback = direct ?? {
    imdbRating: "N/A",
    imdbVotes: "N/A",
    tomatoMeter: "N/A",
    metascore: "N/A",
    type: "unknown",
    imdbID: null,
    genre: "N/A",
    rated: "N/A",
    runtime: "N/A",
    year: "N/A",
    cachedAt: Date.now(),
  };
  return { ...fallback, confirmed: false };
}

/**
 * Converts trailing Arabic numerals in a title to Roman numerals.
 * Handles 1–10 which covers virtually all sequel numbering in practice.
 * e.g. "Extraction 2" → "Extraction II", "Fast X" unchanged, "John Wick 4" → "John Wick IV"
 */
function toRomanNumeralTitle(title) {
  const arabicToRoman = {
    '10': 'X', '9': 'IX', '8': 'VIII', '7': 'VII', '6': 'VI',
    '5': 'V',  '4': 'IV', '3': 'III', '2': 'II',  '1': 'I',
  };
  return title.replace(/\b(\d+)$/, (match) => arabicToRoman[match] || match);
}

/**
 * Direct OMDb title lookup via ?t=.
 */
async function fetchByTitle(title, apiKey, year) {
  const url = new URL(OMDB_BASE_URL);
  url.searchParams.set("t", title);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("tomatoes", "true");
  url.searchParams.set("r", "json");
  if (year) url.searchParams.set("y", year);

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`OMDb HTTP error: ${response.status}`);
  const json = await response.json();

  if (json.Response === "False") return null;

  return {
    imdbRating: json.imdbRating || "N/A",
    imdbVotes: json.imdbVotes || "N/A",
    tomatoMeter: extractTomatoMeter(json),
    metascore: json.Metascore || "N/A",
    type: json.Type || "unknown",
    imdbID: json.imdbID || null,
    genre: json.Genre || "N/A",
    rated: json.Rated || "N/A",
    runtime: json.Runtime || "N/A",
    year: json.Year || "N/A",
    cachedAt: Date.now(),
  };
}

/**
 * Uses OMDb's search endpoint (?s=) to get a list of matching titles,
 * then probes each candidate by IMDb ID (?i=) and returns ALL entries
 * that have real ratings. This allows the caller to pick the best match
 * (e.g. prefer movie over series for ambiguous titles like "Tehran").
 */
async function fetchAllRatedCandidates(title, apiKey) {
  const searchUrl = new URL(OMDB_BASE_URL);
  searchUrl.searchParams.set("s", title);
  searchUrl.searchParams.set("apikey", apiKey);
  searchUrl.searchParams.set("r", "json");

  const searchResp = await fetch(searchUrl.toString());
  if (!searchResp.ok) return [];
  const searchJson = await searchResp.json();

  if (searchJson.Response === "False" || !Array.isArray(searchJson.Search)) {
    return [];
  }

  const rated = [];

  for (const candidate of searchJson.Search.slice(0, 5)) {
    if (!candidate.imdbID) continue;

    const detailUrl = new URL(OMDB_BASE_URL);
    detailUrl.searchParams.set("i", candidate.imdbID);
    detailUrl.searchParams.set("apikey", apiKey);
    detailUrl.searchParams.set("tomatoes", "true");
    detailUrl.searchParams.set("r", "json");

    const detailResp = await fetch(detailUrl.toString());
    if (!detailResp.ok) continue;
    const detail = await detailResp.json();

    if (detail.Response === "True" && detail.imdbRating && detail.imdbRating !== "N/A") {
      rated.push({
        imdbRating: detail.imdbRating,
        imdbVotes: detail.imdbVotes || "N/A",
        tomatoMeter: extractTomatoMeter(detail),
        metascore: detail.Metascore || "N/A",
        type: detail.Type || "unknown",
        imdbID: detail.imdbID || null,
        genre: detail.Genre || "N/A",
        rated: detail.Rated || "N/A",
        runtime: detail.Runtime || "N/A",
        year: detail.Year || "N/A",
        cachedAt: Date.now(),
      });
    }
  }

  return rated;
}

/**
 * OMDb returns RT data in the Ratings array as well as top-level fields.
 * This extracts the Tomatometer from whichever location is present.
 */
function extractTomatoMeter(json) {
  if (json.Ratings && Array.isArray(json.Ratings)) {
    const rtEntry = json.Ratings.find(
      (r) => r.Source === "Rotten Tomatoes"
    );
    if (rtEntry) {
      return rtEntry.Value.replace("%", ""); // e.g. "94" from "94%"
    }
  }
  // Fallback to top-level tomatoMeter field (older OMDb responses)
  return json.tomatoMeter || "N/A";
}

// ── Rotten Tomatoes Direct Scraper ────────────────────────────────────────────

/**
 * If OMDb didn't provide a Tomatometer score, attempt to fetch it directly
 * from rottentomatoes.com. Returns the data object with tomatoMeter filled in
 * if found, otherwise returns it unchanged.
 */
async function enrichWithRtScore(data, title) {
  if (data.tomatoMeter && data.tomatoMeter !== "N/A") return data;

  try {
    const rtScore = await fetchFromRottenTomatoes(title, data.type);
    if (rtScore !== null) {
      return { ...data, tomatoMeter: String(rtScore) };
    }
  } catch (err) {
    console.warn("[StreamRatings] RT scrape failed:", err.message);
  }

  return data;
}

/**
 * Searches rottentomatoes.com for the title, picks the best matching page
 * (preferring /tv/ for series and /m/ for movies), then extracts the
 * Tomatometer from the <score-board> element on that page.
 *
 * RT's search page returns plain HTML containing anchor tags like:
 *   <a href="/tv/naruto">Naruto</a>
 *   <a href="/m/friends_with_benefits">Friends with Benefits</a>
 *
 * The title page contains a custom element:
 *   <score-board tomatometerscore="91" audiencescore="81" ...>
 *
 * Returns the critic score (tomatometerscore) as a number, or the audience
 * score as fallback, or null if neither is found.
 */
async function fetchFromRottenTomatoes(title, type) {
  const slug = await resolveRtSlug(title, type);
  if (!slug) return null;

  const pageUrl = `https://www.rottentomatoes.com${slug}`;
  const pageResp = await fetch(pageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; StreamRatings/1.0)" },
  });
  if (!pageResp.ok) return null;

  const html = await pageResp.text();
  return parseRtScoreFromHtml(html);
}

/**
 * Searches RT and returns the relative URL slug for the best matching title.
 * Prefers /tv/ slugs for series, /m/ slugs for movies.
 * Falls back to whichever type is available if the preferred type has no match.
 */
async function resolveRtSlug(title, type) {
  const searchUrl = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`;
  const resp = await fetch(searchUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; StreamRatings/1.0)" },
  });
  if (!resp.ok) return null;

  const html = await resp.text();

  // Extract all /m/ and /tv/ hrefs from the search results page.
  const movieSlugs = [...html.matchAll(/href="(\/m\/[a-z0-9_]+)"/gi)].map(m => m[1]);
  const tvSlugs    = [...html.matchAll(/href="(\/tv\/[a-z0-9_]+)"/gi)].map(m => m[1]);

  const isSeries = type === "series";

  // Return the preferred type first, then fall back to the other.
  if (isSeries && tvSlugs.length > 0) return tvSlugs[0];
  if (!isSeries && movieSlugs.length > 0) return movieSlugs[0];
  if (tvSlugs.length > 0) return tvSlugs[0];
  if (movieSlugs.length > 0) return movieSlugs[0];

  return null;
}

/**
 * Parses the Tomatometer (and audience score fallback) from an RT title page.
 * RT stores scores as attributes on the custom <score-board> element:
 *   <score-board tomatometerscore="91" audiencescore="81" ...>
 */
function parseRtScoreFromHtml(html) {
  const criticMatch  = html.match(/tomatometerscore="(\d+)"/i);
  if (criticMatch) return parseInt(criticMatch[1], 10);

  const audienceMatch = html.match(/audiencescore="(\d+)"/i);
  if (audienceMatch) return parseInt(audienceMatch[1], 10);

  return null;
}

// ── Cache Helpers ─────────────────────────────────────────────────────────────

function buildCacheKey(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]/g, "_");
  return `${CACHE_KEY_PREFIX}${slug}`;
}

async function getFromCache(cacheKey) {
  const result = await chrome.storage.local.get(cacheKey);
  const entry = result[cacheKey];

  if (!entry) return null;

  const isStale = Date.now() - entry.cachedAt > CACHE_TTL_MS;
  if (isStale) {
    chrome.storage.local.remove(cacheKey);
    return null;
  }

  // Evict stub entries (found by OMDb but no rating data) so the search
  // fallback gets a chance to find the correct record on next load.
  if (entry.imdbRating === "N/A" && entry.tomatoMeter === "N/A" && entry.imdbID) {
    chrome.storage.local.remove(cacheKey);
    return null;
  }

  // Evict old-format cache entries that lack the new fields (imdbVotes, genre, etc.)
  if (!entry.imdbVotes) {
    chrome.storage.local.remove(cacheKey);
    return null;
  }

  return entry;
}

async function saveToCache(cacheKey, data) {
  await chrome.storage.local.set({ [cacheKey]: data });
}

async function getApiKey() {
  const result = await chrome.storage.sync.get("omdbApiKey");
  return result.omdbApiKey || null;
}

// ── API Key Validation & Threshold Relay (called from popup) ──────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "VALIDATE_API_KEY") {
    validateApiKey(message.apiKey)
      .then(sendResponse)
      .catch(() => sendResponse({ valid: false }));
    return true;
  }

  if (message.type === "THRESHOLD_CHANGED") {
    chrome.tabs.query({
      url: [
        "https://www.netflix.com/*",
        "https://www.primevideo.com/*",
        "https://www.hotstar.com/*",
        "https://www.sonyliv.com/*",
        "https://www.zee5.com/*",
      ],
    }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: "APPLY_THRESHOLD",
          threshold: message.threshold,
        });
      }
    });
    sendResponse({ ok: true });
    return true;
  }
});

async function validateApiKey(apiKey) {
  const url = new URL(OMDB_BASE_URL);
  url.searchParams.set("t", "Inception");
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("r", "json");

  const response = await fetch(url.toString());
  const json = await response.json();
  return { valid: json.Response === "True" };
}
