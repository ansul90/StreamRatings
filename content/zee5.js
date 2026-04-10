/**
 * StreamRatings — Zee5 Content Script
 *
 * Responsibilities:
 *  - Observe Zee5's dynamically rendered DOM for movie/show cards
 *  - Extract titles from cards
 *  - Request ratings from the background service worker
 *  - Inject color-coded IMDb badge with hover tooltip onto each card
 *  - Grey-out cards below a user-defined IMDb rating threshold
 *
 * Zee5 is a React SPA — navigating between pages does not reload the
 * document. A second MutationObserver watches for URL changes and re-runs
 * card discovery after a short delay to let new content render.
 *
 * Card selectors use href patterns rather than class names because Zee5's
 * React-generated class names are obfuscated and unstable across deployments.
 * Zee5 content URLs follow stable patterns:
 *   /movies/details/[title-slug]/[id]
 *   /tvshows/details/[title-slug]/[id]
 *   /zee5originals/details/[title-slug]/[id]
 *   /kids/details/[title-slug]/[id]
 */

// ── Card Selectors ────────────────────────────────────────────────────────────
//
// href-based selectors are the most resilient for Zee5 because the URL
// patterns are stable while CSS class names change with React builds.
// Class-based selectors are added as supplementary coverage for layouts
// where the anchor does not directly link to a content detail page.

const CARD_SELECTORS = [
  "a[href*='/movies/details/']",
  "a[href*='/tvshows/details/']",
  "a[href*='/zee5originals/details/']",
  "a[href*='/kids/details/']",
  ".card-wrap a",
  ".card__link",
];

const BADGE_ATTR = "data-sr-injected";
const RATING_DATA_ATTR = "data-sr-imdb-rating";

let currentThreshold = 0;

// ── Load persisted threshold ──────────────────────────────────────────────────

chrome.storage.sync.get("ratingThreshold", (result) => {
  currentThreshold = result.ratingThreshold || 0;
});

// ── Listen for threshold changes from popup ───────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "APPLY_THRESHOLD") {
    currentThreshold = message.threshold;
    applyThresholdToAll();
  }
});

// ── MutationObserver — DOM changes ────────────────────────────────────────────

let observerDebounceTimer = null;

const observer = new MutationObserver(() => {
  clearTimeout(observerDebounceTimer);
  observerDebounceTimer = setTimeout(processNewCards, 400);
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

// ── MutationObserver — SPA URL changes ───────────────────────────────────────
// Zee5 navigates without a full page reload. Watch for href changes and
// re-process cards once new content has had time to render.

let lastHref = location.href;

const locationObserver = new MutationObserver(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    setTimeout(processNewCards, 1500);
  }
});

locationObserver.observe(document.body, { subtree: true, childList: true });

processNewCards();

// ── Card Discovery ────────────────────────────────────────────────────────────

function findCards() {
  const found = new Set();
  for (const selector of CARD_SELECTORS) {
    const cards = document.querySelectorAll(selector);
    for (const card of cards) {
      found.add(card);
    }
  }
  return found;
}

// ── Card Processing ───────────────────────────────────────────────────────────

function processNewCards() {
  const cards = findCards();

  for (const card of cards) {
    if (card.getAttribute(BADGE_ATTR)) continue;

    const parsed = extractTitle(card);
    if (!parsed) continue;

    card.setAttribute(BADGE_ATTR, "pending");
    fetchAndInjectRating(card, parsed.title, parsed.year);
  }
}

// ── Title Extraction ──────────────────────────────────────────────────────────

/**
 * Extracts the title from a Zee5 card using multiple strategies.
 *
 * Zee5 card anchors may carry aria-label/title on the element itself, or
 * the title can be found in child elements or parsed from the href slug.
 *
 * Zee5 href format: /movies/details/love-story-2021/0-0-12345
 * Title slug is the second-to-last path segment; strip the trailing
 * year (4 digits) to get a clean title.
 */
