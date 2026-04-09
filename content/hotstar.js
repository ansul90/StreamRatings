/**
 * StreamRatings — Hotstar Content Script
 *
 * Responsibilities:
 *  - Observe Hotstar's dynamically rendered DOM for movie/show cards
 *  - Extract titles from cards
 *  - Request ratings from the background service worker
 *  - Inject color-coded IMDb badge with hover tooltip onto each card
 *  - Grey-out cards below a user-defined IMDb rating threshold
 *
 * Hotstar is a React SPA — navigating between pages does not reload the
 * document. A second MutationObserver watches for URL changes and re-runs
 * card discovery after a short delay to let the new content render.
 *
 * Hotstar's data-testid attributes are more stable than raw class names, so
 * we prefer those selectors; multiple class-based fallbacks keep things
 * working if testids are absent.
 */

// ── Selectors ─────────────────────────────────────────────────────────────────
// Priority order: most specific / most reliable first.

const CARD_SELECTORS = [
  "[data-testid='tray-card-default']",
  "[data-testid='grid-item']",
  "[data-testid='list-item']",
  "[data-testid='content-card']",
  "[data-testid='item-container']",
  "a[href*='/in/movies/']",
  "a[href*='/in/tv/']",
  "a[href*='/in/shows/']",
  ".tray-vertical-card",
  ".content-card",
  ".poster-container",
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
// Hotstar navigates without a full page reload. Watch for href changes and
// re-process cards once the new page's content has had time to render.

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

/**
 * Returns all card elements found on the page.
 * Tries each selector in turn; uses the first one that yields results.
 * Falls back to any anchor/container that wraps a poster image.
 */
function findCards() {
  for (const selector of CARD_SELECTORS) {
    const cards = document.querySelectorAll(selector);
    if (cards.length > 0) return cards;
  }

  // Broad fallback: any element containing a poster image inside a link.
  const allImages = document.querySelectorAll("a img[alt]");
  const cardSet = new Set();
  for (const img of allImages) {
    const card =
      img.closest("[data-testid]") ||
      img.closest("article") ||
      img.closest("li") ||
      img.parentElement?.parentElement;
    if (card) cardSet.add(card);
  }
  return cardSet;
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
 * Extracts the title from a Hotstar card using multiple strategies:
 *  1. [data-testid="action"] aria-label — format: "Title, Show type"
 *  2. [data-testid="title"] / [data-testid="content-title"] text content
 *  3. aria-label on the card's anchor link (split on comma)
 *  4. img alt text on the poster image
 *  5. Visible heading text inside the card
 */
function extractTitle(card) {
  // Strategy 1: action element aria-label ("Title, Genre/Type")
  const actionEl = card.querySelector("[data-testid='action']");
  if (actionEl) {
    const label =
      actionEl.getAttribute("aria-label") ||
      actionEl.getAttribute("title");
    if (label && label.trim()) {
      return parseTitle(label.split(",")[0].trim());
    }
  }

  // Strategy 2: dedicated title testid elements
  const titleEl =
    card.querySelector("[data-testid='title']") ||
    card.querySelector("[data-testid='content-title']");
  if (titleEl && titleEl.textContent.trim()) {
    return parseTitle(titleEl.textContent.trim());
  }

  // Strategy 3: card is or contains an anchor with aria-label
  const link = card.tagName === "A" ? card : card.querySelector("a[aria-label]");
  if (link) {
    const label = link.getAttribute("aria-label");
    if (label && label.trim()) {
      return parseTitle(label.split(",")[0].trim());
    }
  }

  // Strategy 4: poster image alt text
  const img = card.querySelector("img[alt]");
  if (img) {
    const alt = img.getAttribute("alt");
    if (alt && alt.length > 1 && alt.toLowerCase() !== "poster") {
      return parseTitle(alt);
    }
  }

  // Strategy 5: heading or element with "title" in its class name
  const heading = card.querySelector("h3, h4, [class*='title']");
  if (heading && heading.textContent.trim()) {
    return parseTitle(heading.textContent.trim());
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
  if (!rating || rating === "N/A") return;

  card.setAttribute(RATING_DATA_ATTR, rating);

  injectBadges(card, data, title);
  applyThresholdToCard(card);
}

function injectBadges(card, data, title) {
  const currentPosition = getComputedStyle(card).position;
  if (currentPosition === "static") {
    card.style.position = "relative";
  }

  const wrapper = buildBadgeWrapper(data, title);
  card.appendChild(wrapper);
}

// ── Badge Builder ─────────────────────────────────────────────────────────────

function buildBadgeWrapper(data, title) {
  const wrapper = document.createElement("div");
  wrapper.className = "sr-badge-wrapper";

  wrapper.appendChild(buildImdbBadge(data, title));

  return wrapper;
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
