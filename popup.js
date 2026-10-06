'use strict';

/**
 * Renders browsing history as a flat, reverse-chronological list.
 *
 * Three views share one list element and one row renderer:
 *
 *   all      chrome.history.search  - everything, grouped under date headings
 *   closed   chrome.sessions.getRecentlyClosed - tabs and windows just closed
 *   devices  chrome.sessions.getDevices - open tabs on other signed-in devices
 *
 * Each view produces the same row shape, so switching views only changes where
 * the data comes from and how it is grouped.
 */

const listEl = document.getElementById('list');
const queryEl = document.getElementById('q');
const tabsEl = document.querySelector('.tabs');
const menuEl = document.getElementById('menu');
const moreBtn = document.getElementById('more');
const clearBtn = document.getElementById('clear');

/** How many history entries to request. Chrome caps this internally anyway. */
const MAX_RESULTS = 1000;

/** How many recently closed sessions to request. Chrome's own cap is 25. */
const MAX_SESSIONS = 25;

/** Wait this long after the last keystroke before searching again. */
const SEARCH_DEBOUNCE_MS = 150;

/** Which view is showing: 'all', 'closed', or 'devices'. */
let currentView = 'all';

// Invalidate outstanding callbacks whenever the view or search changes.
let requestGeneration = 0;

// Both formatters follow the browser locale rather than a fixed one, so dates
// and times match what the rest of the UI shows.
const dayFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
});
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/* ---------- Formatting helpers ---------- */

/**
 * Identifies the calendar day a timestamp falls on, in local time.
 * Used to decide where one date group ends and the next begins.
 */
function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Heading text for a date group: "Today", "Yesterday", or the full date. */
function dayLabel(timestamp) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const key = dayKey(timestamp);
  if (key === dayKey(today)) return 'Today';
  if (key === dayKey(yesterday)) return 'Yesterday';
  return dayFormat.format(new Date(timestamp));
}

/**
 * Builds a URL for Chrome's built-in favicon service, which serves icons the
 * browser has already cached. Requires the "favicon" permission.
 */
function faviconURL(pageUrl) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.toString();
}

/** Hostname without the "www." prefix, shown as the subtitle of each row. */
function displayHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    // Not every entry is a parseable URL (e.g. "about:blank").
    return rawUrl;
  }
}

/** Case-insensitive match against title and URL, for client-side filtering. */
function matchesQuery(item, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (item.title || '').toLowerCase().includes(needle)
    || (item.url || '').toLowerCase().includes(needle);
}

/* ---------- Data shaping ---------- */

/**
 * Merges entries that point at the same URL into one row.
 *
 * Defensively deduplicate any repeated URLs. Keep the most recent visit
 * and carry the highest visit count.
 */
function collapseByURL(items) {
  const byURL = new Map();

  for (const item of items) {
    if (!item.url) continue;

    const existing = byURL.get(item.url);
    if (!existing) {
      byURL.set(item.url, { ...item });
      continue;
    }

    existing.visitCount = Math.max(existing.visitCount || 1, item.visitCount || 1);

    // A later visit wins, and brings its title along — pages get retitled.
    if ((item.lastVisitTime || 0) > (existing.lastVisitTime || 0)) {
      existing.lastVisitTime = item.lastVisitTime;
      existing.title = item.title || existing.title;
    }
  }

  return [...byURL.values()];
}

/**
 * Flattens a chrome.sessions session list into plain rows.
 *
 * A session is either a single tab or a window holding several tabs; both
 * carry the same lastModified timestamp, which is in seconds here rather than
 * the milliseconds chrome.history uses.
 */
function rowsFromSessions(sessions) {
  const rows = [];

  for (const session of sessions) {
    const when = (session.lastModified || 0) * 1000;

    if (session.tab) {
      rows.push({ url: session.tab.url, title: session.tab.title, lastVisitTime: when });
      continue;
    }

    for (const tab of session.window?.tabs || []) {
      rows.push({ url: tab.url, title: tab.title, lastVisitTime: when });
    }
  }

  return rows;
}

/* ---------- Rendering ---------- */

