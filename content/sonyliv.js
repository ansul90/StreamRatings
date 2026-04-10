/**
 * StreamRatings — SonyLIV Content Script
 *
 * Responsibilities:
 *  - Observe SonyLIV's dynamically rendered DOM for movie/show cards
 *  - Extract titles from cards
 *  - Request ratings from the background service worker
 *  - Inject color-coded IMDb badge with hover tooltip onto each card
 *  - Grey-out cards below a user-defined IMDb rating threshold
 *
 * SonyLIV is a React SPA — navigating between pages does not reload the
 * document. A second MutationObserver watches for URL changes and re-runs
 * card discovery after a short delay to let new content render.
 *
 * Card selectors are derived from real SonyLIV DOM structure. The site uses
 * stable CSS class names (portrait-link, trending-tray-link, etc.) on anchor
 * elements, which is more reliable than data-testid for this platform.
 *
 * Sports pages (/custompage/sports) contain no rateable content and are
 * skipped entirely to avoid unnecessary API calls.
 */

// ── Card Selectors ────────────────────────────────────────────────────────────
//
// SonyLIV has two distinct page layouts:
//
// 1. My List / listing pages (/usercenter/mylist, /custompage/mylist-*):
//    Cards are bare <a href="/movies/..." > or <a href="/shows/..."> anchors
//    with no class, no aria-label, no title. The visible title text lives in
//    the SIBLING div.show-container, not inside the anchor.
//    Best approach: parse title from the href slug.
//
// 2. Home / movies / shows pages:
//    Cards are <a class="portrait-link">, <a class="trending-tray-link">, etc.
//    with aria-label or title attributes carrying the title.

const CARD_SELECTORS = [
  // My List and listing pages — bare anchors with no class
  "div.innermylist a[href^='/movies']",
  "div.innermylist a[href^='/shows']",
  "div.mylist_contentData a[href^='/movies']",
  "div.mylist_contentData a[href^='/shows']",
  "div.listinpage_wrapper a[href^='/movies']",
  "div.listinpage_wrapper a[href^='/shows']",
  // Standard portrait/landscape/trending cards (home, movies, shows pages)
  "a.trending-tray-link",
  "a.portrait-link",
  "a.landscape-link",
  "a.multipurpose-portrait-link",
  // Mobile web portrait tray cards
  "a.link_container",
  // Sony Originals block (search page)
  "div.sonyliv-original-block-wrap",
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
// SonyLIV navigates without a full page reload. Watch for href changes and
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

/**
 * Returns all rateable card elements on the current page.
 * Sports pages are skipped — they contain live match tiles, not movies/shows.
 */
function findCards() {
  if (location.pathname.includes("/custompage/sports")) {
    return [];
  }

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
 * Extracts the title from a SonyLIV card using multiple strategies.
 *
 * SonyLIV anchor elements expose the title via aria-label or title attributes.
 * Different card types (portrait, landscape, originals, search) each have a
 * slightly different DOM shape, so we try several fallbacks.
 */
function extractTitle(card) {
  // Strategy 1: sibling div.show-container holds the visible title text
  // (My List page: <a href="/movies/..."> followed by <div class="show-container ...">)
  const sibling = card.nextElementSibling;
  if (sibling && sibling.classList.contains("show-container")) {
    const text = sibling.textContent.trim();
    if (text) return parseTitle(text);
  }

  // Strategy 2: aria-label on the card element (portrait/trending/landscape cards)
  const ariaLabel = card.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) {
    return parseTitle(ariaLabel.trim());
  }

  // Strategy 3: title attribute on the card element
  const titleAttr = card.getAttribute("title");
  if (titleAttr && titleAttr.trim()) {
    return parseTitle(titleAttr.trim());
  }

  // Strategy 4: poster image title attribute (portrait/trending cards)
  const imgWithTitle = card.querySelector("img[title]:not([title='Premium Icon'])");
  if (imgWithTitle) {
    const t = imgWithTitle.getAttribute("title");
    if (t && t.trim()) return parseTitle(t.trim());
  }

  // Strategy 5: visible show title heading (landscape-link cards)
  const showTitle = card.querySelector("h4.c-show-title");
  if (showTitle && showTitle.textContent.trim()) {
    return parseTitle(showTitle.textContent.trim());
  }

  // Strategy 6: Sony Originals block heading (search page)
  const originalsHeading = card.querySelector("div.sonyliv-original-right-sec > h2");
  if (originalsHeading && originalsHeading.textContent.trim()) {
    return parseTitle(originalsHeading.textContent.trim());
  }

  // Strategy 7: parse title from href slug — most reliable for listing pages
  // e.g. /movies/love-story-1500004454 → "love story"
  const href = card.getAttribute("href");
  if (href) {
    const slug = href.split("/").pop() || "";
    const cleaned = slug
      .replace(/-\d{7,}$/, "")  // strip trailing long numeric ID (≥7 digits)
      .replace(/-/g, " ")
      .trim();
    if (cleaned) return parseTitle(cleaned);
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
  // For My List cards, the anchor only wraps the image div and has no
  // position context by default. Make the inner image div the positioning
  // parent so the badge overlays the thumbnail correctly.
  const innerDiv = card.querySelector(
    "div.listing-landscape-card-inner-div, div.mylist-landscape-card-main-div"
  );
  const positionTarget = innerDiv || card;

  if (getComputedStyle(positionTarget).position === "static") {
    positionTarget.style.position = "relative";
  }

  const wrapper = buildBadgeWrapper(data, title);

  // Sony Originals blocks have a specific insertion point
  if (card.matches("div.sonyliv-original-block-wrap")) {
    const titleNode = card.querySelector("div.sonyliv-original-right-sec > h2");
    if (titleNode) {
      titleNode.insertAdjacentElement("afterend", wrapper);
    } else {
      positionTarget.appendChild(wrapper);
    }
  } else {
    positionTarget.appendChild(wrapper);
  }

  // Ribbon always goes on card itself (top-left corner of the card element)
  if (getComputedStyle(card).position === "static") {
    card.style.position = "relative";
  }
  card.appendChild(buildBookmarkRibbon(data, title));
}

// ── Badge Builder ─────────────────────────────────────────────────────────────

function buildBadgeWrapper(data, title) {
  const wrapper = document.createElement("div");
  wrapper.className = "sr-badge-wrapper";

  wrapper.appendChild(buildImdbBadge(data, title));

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
      platform: "sonyliv",
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
