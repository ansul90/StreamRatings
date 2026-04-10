/**
 * StreamRatings — Watchlist Page Script
 *
 * Loads the watchlist from chrome.storage.local (via service worker),
 * renders a sortable/searchable/filterable table, supports row removal
 * and CSV export.
 */

const searchInput    = document.getElementById("search-input");
const sortSelect     = document.getElementById("sort-select");
const filterPlatform = document.getElementById("filter-platform");
const filterGenre    = document.getElementById("filter-genre");
const exportBtn      = document.getElementById("export-btn");
const contentEl      = document.getElementById("content");
const headerCount    = document.getElementById("header-count");
const resultCount    = document.getElementById("result-count");

let allItems = [];

// ── Bootstrap ──────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: "GET_WATCHLIST" }, (items) => {
  allItems = items || [];
  populateGenreFilter();
  render();
});

// ── Reactivity ─────────────────────────────────────────────────────────────────

searchInput.addEventListener("input", render);
sortSelect.addEventListener("change", render);
filterPlatform.addEventListener("change", render);
filterGenre.addEventListener("change", render);

// ── Genre filter population ────────────────────────────────────────────────────

function populateGenreFilter() {
  const genreSet = new Set();
  for (const item of allItems) {
    if (item.genre && item.genre !== "N/A") {
      for (const g of item.genre.split(",")) {
        const trimmed = g.trim();
        if (trimmed) genreSet.add(trimmed);
      }
    }
  }

  const sorted = [...genreSet].sort();
  // Keep the "All Genres" option, replace the rest
  filterGenre.innerHTML = '<option value="">All Genres</option>';
  for (const g of sorted) {
    const opt = document.createElement("option");
    opt.value = g;
    opt.textContent = g;
    filterGenre.appendChild(opt);
  }
}

// ── Core render ────────────────────────────────────────────────────────────────