function extractTitle(card) {
  // Strategy 1: aria-label on the card anchor
  const ariaLabel = card.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) {
    return parseTitle(ariaLabel.trim());
  }

  // Strategy 2: title attribute on the card anchor
  const titleAttr = card.getAttribute("title");
  if (titleAttr && titleAttr.trim()) {
    return parseTitle(titleAttr.trim());
  }

  // Strategy 3: img alt text — skip if it looks like a URL or is generic
  const img = card.querySelector("img[alt]");
  if (img) {
    const alt = img.getAttribute("alt");
    if (alt && alt.trim() && !alt.startsWith("http") && alt.toLowerCase() !== "poster") {
      return parseTitle(alt.trim());
    }
  }

  // Strategy 4: element with "title" in its class name (common in Zee5 card layouts)
  const titleEl = card.querySelector("[class*='title']");
  if (titleEl && titleEl.textContent.trim()) {
    return parseTitle(titleEl.textContent.trim());
  }

  // Strategy 5: parse from href slug — most reliable universal fallback
  // /movies/details/love-story-2021/0-0-12345 → second-to-last = "love-story-2021"
  const href = card.getAttribute("href");
  if (href) {
    const parts = href.split("/").filter(Boolean);
    // Find the segment after "details"
    const detailsIdx = parts.indexOf("details");
    const slugSegment = detailsIdx >= 0 ? parts[detailsIdx + 1] : parts[parts.length - 2];
    if (slugSegment) {
      const cleaned = slugSegment
        .replace(/-(\d{4})$/, "")  // strip trailing 4-digit year e.g. "-2021"
        .replace(/-/g, " ")
        .trim();
      if (cleaned) return parseTitle(cleaned);
    }
  }

  return null;
}

function parseTitle(raw) {
  const yearMatch = raw.match(/\((\d{4})\)$/);
  const year = yearMatch ? yearMatch[1] : null;
  const title = raw
    .replace(/:\s*season\s*\d+.*/i, "")
    .replace(/\s*\(\d{4}\)$/, "")
    .replace(/\s*-\s*Season\s*\d+.*/i, "")
    .replace(/\[.*\]$/, "")
    .trim();
  return title ? { title, year } : null;
}

// ── Rating Fetch & Badge Injection ───────────────────────────────────────────

async function fetchAndInjectRating(card, title, year) {
  const data = await chrome.runtime.sendMessage({
    type: "GET_RATING",
    title,
    year,
  });

  card.setAttribute(BADGE_ATTR, "done");

  if (!data) return;

  const rating = data.imdbRating;
  const hasRating = rating && rating !== "N/A";

  if (hasRating) {
    card.setAttribute(RATING_DATA_ATTR, rating);
  }

  injectBadges(card, data, title);

  if (hasRating) {
    applyThresholdToCard(card);
  }
}

function injectBadges(card, data, title) {
  if (getComputedStyle(card).position === "static") {
    card.style.position = "relative";
  }

  const wrapper = buildBadgeWrapper(data, title);
  card.appendChild(wrapper);

  card.appendChild(buildBookmarkRibbon(data, title));
}

// ── Badge Builder ─────────────────────────────────────────────────────────────

function buildBadgeWrapper(data, title) {
  const wrapper = document.createElement("div");
  wrapper.className = "sr-badge-wrapper";

  if (data.imdbRating && data.imdbRating !== "N/A") {
    wrapper.appendChild(buildImdbBadge(data, title));
  }

  return wrapper;
}

function buildBookmarkRibbon(data, title) {
  const ribbon = document.createElement("div");
  ribbon.className = "sr-bookmark";

  const icon = document.createElement("span");
  icon.className = "sr-bookmark-icon";
  icon.textContent = "☆";
  ribbon.appendChild(icon);

  if (!data.imdbID) {
    ribbon.title = "Rating not available";
    ribbon.style.cursor = "default";
    return ribbon;
  }

  ribbon.title = "Save to watchlist";

  chrome.runtime.sendMessage(
    { type: "CHECK_WATCHLIST", imdbID: data.imdbID },
    (response) => {
      if (response && response.saved) {
        ribbon.classList.add("sr-saved");
        icon.textContent = "★";
        ribbon.title = "Remove from watchlist";
      }
    }
  );

  ribbon.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const entry = {
      title,
      imdbID: data.imdbID,
      imdbRating: data.imdbRating,
      tomatoMeter: data.tomatoMeter,
      type: data.type,
      year: data.year,
      platform: "zee5",
      genre: data.genre,
    };

    const response = await chrome.runtime.sendMessage({
      type: "TOGGLE_WATCHLIST",
      entry,
    });

    if (response && response.saved) {
      ribbon.classList.add("sr-saved");
      icon.textContent = "★";
      ribbon.title = "Remove from watchlist";
    } else {
      ribbon.classList.remove("sr-saved");
      icon.textContent = "☆";
      ribbon.title = "Save to watchlist";
    }
  });

  return ribbon;
}