/** Builds one row. Returns an <a> so hover and focus behave natively. */
function buildRow(item) {
  const row = document.createElement('a');
  row.className = 'item';
  row.href = item.url;
  // The full title and URL are truncated in the row, so expose them on hover.
  row.title = `${item.title || item.url}\n${item.url}`;

  const favicon = document.createElement('img');
  favicon.className = 'fav';
  favicon.src = faviconURL(item.url);
  favicon.alt = '';
  // Hide rather than remove, so the row keeps its alignment.
  favicon.addEventListener('error', () => { favicon.style.visibility = 'hidden'; });

  const text = document.createElement('div');
  text.className = 'text';

  const title = document.createElement('div');
  title.className = 'title';
  // Untitled entries fall back to the URL so the row is never blank.
  title.textContent = item.title || item.url;

  const host = document.createElement('div');
  host.className = 'url';
  host.textContent = displayHost(item.url);

  text.append(title, host);
  row.append(favicon, text);

  // Only worth showing when a page was visited more than once.
  if (item.visitCount > 1) {
    const visits = document.createElement('span');
    visits.className = 'visits';
    visits.textContent = String(item.visitCount);
    visits.title = `${item.visitCount} visits`;
    row.append(visits);
  }

  if (item.lastVisitTime > 0) {
    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = timeFormat.format(new Date(item.lastVisitTime));
    row.append(time);
  }

  return row;
}

/** Replaces the list with a single centered message. */
function showMessage(text) {
  listEl.textContent = '';
  const message = document.createElement('div');
  message.className = 'empty';
  message.textContent = text;
  listEl.append(message);
}

/**
 * Renders rows into the list.
 *
 * `groupByDay` is off for views whose own headings already carry the context
 * (a device name, say), where a second level of date headings would only add
 * noise.
 */
function renderRows(items, { groupByDay = true, emptyText = 'No history found' } = {}) {
  listEl.textContent = '';

  if (items.length === 0) {
    showMessage(emptyText);
    return;
  }

  // Build off-document, then attach once, to avoid reflow per row.
  const fragment = document.createDocumentFragment();
  let currentDay = null;

  for (const item of items) {
    if (groupByDay) {
      // Items are already sorted, so a new day starts where the key changes.
      const key = dayKey(item.lastVisitTime);
      if (key !== currentDay) {
        currentDay = key;
        const heading = document.createElement('div');
        heading.className = 'day';
        heading.textContent = dayLabel(item.lastVisitTime);
        fragment.append(heading);
      }
    }
    fragment.append(buildRow(item));
  }

  listEl.append(fragment);

  // Stagger animation: each row fades in a bit later than the previous one.
  // Cap the stagger so long lists don't take forever to settle.
  const animated = listEl.querySelectorAll('.day, a.item');
  const MAX_STAGGER = 15;
  animated.forEach((el, i) => {
    if (i < MAX_STAGGER) {
      el.style.animationDelay = `${i * 20}ms`;
    }
  });
}

/** Renders a labelled section: one heading followed by its rows. */
function renderSection(fragment, label, items) {
  const heading = document.createElement('div');
  heading.className = 'day';
  heading.textContent = label;
  fragment.append(heading);

  for (const item of items) fragment.append(buildRow(item));
}

/* ---------- Views ---------- */

/** All history, newest first, grouped by day. */
function loadAll(query, generation) {
  chrome.history.search(
    // startTime 0 means "no lower bound"; MAX_RESULTS does the limiting.
    { text: query, maxResults: MAX_RESULTS, startTime: 0 },
    (results) => {
      // Consume lastError even when an obsolete callback is discarded.
      const error = chrome.runtime.lastError;
      if (generation !== requestGeneration) return;
      if (error) {
        showMessage(error.message);
        return;
      }

      const items = collapseByURL(results)
        // Entries without a visit time would otherwise land under 1 Jan 1970.
        .filter((item) => item.lastVisitTime > 0)
        .sort((a, b) => b.lastVisitTime - a.lastVisitTime);

      renderRows(items, {
        emptyText: query ? 'No matching history' : 'No history found',
      });
    },
  );
}

/** Tabs and windows closed recently, newest first. */
function loadRecentlyClosed(query, generation) {
  chrome.sessions.getRecentlyClosed({ maxResults: MAX_SESSIONS }, (sessions) => {
    const error = chrome.runtime.lastError;
    if (generation !== requestGeneration) return;
    if (error) {
      showMessage(error.message);
      return;
    }

    // Sessions arrive newest first; filtering preserves that order.
    const items = rowsFromSessions(sessions)
      .filter((item) => item.url && matchesQuery(item, query));

    renderRows(items, {
      // These are all "just now" — day headings would say Today and nothing else.
      groupByDay: false,
      emptyText: query ? 'No matching tabs' : 'Nothing recently closed',
    });
  });
}

