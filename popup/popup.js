/**
 * StreamRatings — Popup Script
 *
 * Handles API key save/validation, rating threshold, and cache clearing.
 */

const apiKeyInput = document.getElementById("api-key-input");
const saveBtn = document.getElementById("save-btn");
const statusMsg = document.getElementById("status-msg");
const clearCacheBtn = document.getElementById("clear-cache-btn");
const thresholdSlider = document.getElementById("threshold-slider");
const thresholdDisplay = document.getElementById("threshold-display");

// ── Load saved settings on open ───────────────────────────────────────────────

chrome.storage.sync.get(["omdbApiKey", "ratingThreshold"], (result) => {
  if (result.omdbApiKey) {
    apiKeyInput.value = result.omdbApiKey;
    showStatus("Key saved.", "success");
  }

  const threshold = result.ratingThreshold || 0;
  thresholdSlider.value = threshold;
  updateThresholdDisplay(threshold);
});

// ── Save & validate ───────────────────────────────────────────────────────────

saveBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    showStatus("Please enter an API key.", "error");
    return;
  }

  saveBtn.disabled = true;
  showStatus("Validating…", "loading");

  const response = await chrome.runtime.sendMessage({
    type: "VALIDATE_API_KEY",
    apiKey,
  });

  saveBtn.disabled = false;

  if (response && response.valid) {
    await chrome.storage.sync.set({ omdbApiKey: apiKey });
    showStatus("Key saved and verified!", "success");
  } else {
    showStatus("Invalid key — check and retry.", "error");
  }
});

apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});

// ── Rating Threshold Slider ───────────────────────────────────────────────────

let thresholdDebounce = null;

thresholdSlider.addEventListener("input", () => {
  const value = parseFloat(thresholdSlider.value);
  updateThresholdDisplay(value);

  clearTimeout(thresholdDebounce);
  thresholdDebounce = setTimeout(async () => {
    await chrome.storage.sync.set({ ratingThreshold: value });
    chrome.runtime.sendMessage({
      type: "THRESHOLD_CHANGED",
      threshold: value,
    });
  }, 150);
});

function updateThresholdDisplay(value) {
  if (value === 0) {
    thresholdDisplay.innerHTML = '<span class="threshold-off">OFF</span>';
  } else {
    thresholdDisplay.textContent = value.toFixed(1);
  }
}

// ── Clear cache ───────────────────────────────────────────────────────────────

clearCacheBtn.addEventListener("click", async () => {
  const allItems = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(allItems).filter((k) =>
    k.startsWith("sr_cache_")
  );

  if (cacheKeys.length === 0) {
    showStatus("Cache is already empty.", "loading");
    return;
  }

  await chrome.storage.local.remove(cacheKeys);
  showStatus(`Cleared ${cacheKeys.length} cached ratings.`, "success");
});

// ── Watchlist launcher ────────────────────────────────────────────────────────

const watchlistCount  = document.getElementById("watchlist-count");
const openWatchlistBtn = document.getElementById("open-watchlist-btn");

chrome.runtime.sendMessage({ type: "GET_WATCHLIST" }, (items) => {
  const count = (items || []).length;
  watchlistCount.textContent = count;
});

openWatchlistBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("watchlist/watchlist.html") });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function showStatus(message, type) {
  statusMsg.textContent = message;
  statusMsg.className = `status ${type}`;
}
