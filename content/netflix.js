/**
 * StreamRatings — Netflix Content Script
 *
 * Responsibilities:
 *  - Observe Netflix's dynamically rendered DOM for movie/show cards
 *  - Extract titles from cards
 *  - Request ratings from the background service worker
 *  - Inject color-coded IMDB + RT/Metacritic badges onto each card
 *  - Show a rich hover tooltip with IMDb votes, genre, runtime, etc.
 *  - Grey-out cards below a user-defined IMDb rating threshold
 *
 * Netflix renders cards lazily as the user scrolls, so we use a
 * MutationObserver to catch new cards as they are added to the DOM.
 */

// ── Selectors ─────────────────────────────────────────────────────────────────

const SELECTORS = {
  card: ".title-card-container",
  cardLink: ".title-card-container a[aria-label]",
  cardImage: ".title-card-container img[alt]",
  sliderContent: ".sliders-viewport, .lolomoRow",
};

const BADGE_ATTR = "data-sr-injected";
const RATING_DATA_ATTR = "data-sr-imdb-rating";

let currentThreshold = 0; // 0 = no filtering

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

// ── MutationObserver Setup ────────────────────────────────────────────────────

let observerDebounceTimer = null;

const observer = new MutationObserver(() => {
  clearTimeout(observerDebounceTimer);
  observerDebounceTimer = setTimeout(processNewCards, 300);
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

processNewCards();

// ── Card Processing ───────────────────────────────────────────────────────────

function processNewCards() {
  const cards = document.querySelectorAll(SELECTORS.card);

  for (const card of cards) {
    if (card.getAttribute(BADGE_ATTR)) continue;

    const parsed = extractTitle(card);
    if (!parsed) continue;

    card.setAttribute(BADGE_ATTR, "pending");
    fetchAndInjectRating(card, parsed.title, parsed.year);
  }
}

// ── Title Extraction ──────────────────────────────────────────────────────────

function extractTitle(card) {
  const link = card.querySelector("a[aria-label]");
  if (link) {
    const label = link.getAttribute("aria-label");
    if (label) return parseTitle(label);
  }

  const img = card.querySelector("img[alt]");
  if (img) {
    const alt = img.getAttribute("alt");
    if (alt) return parseTitle(alt);
  }

  return null;
}

function parseTitle(raw) {
  const yearMatch = raw.match(/\((\d{4})\)$/);
  const year = yearMatch ? yearMatch[1] : null;
  const title = raw
    .replace(/:\s*season\s*\d+.*/i, "")
    .replace(/\s*\(\d{4}\)$/, "")
    .trim();
  return { title, year };
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
  const cards = document.querySelectorAll(SELECTORS.card);
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