function render() {
  const query    = searchInput.value.trim().toLowerCase();
  const sortKey  = sortSelect.value;
  const platform = filterPlatform.value;
  const genre    = filterGenre.value;

  headerCount.textContent = `${allItems.length} title${allItems.length !== 1 ? "s" : ""}`;

  let filtered = allItems.filter((e) => {
    if (platform && e.platform !== platform) return false;
    if (genre && !(e.genre && e.genre.split(",").map(g => g.trim()).includes(genre))) return false;
    if (query && !e.title.toLowerCase().includes(query)) return false;
    return true;
  });

  filtered = sortItems(filtered, sortKey);

  resultCount.textContent = filtered.length !== allItems.length
    ? `Showing ${filtered.length} of ${allItems.length}`
    : "";

  if (allItems.length === 0) {
    contentEl.innerHTML = `
      <div class="state-msg">
        <div class="state-icon">☆</div>
        <p>Your watchlist is empty.</p>
        <p class="state-hint">Click the ☆ button on any Netflix card to save a title here.</p>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    contentEl.innerHTML = `
      <div class="state-msg">
        <div class="state-icon">&#128269;</div>
        <p>No titles match your search.</p>
      </div>`;
    return;
  }

  const tbody = filtered.map(buildRow).join("");

  contentEl.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th data-sort="title-asc" data-sort-alt="title-desc">Title</th>
            <th data-sort="rating-desc" data-sort-alt="rating-asc">IMDb</th>
            <th>RT</th>
            <th>Genre</th>
            <th>Platform</th>
            <th data-sort="date-desc" data-sort-alt="date-asc">Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;

  markSortHeader(sortKey);

  // Column header click to sort
  contentEl.querySelectorAll("th[data-sort]").forEach((th) => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const current = sortSelect.value;
      const primary = th.dataset.sort;
      const alt     = th.dataset.sortAlt;
      sortSelect.value = current === primary ? alt : primary;
      render();
    });
  });

  // Remove buttons
  contentEl.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const imdbID = btn.dataset.imdbid;
      await chrome.runtime.sendMessage({ type: "REMOVE_FROM_WATCHLIST", imdbID });
      allItems = allItems.filter((e) => e.imdbID !== imdbID);
      render();
    });
  });
}

// ── Row builder ────────────────────────────────────────────────────────────────

function buildRow(entry) {
  const imdbUrl = entry.imdbID
    ? `https://www.imdb.com/title/${entry.imdbID}/`
    : `https://www.imdb.com/find/?q=${encodeURIComponent(entry.title)}`;

  const ratingClass = imdbColorClass(entry.imdbRating);
  const ratingLabel = entry.imdbRating && entry.imdbRating !== "N/A"
    ? `★ ${entry.imdbRating}`
    : "N/A";

  const rtLabel = entry.tomatoMeter && entry.tomatoMeter !== "N/A"
    ? `🍅 ${entry.tomatoMeter}%`
    : "—";

  const rtClass = entry.tomatoMeter && entry.tomatoMeter !== "N/A"
    ? (parseInt(entry.tomatoMeter, 10) >= 60 ? "rt-fresh" : "rt-rotten")
    : "";

  const typeMeta = [entry.type, entry.year]
    .filter((v) => v && v !== "unknown" && v !== "N/A")
    .join(" · ");

  const platform  = entry.platform || "";
  const dateLabel = entry.addedAt ? formatDate(entry.addedAt) : "—";

  const genreChips = entry.genre && entry.genre !== "N/A"
    ? entry.genre.split(",").map(g =>
        `<span class="genre-chip">${escapeHtml(g.trim())}</span>`
      ).join("")
    : "—";

  return `
    <tr>
      <td class="td-title">
        <a href="${imdbUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.title)}</a>
        ${typeMeta ? `<div class="td-meta">${escapeHtml(typeMeta)}</div>` : ""}
      </td>
      <td>
        <span class="rating-chip ${ratingClass}">${ratingLabel}</span>
      </td>
      <td>
        <span class="rt-score ${rtClass}">${rtLabel}</span>
      </td>
      <td class="td-genre">${genreChips}</td>
      <td>
        ${platform ? `<span class="platform-badge ${escapeHtml(platform)}">${escapeHtml(platform)}</span>` : "—"}
      </td>
      <td class="td-date">${dateLabel}</td>
      <td class="td-actions">
        <button class="remove-btn" data-imdbid="${escapeHtml(entry.imdbID || "")}" title="Remove from watchlist">✕</button>
      </td>
    </tr>`;
}

// ── Sorting ────────────────────────────────────────────────────────────────────

function sortItems(list, key) {
  return [...list].sort((a, b) => {
    switch (key) {
      case "date-desc":   return b.addedAt - a.addedAt;
      case "date-asc":    return a.addedAt - b.addedAt;
      case "rating-desc": return (parseFloat(b.imdbRating) || 0) - (parseFloat(a.imdbRating) || 0);
      case "rating-asc":  return (parseFloat(a.imdbRating) || 0) - (parseFloat(b.imdbRating) || 0);
      case "title-asc":   return a.title.localeCompare(b.title);
      case "title-desc":  return b.title.localeCompare(a.title);
      default:            return 0;
    }
  });
}

function markSortHeader(sortKey) {
  contentEl.querySelectorAll("th[data-sort]").forEach((th) => {
    const isActive = th.dataset.sort === sortKey || th.dataset.sortAlt === sortKey;
    th.classList.toggle("sort-active", isActive);
    const arrow = isActive
      ? (sortKey.endsWith("-asc") ? " ▲" : " ▼")
      : "";
    const base = th.textContent.replace(/ [▲▼]$/, "");
    th.textContent = base + arrow;
  });
}

// ── CSV Export ─────────────────────────────────────────────────────────────────

exportBtn.addEventListener("click", () => {
  if (allItems.length === 0) return;

  const header = ["Title", "Year", "Type", "Genre", "IMDb Rating", "RT Score", "Platform", "Added", "IMDb URL"];
  const rows = allItems.map((e) => [
    `"${(e.title || "").replace(/"/g, '""')}"`,
    e.year     || "",
    e.type     || "",
    e.genre    || "",
    e.imdbRating  || "",
    e.tomatoMeter || "",
    e.platform    || "",
    e.addedAt ? new Date(e.addedAt).toISOString().split("T")[0] : "",
    e.imdbID ? `https://www.imdb.com/title/${e.imdbID}/` : "",
  ]);

  const csv  = [header, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "streamratings-watchlist.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function imdbColorClass(rating) {
  const score = parseFloat(rating);
  if (isNaN(score)) return "sr-na";
  if (score >= 7.5) return "sr-green";
  if (score >= 6.0) return "sr-yellow";
  return "sr-red";
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