function buildImdbBadge(data, title) {
  const rating = data.imdbRating;
  const imdbID = data.imdbID;

  const badge = document.createElement("div");
  badge.className = `sr-badge sr-imdb ${imdbColorClass(rating)}`;

  badge.innerHTML = `
    <span class="sr-logo sr-logo-imdb">IMDb</span>
    <span class="sr-score">${rating}</span>
  `;

  const href = imdbID
    ? `https://www.imdb.com/title/${imdbID}/`
    : `https://www.imdb.com/find/?q=${encodeURIComponent(title)}&s=tt&ttype=ft`;

  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "sr-badge-link sr-badge-link-imdb";
  link.appendChild(badge);

  const tooltip = buildTooltip(data);
  link.appendChild(tooltip);

  return link;
}

function buildTooltip(data) {
  const tooltip = document.createElement("div");
  tooltip.className = "sr-tooltip";

  const lines = [];

  if (data.imdbRating && data.imdbRating !== "N/A") {
    const score = parseFloat(data.imdbRating);
    const maxStars = 5;
    const starCount = Math.round((score / 10) * maxStars * 2) / 2;
    const stars = renderStars(starCount, maxStars);
    lines.push(`<div class="sr-tip-line sr-tip-stars">${stars}<span class="sr-tip-score">${data.imdbRating}</span></div>`);
  }

  if (data.imdbVotes && data.imdbVotes !== "N/A") {
    lines.push(`<div class="sr-tip-line"><span class="sr-tip-votes">${abbreviateVotes(data.imdbVotes)} votes</span></div>`);
  }

  if (data.tomatoMeter && data.tomatoMeter !== "N/A") {
    lines.push(`<div class="sr-tip-line"><span class="sr-tip-rt">🍅 ${data.tomatoMeter}%</span></div>`);
  }

  tooltip.innerHTML = lines.join("");
  return tooltip;
}

function abbreviateVotes(votesStr) {
  const n = parseInt(votesStr.replace(/,/g, ""), 10);
  if (isNaN(n)) return votesStr;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function renderStars(count, max) {
  let html = "";
  for (let i = 1; i <= max; i++) {
    if (i <= Math.floor(count)) {
      html += '<span class="sr-star sr-star-full">★</span>';
    } else if (i - 0.5 <= count) {
      html += '<span class="sr-star sr-star-half">★</span>';
    } else {
      html += '<span class="sr-star sr-star-empty">★</span>';
    }
  }
  return html;
}

// ── Threshold / Grey-out ──────────────────────────────────────────────────────

function applyThresholdToAll() {
  const cards = findCards();
  for (const card of cards) {
    applyThresholdToCard(card);
  }
}

function applyThresholdToCard(card) {
  const ratingStr = card.getAttribute(RATING_DATA_ATTR);
  if (!ratingStr) return;

  const score = parseFloat(ratingStr);

  if (currentThreshold > 0 && !isNaN(score) && score < currentThreshold) {
    card.classList.add("sr-greyed-out");
  } else {
    card.classList.remove("sr-greyed-out");
  }
}

// ── Color Classification ──────────────────────────────────────────────────────

function imdbColorClass(rating) {
  const score = parseFloat(rating);
  if (isNaN(score)) return "sr-na";
  if (score >= 7.5) return "sr-green";
  if (score >= 6.0) return "sr-yellow";
  return "sr-red";
}