/** Open tabs on other signed-in devices, grouped by device. */
function loadDevices(query, generation) {
  chrome.sessions.getDevices(null, (devices) => {
    const error = chrome.runtime.lastError;
    if (generation !== requestGeneration) return;
    if (error) {
      showMessage(error.message);
      return;
    }

    listEl.textContent = '';
    const fragment = document.createDocumentFragment();
    let total = 0;

    for (const device of devices) {
      const items = rowsFromSessions(device.sessions)
        .filter((item) => item.url && matchesQuery(item, query));

      // Skip devices whose tabs were all filtered out by the search.
      if (items.length === 0) continue;

      renderSection(fragment, device.deviceName, items);
      total += items.length;
    }

    if (total === 0) {
      showMessage(query ? 'No matching tabs' : 'No tabs from other devices');
      return;
    }

    listEl.append(fragment);
  });
}

/** Loads whichever view is selected, applying the current search text. */
function load() {
  const generation = ++requestGeneration;
  const query = queryEl.value.trim();

  if (currentView === 'closed') loadRecentlyClosed(query, generation);
  else if (currentView === 'devices') loadDevices(query, generation);
  else loadAll(query, generation);
}

/* ---------- Tabs ---------- */

/** Placeholder text per view, so the search box says what it will filter. */
const SEARCH_PLACEHOLDER = {
  all: 'Search history',
  closed: 'Search recently closed',
  devices: 'Search tabs from other devices',
};

function selectView(view) {
  if (view === currentView) return;
  currentView = view;

  for (const tab of tabsEl.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }

  queryEl.placeholder = SEARCH_PLACEHOLDER[view];
  load();
}

tabsEl.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) selectView(tab.dataset.view);
});

// Left and right arrows move between tabs, as expected of a tablist.
tabsEl.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

  const tabs = [...tabsEl.querySelectorAll('.tab')];
  const index = tabs.indexOf(document.activeElement);
  if (index === -1) return;

  event.preventDefault();
  const step = event.key === 'ArrowRight' ? 1 : -1;
  const next = tabs[(index + step + tabs.length) % tabs.length];
  next.focus();
  selectView(next.dataset.view);
});

/* ---------- Overflow menu ---------- */

function setMenuOpen(open) {
  menuEl.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
}

moreBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  setMenuOpen(menuEl.hidden);
});

// Any click outside the menu dismisses it.
document.addEventListener('click', () => setMenuOpen(false));
menuEl.addEventListener('click', (event) => event.stopPropagation());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setMenuOpen(false);
});

menuEl.addEventListener('click', (event) => {
  const item = event.target.closest('.menu-item');
  if (!item) return;

  if (item.dataset.action === 'openHistoryPage') {
    chrome.tabs.create({ url: 'chrome://history' });
    window.close();
  }
});

/* ---------- Clear browsing data ---------- */

// Deliberately defers to Chrome's own dialog rather than deleting anything
// here: history deletion cannot be undone, and the native dialog lets the
// choice of range and data types be made deliberately.
clearBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://settings/clearBrowserData' });
  window.close();
});

/* ---------- Search ---------- */

// Debounced so that typing a word triggers one search, not one per letter.
let debounceTimer;
queryEl.addEventListener('input', () => {
  ++requestGeneration;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(load, SEARCH_DEBOUNCE_MS);
});

/* ---------- Opening rows ---------- */

// Anchors inside a popup do not navigate on their own, so open tabs manually.
// Modifier-click opens in the background and leaves the popup up, matching how
// links behave elsewhere in the browser.
listEl.addEventListener('click', (event) => {
  const row = event.target.closest('a.item');
  if (!row) return;

  event.preventDefault();
  const background = event.metaKey || event.ctrlKey;
  chrome.tabs.create({ url: row.href, active: !background });
  if (!background) window.close();
});

// Middle-click is the other conventional "open in background" gesture.
listEl.addEventListener('auxclick', (event) => {
  if (event.button !== 1) return;

  const row = event.target.closest('a.item');
  if (!row) return;

  event.preventDefault();
  chrome.tabs.create({ url: row.href, active: false });
});

/* ---------- Start ---------- */

load();
