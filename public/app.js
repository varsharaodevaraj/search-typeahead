'use strict';

/**
 * Frontend logic:
 *   - debounced /suggest calls (one request per pause, not per keystroke)
 *   - a stale-response guard so a slow old request can't overwrite a newer one
 *   - keyboard navigation (↑ ↓ Enter Esc)
 *   - submit → POST /search → show the dummy response → refresh trending/stats
 *   - live trending + stats panels
 */

const DEBOUNCE_MS = 180;
const MIN_PREFIX = 2;

const $q = document.getElementById('q');
const $go = document.getElementById('go');
const $dropdown = document.getElementById('dropdown');
const $status = document.getElementById('status');
const $result = document.getElementById('result');
const $trending = document.getElementById('trending');

let mode = 'trending';
let debounceTimer = null;
let latestReq = 0; // monotonic id → stale-response guard
let items = []; // current suggestions
let active = -1; // highlighted index

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- suggestions dropdown ----------
function renderDropdown(prefix) {
  if (!items.length) {
    $dropdown.innerHTML = '<li class="muted">no matches</li>';
    $dropdown.hidden = false;
    return;
  }
  const plen = prefix.length;
  $dropdown.innerHTML = items
    .map((it, i) => {
      const full = escapeHtml(it.query);
      const head = `<span class="match">${escapeHtml(it.query.slice(0, plen))}</span>${escapeHtml(it.query.slice(plen))}`;
      return `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}">
        <span class="q">${plen ? head : full}</span>
        <span class="c">${it.count.toLocaleString()}${it.score != null ? ' · ' + it.score : ''}</span>
      </li>`;
    })
    .join('');
  $dropdown.hidden = false;
}

function closeDropdown() {
  $dropdown.hidden = true;
  active = -1;
}

function setStatus(data, ms) {
  const cls = data.cache === 'hit' ? 'hit' : 'miss';
  $status.innerHTML =
    `${data.count} result(s) · <span class="pill ${cls}">${data.cache.toUpperCase()}</span>` +
    `<span class="pill">node: ${data.node}</span><span class="pill">${ms.toFixed(1)} ms</span>`;
}

async function fetchSuggest(value) {
  const myReq = ++latestReq;
  $status.textContent = 'searching…';
  const t0 = performance.now();
  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(value)}&mode=${mode}`);
    const data = await res.json();
    if (myReq !== latestReq) return; // a newer keystroke already won
    items = data.suggestions || [];
    active = -1;
    renderDropdown(value.trim().toLowerCase());
    setStatus(data, performance.now() - t0);
  } catch {
    if (myReq !== latestReq) return;
    $status.innerHTML = '<span class="err">could not reach the server</span>';
    closeDropdown();
  }
}

// ---------- input (debounced) ----------
$q.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const v = $q.value.trim();
  if (v.length < MIN_PREFIX) {
    latestReq++; // invalidate anything in flight
    closeDropdown();
    $status.textContent = '';
    return;
  }
  debounceTimer = setTimeout(() => fetchSuggest($q.value), DEBOUNCE_MS);
});

// ---------- keyboard navigation ----------
$q.addEventListener('keydown', (e) => {
  if ($dropdown.hidden || !items.length) {
    if (e.key === 'Enter') submitSearch($q.value);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    active = (active + 1) % items.length;
    renderDropdown($q.value.trim().toLowerCase());
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    active = (active - 1 + items.length) % items.length;
    renderDropdown($q.value.trim().toLowerCase());
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const chosen = active >= 0 ? items[active].query : $q.value;
    $q.value = chosen;
    submitSearch(chosen);
  } else if (e.key === 'Escape') {
    closeDropdown();
  }
});

$dropdown.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const it = items[Number(li.dataset.i)];
  $q.value = it.query;
  submitSearch(it.query);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.box')) closeDropdown();
});

// ---------- submit (write path) ----------
async function submitSearch(value) {
  const query = (value || '').trim();
  if (!query) return;
  closeDropdown();
  $result.textContent = 'submitting…';
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    $result.innerHTML =
      `Server says: <b>"${escapeHtml(data.message)}"</b> — recorded "${escapeHtml(data.query)}". ` +
      `Write is <i>batched</i>; rankings update within ~2s.`;
    setTimeout(() => { loadTrending(); loadStats(); }, 2300); // after the batch window
  } catch {
    $result.innerHTML = '<span class="err">search failed</span>';
  }
}
$go.addEventListener('click', () => submitSearch($q.value));

// ---------- mode toggle ----------
document.querySelectorAll('.mode').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    mode = btn.dataset.mode;
    if ($q.value.trim().length >= MIN_PREFIX) fetchSuggest($q.value);
  });
});

// ---------- panels ----------
async function loadTrending() {
  try {
    const data = await (await fetch('/trending?limit=10')).json();
    if (!data.trending.length) {
      $trending.innerHTML = '<li class="muted">no activity yet — submit a search</li>';
      return;
    }
    $trending.innerHTML = data.trending
      .map((t, i) => `<li data-q="${escapeHtml(t.query)}">
        <span><span class="rank">${i + 1}</span>${escapeHtml(t.query)}</span>
        <span class="score">${t.score != null ? '▲ ' + t.score : t.count.toLocaleString()}</span>
      </li>`)
      .join('');
  } catch {
    $trending.innerHTML = '<li class="err">failed to load</li>';
  }
}
$trending.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-q]');
  if (!li) return;
  $q.value = li.dataset.q;
  fetchSuggest(li.dataset.q);
  $q.focus();
});

async function loadStats() {
  try {
    const d = await (await fetch('/stats')).json();
    document.getElementById('st-rows').textContent = d.dbRows.toLocaleString();
    document.getElementById('st-hit').textContent =
      d.cache.hitRate != null ? (d.cache.hitRate * 100).toFixed(1) + '%' : '–';
    document.getElementById('st-p95').textContent =
      d.suggest.latencyMs.p95 != null ? d.suggest.latencyMs.p95 + ' ms' : '–';
    document.getElementById('st-wr').textContent =
      d.batch.writeReduction != null ? d.batch.writeReduction + '×' : '–';
    const up = Object.values(d.cache.perNode).filter((n) => n.status === 'up').length;
    document.getElementById('st-nodes').textContent = `${up}/${Object.keys(d.cache.perNode).length} up`;
  } catch {
    /* leave the dashes */
  }
}

// initial load + periodic refresh
loadTrending();
loadStats();
setInterval(() => { loadTrending(); loadStats(); }, 5000);
