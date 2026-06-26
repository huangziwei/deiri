// Finder-shaped browser UI. All backend calls go through `window.api`
// (defined in api.js). No build step — this file is served as-is by Tauri.

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
};

const deviceChip = $("device-chip");
const deviceChipLabel = $("device-chip-label");
const deviceChipChevron = $("device-chip-chevron");
const deviceRenameInput = $("device-rename");
const deviceMenu = $("device-menu");
const breadcrumbEl = $("breadcrumb");
const pathBar = document.querySelector(".path-bar");
const statusEl = $("status");
const newFolderBtn = $("new-folder-btn");
const listContainer = $("list-container");
const listEl = $("list");
const listBody = $("list-body");
const gridEl = $("grid");
const emptyEl = $("empty");
const dropzone = $("dropzone-overlay");
const contextMenu = $("context-menu");
const navBackBtn = $("nav-back");
const navForwardBtn = $("nav-forward");
const filterPillsEl = $("filter-pills");
const viewListBtn = $("view-list");
const viewGridBtn = $("view-grid");
const searchInput = $("search-input");
const searchStrip = $("search-strip");
const searchStatusEl = $("search-status");
const searchCancelBtn = $("search-cancel");
const searchHelpBtn = $("search-help-btn");
const searchHelp = $("search-help");
const shortcutsHelp = $("shortcuts-help");
const shortcutsClose = $("shortcuts-close");
const conflictDialog = $("conflict-dialog");
const conflictMessage = $("conflict-message");
const conflictHint = $("conflict-hint");
const conflictApplyRow = $("conflict-apply");
const conflictApplyAll = $("conflict-apply-all");
const conflictApplyCount = $("conflict-apply-count");
const conflictReplaceBtn = $("conflict-replace");
const conflictMergeBtn = $("conflict-merge");
const conflictKeepBtn = $("conflict-keep");
const conflictSkipBtn = $("conflict-skip");
const conflictCancelBtn = $("conflict-cancel");
const conflictCloseBtn = $("conflict-close");

// ---------------------------------------------------------------------------
// App state

let openDeviceId = null;
// Search state (see the Search section). `currentFolderQuery` drives the live
// current-folder filter; the rest back Everywhere (recursive) results.
let currentFolderQuery = null;
let searchResultMode = false;
let searchResults = [];
let activeSearch = null;
let cwd = ""; // device-relative, no leading slash
// `allEntries` is the full listing from the device; `entries` is the
// filtered-and-sorted view that's actually rendered and index-addressed (so
// selection, shift-range, ⌘A, etc. all operate on what's visible). `entries`
// is derived from `allEntries` via the active format pills — see applyFilter.
let allEntries = [];
let entries = [];
let sortKey = "name";
let sortDir = "asc";
let viewMode = "list"; // "list" or "grid"

// Active format-filter pills (lowercased extensions; "" = no-extension files).
// Empty set means "show everything". Reset on navigation. See renderFilterPills.
const activeFilters = new Set();

// Finder-style back/forward navigation. `navHistory` is the stack of visited
// cwd values; `navIndex` points at the current one. New navigation truncates
// any forward entries and pushes; the arrows just move the index. Seeded with
// [""] when a device opens, emptied when it closes (see openDevice / clearOpenDevice).
let navHistory = [];
let navIndex = -1;

// Latest storage readout, folded into the bottom status bar alongside the
// item/selection count. Kept as a string so updateStatusBar can combine them.
let storageText = "";

// Bumped on every render so chunked-build pumps can detect that the user
// switched view mode or folder and bail mid-stream. Thumbnails themselves
// are now <img src="thumb://..."> — the WebView's URL scheme handler talks
// to the Rust side directly (see app/src-tauri/src/thumb_protocol.rs), with
// a disk-backed cache and native lazy-loading driving the work.
let renderGen = 0;

// Selection. Holds device-relative paths (`cwd` + name) so it's stable
// across re-renders. Cleared on every refreshList — selection only lives
// inside the current directory listing.
const selected = new Set();
// Two indices into the rendered `entries`, Finder-style: `anchorIndex` is the
// fixed end of a Shift range; `cursorIndex` is the lead — the focused row that
// arrow keys move from. Both are -1 with no selection, and both reset alongside
// `selected` on every refreshList. See onRowClick / moveSelection.
let anchorIndex = -1;
let cursorIndex = -1;

// Set by goUp() (⌘↑) to the folder we're leaving, so the next listing load
// re-selects it — Finder lands on the child you came from. Consumed once by
// refreshList; null on every other navigation.
let pendingSelectName = null;

// In-app Cut/Copy clipboard: { mode: "cut" | "copy", paths: string[], deviceId }
// or null. Filled by ⌘C/⌘X, drained by ⌘V/⌘D. Declared here (not in the
// Clipboard section) because openDevice/clearOpenDevice above reset it. See the
// "Clipboard (Cut / Copy / Paste / Duplicate)" section for the operations.
let clipboard = null;

// Recursively-computed folder sizes, keyed by object_id (stable within a
// session). Value is { size, path }: size is the literal "calculating" while a
// dir_size call is in flight, or a byte count once it resolves; path is the
// folder's device-relative path, kept so a content change can invalidate just
// the affected folder and its ancestors by path-ancestry. Read by the list
// view's size cell. Computed totals survive navigation (that's the whole point)
// and are dropped only when they could be wrong — see refreshList (in-flight
// entries), invalidateAncestorsOf / invalidateSubtree (upload/delete), and
// invalidateFolderSizes (device switch / unplug). See calculateFolderSizes.
const folderSizeState = new Map();

// Pending folder-size work. Folders are sized one at a time (see pumpSizeQueue)
// so selecting hundreds and hitting "Calculate Size" doesn't spawn hundreds of
// concurrent backend calls. Cleared by refreshList when the listing changes.
const sizeQueue = [];
let sizeQueueRunning = false;

function pathFor(name) {
  return cwd ? `${cwd}/${name}` : name;
}

// ---------------------------------------------------------------------------
// Devices
//
// Single source of device UI is the header chip + its popover menu. There's
// no persistent sidebar — most of the time exactly one device is connected
// and the chip stays out of the way. Clicking the chip re-enumerates and
// shows a list when there's more than one to pick from.

let lastDevices = [];

// User-assigned device names, keyed by DeviceDescriptor.id (USB serial when the
// device exposes one — stable across reconnects). Persisted in localStorage so
// a renamed device keeps its name across launches. Overrides the generic label
// the device reports (e.g. a Fuji camera's "USB PTP Camera"). See startRename.
const ALIAS_STORAGE_KEY = "deiri.deviceAliases";
let deviceAliases = {};
try {
  deviceAliases = JSON.parse(localStorage.getItem(ALIAS_STORAGE_KEY) || "{}") || {};
} catch (err) {
  console.error("reading device aliases failed", err);
  deviceAliases = {};
}
function saveDeviceAliases() {
  try {
    localStorage.setItem(ALIAS_STORAGE_KEY, JSON.stringify(deviceAliases));
  } catch (err) {
    console.error("saving device aliases failed", err);
  }
}
// Display name for a device: the user's alias if set, else what it reports.
function deviceLabel(d) {
  return deviceAliases[d.id] || d.label;
}

async function refreshDevices({ autoOpen = false } = {}) {
  let devices;
  try {
    devices = await window.api.invoke("list_devices");
  } catch (err) {
    console.error("list_devices failed", err);
    devices = [];
  }
  lastDevices = devices;

  // If the device we had open vanished from the bus (unplugged or ejected),
  // tear down the session so its now-stale listing doesn't linger. This runs
  // on window focus, which fires right when the user returns after pulling
  // the cable, so it's the natural place to notice.
  if (openDeviceId && !devices.some((d) => d.id === openDeviceId)) {
    await clearOpenDevice();
  }

  updateDeviceChip();
  // If the menu is open, re-render so a hot-plug shows up immediately.
  if (!deviceMenu.hidden) renderDeviceMenu();

  if (autoOpen && !openDeviceId && devices.length > 0) {
    // Multi-device at startup: open the first. The user can switch via the
    // chip; the alphabetical order from list_devices is stable enough that
    // "first" is a meaningful concept.
    await openDevice(devices[0]);
  }
}

function updateDeviceChip() {
  const open = lastDevices.find((d) => d.id === openDeviceId);
  deviceChipLabel.textContent = open ? deviceLabel(open) : "No device";
  // The chip body now navigates to the device root; the ▾ switches devices.
  deviceChip.title = open ? "Go to device root" : "Pick a device";
  deviceChip.classList.toggle("no-device", !open);
  // Folder creation needs a session to target; gate it on an open device.
  newFolderBtn.disabled = !openDeviceId;
  searchInput.disabled = !openDeviceId;
}

function renderDeviceMenu() {
  deviceMenu.innerHTML = "";
  if (lastDevices.length === 0) {
    const empty = document.createElement("div");
    empty.className = "device-menu-empty";
    empty.textContent = "No MTP devices detected.";
    deviceMenu.appendChild(empty);
  } else {
    for (const d of lastDevices) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "device-menu-item";
      if (d.id === openDeviceId) item.classList.add("active");
      item.title = `${d.vendor_id.toString(16)}:${d.product_id.toString(16)} · ${d.id}`;
      const label = document.createElement("span");
      label.textContent = deviceLabel(d);
      item.appendChild(label);
      if (d.id === openDeviceId) {
        const check = document.createElement("span");
        check.className = "check";
        check.textContent = "✓";
        item.appendChild(check);
      }
      item.addEventListener("click", async () => {
        hideDeviceMenu();
        if (d.id !== openDeviceId) await openDevice(d);
      });
      deviceMenu.appendChild(item);
    }
  }
  const sep = document.createElement("div");
  sep.className = "device-menu-sep";
  deviceMenu.appendChild(sep);
  if (openDeviceId) {
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "device-menu-action";
    rename.textContent = "Rename…";
    rename.addEventListener("click", startRename);
    deviceMenu.appendChild(rename);
  }
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "device-menu-action";
  refresh.textContent = "Refresh";
  refresh.addEventListener("click", async () => {
    await refreshDevices();
    renderDeviceMenu();
  });
  deviceMenu.appendChild(refresh);
}

async function toggleDeviceMenu() {
  if (!deviceMenu.hidden) {
    hideDeviceMenu();
    return;
  }
  // Refresh before opening so the user always sees current state — picks up
  // a freshly-plugged device without making them hunt for a refresh button.
  await refreshDevices();
  renderDeviceMenu();
  deviceMenu.hidden = false;
  deviceChip.classList.add("is-open");
}

function hideDeviceMenu() {
  deviceMenu.hidden = true;
  deviceChip.classList.remove("is-open");
}

// Rename the open device by editing its label inline (the chip is swapped for a
// text field in place — no native prompt, which is unreliable in the webview).
// The name is a local alias keyed by device id; clearing it (or typing the
// device's own reported label) reverts to the default. See deviceAliases.
function startRename() {
  const open = lastDevices.find((d) => d.id === openDeviceId);
  if (!open) return;
  hideDeviceMenu();
  deviceRenameInput.value = deviceLabel(open);
  deviceChip.hidden = true;
  deviceRenameInput.hidden = false;
  deviceRenameInput.focus();
  deviceRenameInput.select();
}

function commitRename() {
  if (deviceRenameInput.hidden) return; // already closed (e.g. blur after Enter/Escape)
  const open = lastDevices.find((d) => d.id === openDeviceId);
  if (open) {
    const name = deviceRenameInput.value.trim();
    if (name === "" || name === open.label) delete deviceAliases[open.id];
    else deviceAliases[open.id] = name;
    saveDeviceAliases();
  }
  endRename();
  updateDeviceChip();
  if (!deviceMenu.hidden) renderDeviceMenu();
}

function endRename() {
  deviceRenameInput.hidden = true;
  deviceChip.hidden = false;
}

deviceRenameInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    commitRename();
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    endRename(); // discard the edit
  }
});
deviceRenameInput.addEventListener("blur", commitRename);

async function openDevice(d) {
  try {
    await window.api.invoke("open_device", {
      args: { device_id: d.id, location_id: d.location_id },
    });
  } catch (err) {
    console.error("open_device failed", err);
    alert(`Couldn't open ${d.label}:\n\n${err}`);
    return;
  }
  openDeviceId = d.id;
  cwd = "";
  navHistory = [""]; // fresh history rooted at the device's top level
  navIndex = 0;
  emptyEl.hidden = true;
  clipboard = null; // paths from any prior device are meaningless in a new session
  invalidateFolderSizes(); // new session — old handles (and their sizes) are meaningless
  updateDeviceChip();
  updateNavButtons();
  await Promise.all([refreshList(), refreshStorage()]);
}

// ---------------------------------------------------------------------------
// Navigation (Finder-style back/forward over a visited-folder history)

// Go to `path`, recording it in history. Used by every user-initiated move
// (double-click into a folder, path-bar click). Truncates any forward entries
// first, so navigating after going back drops the old forward branch — exactly
// like a browser / Finder.
function navigateTo(path) {
  const wasResults = searchResultMode;
  resetSearch(); // navigating clears any search (filter or Everywhere results)
  if (navIndex >= 0 && navHistory[navIndex] === path) {
    if (wasResults) refreshList(); // leave results behind, show the same folder
    return;
  }
  navHistory = navHistory.slice(0, navIndex + 1);
  navHistory.push(path);
  navIndex = navHistory.length - 1;
  cwd = path;
  updateNavButtons();
  refreshList();
}

function goBack() {
  if (navIndex <= 0) return;
  resetSearch();
  navIndex--;
  cwd = navHistory[navIndex];
  updateNavButtons();
  refreshList();
}

function goForward() {
  if (navIndex >= navHistory.length - 1) return;
  resetSearch();
  navIndex++;
  cwd = navHistory[navIndex];
  updateNavButtons();
  refreshList();
}

function updateNavButtons() {
  navBackBtn.disabled = navIndex <= 0;
  navForwardBtn.disabled = navIndex >= navHistory.length - 1;
}

// Tear down all open-device state — the inverse of openDevice(). Called when
// the active device leaves the bus (unplugged or ejected). Drops the backend
// session and resets the view to its empty state so a stale listing from the
// gone device doesn't linger on screen. `openDeviceId` is nulled BEFORE
// refreshList() so that call short-circuits to an empty render instead of
// hitting list_dir against a dead session.
async function clearOpenDevice() {
  openDeviceId = null;
  cwd = "";
  navHistory = [];
  navIndex = -1;
  storageText = "";
  clipboard = null; // session gone — its object paths no longer resolve
  endRename(); // if the device vanished mid-rename, restore the chip
  resetSearch(); // drop any search filter/results and clear the box
  invalidateFolderSizes(); // session gone — drop its cached sizes
  try {
    await window.api.invoke("close_device");
  } catch (err) {
    console.error("close_device failed", err);
  }
  updateDeviceChip();
  updateNavButtons();
  await refreshList();
  renderBreadcrumb(); // clear the path bar (refreshList skips it when no device)
}

// ---------------------------------------------------------------------------
// List view

async function refreshList() {
  selected.clear();
  anchorIndex = -1;
  cursorIndex = -1;
  // Captured before the await so a concurrent navigation can't apply it to the
  // wrong listing; applied at the bottom once `entries` exists. See goUp.
  const selectName = pendingSelectName;
  pendingSelectName = null;
  // Keep already-computed folder sizes across navigation — they're keyed by
  // object_id, which is stable for the whole session, so a folder's total is
  // still valid when you return to its listing. Only drop entries that were
  // mid-calculation, since pumpSizeQueue's pending work is being cancelled
  // here. Mutations and device changes wipe the cache wholesale via
  // invalidateFolderSizes() instead.
  for (const [id, v] of folderSizeState) {
    if (v.size === "calculating") folderSizeState.delete(id);
  }
  sizeQueue.length = 0; // drop pending size work for the folder we're leaving
  activeFilters.clear(); // format filter is per-listing; reset on navigation
  if (!openDeviceId) {
    allEntries = [];
    entries = [];
    renderFilterPills();
    renderList();
    return;
  }
  allEntries = await window.api.invoke("list_dir", { path: cwd });
  renderFilterPills(); // pills reflect the formats in this folder
  applyFilter();       // derives `entries` from `allEntries` and renders
  renderBreadcrumb();
  if (selectName) selectEntryByName(selectName);
}

// ---------------------------------------------------------------------------
// Format filter (pills)

// File extension, lowercased, "" for none. A leading dot (".sync") is a dotfile
// name, not an extension — hence `dot > 0` rather than `>= 0`.
function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// Distinct file extensions in the current folder with their counts, most common
// first. Folders don't have a format, so they're excluded.
function availableFormats() {
  const counts = new Map();
  for (const e of allEntries) {
    if (e.is_dir) continue;
    const ext = extOf(e.name);
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}

function renderFilterPills() {
  filterPillsEl.innerHTML = "";
  if (!openDeviceId) return;
  const formats = availableFormats();
  // Nothing to choose between with 0 or 1 file type — filtering would be a
  // no-op, so keep the bar clean (this hides pills in all-JPG camera folders
  // and folder-only listings).
  if (formats.length < 2) return;

  for (const { ext, count } of formats) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "filter-pill";
    if (activeFilters.has(ext)) pill.classList.add("active");
    const label = document.createElement("span");
    label.className = "pill-label";
    label.textContent = ext === "" ? "No ext" : ext.toUpperCase();
    const cnt = document.createElement("span");
    cnt.className = "pill-count";
    cnt.textContent = count;
    pill.append(label, cnt);
    pill.addEventListener("click", () => toggleFilter(ext));
    filterPillsEl.appendChild(pill);
  }
}

function toggleFilter(ext) {
  if (activeFilters.has(ext)) activeFilters.delete(ext);
  else activeFilters.add(ext);
  // The current selection was made against the old view; clear it so we don't
  // act on rows that just got filtered out.
  selected.clear();
  anchorIndex = -1;
  cursorIndex = -1;
  renderFilterPills(); // refresh active states
  applyFilter();
}

// Derive the rendered `entries` from `allEntries`. With no filter, show
// everything. When a format filter is active, hide folders too — "show me PDFs"
// shouldn't leave subfolders cluttering the view; only matching files pass.
function applyFilter() {
  let list = allEntries.slice();
  if (activeFilters.size > 0) {
    list = list.filter((e) => !e.is_dir && activeFilters.has(extOf(e.name)));
  }
  // Live current-folder search composes on top of the format pills.
  if (currentFolderQuery) {
    list = list.filter((e) => matchEntry(e, currentFolderQuery));
  }
  entries = list;
  renderList();
}

// Size used for the "size" sort. Files use their real size. Folders have none
// until "Calculate Size" computes one, so a calculated folder sorts by its
// total and an uncalculated folder sorts as -1 — clustered together, and
// distinct from a calculated empty (0-byte) folder. Folders stay grouped above
// files (see the is_dir check in sortEntries), so this only orders folders
// among themselves and files among themselves.
function effectiveSize(e) {
  if (!e.is_dir) return e.size ?? 0;
  const v = folderSizeState.get(e.object_id);
  return v && typeof v.size === "number" ? v.size : -1;
}

function sortEntries() {
  const dir = sortDir === "asc" ? 1 : -1;
  entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    switch (sortKey) {
      case "name":     return a.name.localeCompare(b.name) * dir;
      case "size":     return (effectiveSize(a) - effectiveSize(b)) * dir;
      case "modified": return ((a.modified_at ?? 0) - (b.modified_at ?? 0)) * dir;
      default:         return 0;
    }
  });
}

function renderList() {
  if (searchResultMode) { renderSearchResults(); return; } // Everywhere results
  sortEntries();
  renderGen++;

  if (entries.length === 0 && openDeviceId) {
    emptyEl.textContent = currentFolderQuery
      ? "No matches."
      : activeFilters.size > 0
        ? "No items match the filter."
        : "Empty folder.";
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = entries.length > 0 || !!openDeviceId;
    if (!openDeviceId) emptyEl.textContent = "Connect an MTP device to begin.";
  }

  listEl.hidden = viewMode !== "list";
  gridEl.hidden = viewMode !== "grid";
  if (viewMode === "list") renderListView();
  else renderGridView();

  updateStatusBar(); // item count changed (and selection was cleared on nav)
}

function renderListView() {
  listBody.innerHTML = "";
  entries.forEach((e, idx) => {
    const tr = document.createElement("tr");
    tr.dataset.name = e.name;
    tr.dataset.isDir = String(e.is_dir);
    tr.dataset.idx = String(idx);
    tr.dataset.objectId = String(e.object_id); // for targeted folder-size cell updates
    // Folders are move targets: drop a dragged row on one to move it inside.
    // Same `data-droppath` contract the breadcrumb crumbs use (see dropTargetAt).
    if (e.is_dir) tr.dataset.droppath = pathFor(e.name);
    if (selected.has(pathFor(e.name))) tr.classList.add("selected");
    if (isCut(e.name)) tr.classList.add("cut"); // ghosted while a cut is pending

    const nameTd = document.createElement("td");
    nameTd.className = "cell-name";
    nameTd.textContent = `${e.is_dir ? "📁" : "📄"} ${e.name}`;
    const sizeTd = document.createElement("td");
    sizeTd.className = "cell-size";
    sizeTd.textContent = e.is_dir ? folderSizeLabel(e) : humanSize(e.size ?? 0);
    const modTd = document.createElement("td");
    modTd.className = "cell-modified";
    modTd.textContent = formatModified(e.modified_at);

    tr.append(nameTd, sizeTd, modTd);

    tr.addEventListener("click", (ev) => onRowClick(idx, ev));
    tr.addEventListener("dblclick", () => openEntry(e));
    tr.addEventListener("contextmenu", (ev) => onRowContextMenu(idx, ev));

    attachDragOut(tr, e); // files and folders both drag out (folders recurse)

    listBody.appendChild(tr);
  });
}

function renderGridView() {
  gridEl.innerHTML = "";
  // Camera folders can hold hundreds of shots; building all tiles in one
  // synchronous pass freezes the WebView. Chunk across animation frames so
  // the first screen paints fast and the rest fills in.
  const CHUNK = 80;
  const myGen = renderGen;
  let i = 0;
  function pump() {
    if (myGen !== renderGen) return; // user navigated away; abandon
    const end = Math.min(i + CHUNK, entries.length);
    const frag = document.createDocumentFragment();
    for (; i < end; i++) frag.appendChild(buildTile(entries[i], i));
    gridEl.appendChild(frag);
    if (i < entries.length) requestAnimationFrame(pump);
  }
  pump();
}

function buildTile(e, idx) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.name = e.name;
  tile.dataset.isDir = String(e.is_dir);
  tile.dataset.idx = String(idx);
  // Folders are move targets — see the matching note in renderListView.
  if (e.is_dir) tile.dataset.droppath = pathFor(e.name);
  if (selected.has(pathFor(e.name))) tile.classList.add("selected");
  if (isCut(e.name)) tile.classList.add("cut"); // ghosted while a cut is pending

  const thumbBox = document.createElement("div");
  thumbBox.className = "tile-thumb";
  if (e.is_dir) {
    thumbBox.textContent = "📁";
  } else if (e.has_thumbnail) {
    // The Rust side serves thumb:// directly (no IPC marshaling of Vec<u8>),
    // so we can just point an <img> at it and let the browser handle lazy
    // loading + off-thread decode. `decoding="async"` keeps decode off the
    // main thread even for the first paint; `loading="lazy"` defers fetch
    // until the tile is near the viewport. If the device claimed
    // has_thumbnail but the fetch 404s, fall back to the file glyph.
    const img = document.createElement("img");
    img.src = `thumb://localhost/${e.object_id}`;
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    img.addEventListener("error", () => {
      thumbBox.textContent = "📄";
    });
    thumbBox.appendChild(img);
  } else {
    thumbBox.textContent = "📄";
  }

  const nameEl = document.createElement("div");
  nameEl.className = "tile-name";
  nameEl.textContent = e.name;
  tile.append(thumbBox, nameEl);

  tile.addEventListener("click", (ev) => onRowClick(idx, ev));
  tile.addEventListener("dblclick", () => openEntry(e));
  tile.addEventListener("contextmenu", (ev) => onRowContextMenu(idx, ev));
  attachDragOut(tile, e); // files and folders both drag out (folders recurse)
  return tile;
}

// ---------------------------------------------------------------------------
// Selection

function onRowClick(idx, ev) {
  const entry = entries[idx];
  if (!entry) return;
  const path = pathFor(entry.name);

  if (ev.shiftKey && anchorIndex >= 0 && anchorIndex < entries.length) {
    // Range select. Don't preserve prior selection — matches Finder.
    const lo = Math.min(anchorIndex, idx);
    const hi = Math.max(anchorIndex, idx);
    selected.clear();
    for (let i = lo; i <= hi; i++) selected.add(pathFor(entries[i].name));
  } else if (ev.metaKey || ev.ctrlKey) {
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    anchorIndex = idx;
  } else {
    selected.clear();
    selected.add(path);
    anchorIndex = idx;
  }
  cursorIndex = idx; // the clicked row becomes the keyboard lead
  updateSelectionDOM();
}

function updateSelectionDOM() {
  const nodes = viewMode === "list"
    ? listBody.querySelectorAll("tr")
    : gridEl.querySelectorAll(".tile");
  nodes.forEach((n) => {
    n.classList.toggle("selected", selected.has(pathFor(n.dataset.name)));
  });
  updateStatusBar(); // selection count drives the status bar
}

// Keyboard navigation over the rendered `entries`, Finder-style. Arrows move a
// single-selection lead (`cursorIndex`); Shift+arrow extends a range from
// `anchorIndex`. `target` is clamped into range, so callers can overshoot (e.g.
// cursor + a whole grid row) without bounds-checking. A stale anchor — left
// pointing past the list by a live filter — is clamped here too, so the range
// loop never indexes off the end.
function moveSelection(target, extend) {
  if (entries.length === 0) return;
  const last = entries.length - 1;
  const idx = Math.max(0, Math.min(target, last));
  if (extend) {
    let a = anchorIndex < 0 ? (cursorIndex < 0 ? idx : cursorIndex) : anchorIndex;
    a = Math.max(0, Math.min(a, last));
    anchorIndex = a;
    selected.clear();
    for (let i = Math.min(a, idx); i <= Math.max(a, idx); i++) {
      selected.add(pathFor(entries[i].name));
    }
  } else {
    selected.clear();
    selected.add(pathFor(entries[idx].name));
    anchorIndex = idx;
  }
  cursorIndex = idx;
  updateSelectionDOM();
  scrollEntryIntoView(idx);
}

// Keep the keyboard lead visible as it moves. `block: "nearest"` scrolls the
// minimum amount — no jump when the row is already on screen.
function scrollEntryIntoView(idx) {
  const root = viewMode === "list" ? listBody : gridEl;
  root.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
}

// Tiles per row in grid view: count the leading tiles that share the first
// tile's offsetTop (one grid row) so ↑/↓ can jump a whole row. Recomputed per
// keypress because the column count is responsive (auto-fill — see style.css).
function gridColumns() {
  const tiles = gridEl.querySelectorAll(".tile");
  if (tiles.length === 0) return 1;
  const top = tiles[0].offsetTop;
  let cols = 0;
  for (const t of tiles) {
    if (t.offsetTop !== top) break;
    cols++;
  }
  return Math.max(1, cols);
}

// Select a single entry by name in the current listing and make it the
// keyboard lead. No-op if the name isn't in the rendered `entries` (e.g. hidden
// by a format filter). Used by ⌘↑ to land on the folder you came from.
function selectEntryByName(name) {
  const idx = entries.findIndex((e) => e.name === name);
  if (idx < 0) return;
  selected.clear();
  selected.add(pathFor(entries[idx].name));
  anchorIndex = idx;
  cursorIndex = idx;
  updateSelectionDOM();
  scrollEntryIntoView(idx);
}

// Select every listed entry whose name is in `names`, leading at the first.
// Names not present (e.g. a copy that failed) are skipped. Used after Paste /
// Duplicate to leave the new copies selected, Finder-style.
function selectNamesInListing(names) {
  const want = new Set(names);
  selected.clear();
  let firstIdx = -1;
  entries.forEach((e, idx) => {
    if (!want.has(e.name)) return;
    selected.add(pathFor(e.name));
    if (firstIdx < 0) firstIdx = idx;
  });
  anchorIndex = firstIdx;
  cursorIndex = firstIdx;
  updateSelectionDOM();
  if (firstIdx >= 0) scrollEntryIntoView(firstIdx);
}

// ⌘↑ — navigate to the enclosing folder, re-selecting the one we leave. No-op
// at the device root.
function goUp() {
  if (!cwd) return;
  const slash = cwd.lastIndexOf("/");
  pendingSelectName = slash >= 0 ? cwd.slice(slash + 1) : cwd;
  navigateTo(slash >= 0 ? cwd.slice(0, slash) : "");
}

// ---------------------------------------------------------------------------
// Context menu

function onRowContextMenu(idx, ev) {
  ev.preventDefault();
  const entry = entries[idx];
  if (!entry) return;
  const path = pathFor(entry.name);

  // If the right-clicked row isn't already selected, replace selection with
  // just it — matches Finder. Multi-select right-click acts on the whole set.
  if (!selected.has(path)) {
    selected.clear();
    selected.add(path);
    anchorIndex = idx;
    cursorIndex = idx;
    updateSelectionDOM();
  }

  const selectedEntries = [...selected]
    .map((p) => entries.find((x) => pathFor(x.name) === p))
    .filter(Boolean);
  const selectedFolders = selectedEntries.filter((e) => e.is_dir);
  const count = selected.size;

  const items = [
    {
      // Both files and folders can be saved — folders pull their whole subtree.
      label: count > 1 ? `Save ${count} items to…` : "Save to…",
      onSelect: saveSelectedTo,
    },
  ];
  // Open / Rename are single-item actions. Open previews a file (or descends
  // into a folder); Rename edits the name in place on the device.
  if (count === 1) {
    items.unshift({ label: "Open", onSelect: () => openEntry(selectedEntries[0]) });
    items.push({ label: "Rename", onSelect: () => beginRename(idx) });
  }
  // Recursive folder sizing only has somewhere to show in the list view, so
  // only offer it there. Acts on the folders in the selection; any files are
  // left alone (they already show a size).
  if (viewMode === "list" && selectedFolders.length > 0) {
    items.push({
      label: selectedFolders.length > 1
        ? `Calculate size of ${selectedFolders.length} folders`
        : "Calculate Size",
      onSelect: () => calculateFolderSizes(selectedFolders),
    });
  }
  // Clipboard actions on the selection. Paste lives on the empty-area menu (it
  // targets the current folder, not the clicked row) — and on ⌘V.
  items.push({ separator: true });
  items.push({ label: count > 1 ? `Copy ${count} items` : "Copy", onSelect: () => setClipboard("copy") });
  items.push({ label: count > 1 ? `Cut ${count} items` : "Cut", onSelect: () => setClipboard("cut") });
  items.push({ label: count > 1 ? `Duplicate ${count} items` : "Duplicate", onSelect: duplicateSelected });
  items.push({ separator: true });
  items.push({
    label: count > 1 ? `Delete ${count} items` : "Delete",
    onSelect: deleteSelected,
  });

  showContextMenu(ev.clientX, ev.clientY, items);
}

// Right-clicking empty space in the listing (Finder's "New Folder" gesture).
// Rows and tiles carry their own menu (onRowContextMenu) and the sortable
// column headers their own click behavior, so bail when the target is one of
// those — and when no device is open there's nowhere to create a folder.
function onEmptyContextMenu(ev) {
  if (ev.target.closest("tr, .tile, thead")) return;
  ev.preventDefault();
  if (!openDeviceId) return;
  const items = [{ label: "New Folder", onSelect: createFolder }];
  // Paste into the current folder when the clipboard holds items from this
  // device. Cut reads as "Move … Here" since it relocates rather than copies.
  if (clipboard && clipboard.deviceId === openDeviceId && !searchResultMode) {
    const n = clipboard.paths.length;
    const label = clipboard.mode === "cut"
      ? (n > 1 ? `Move ${n} Items Here` : "Move Here")
      : (n > 1 ? `Paste ${n} Items` : "Paste");
    items.push({ separator: true });
    items.push({ label, onSelect: pasteClipboard });
  }
  showContextMenu(ev.clientX, ev.clientY, items);
}
listContainer.addEventListener("contextmenu", onEmptyContextMenu);

function showContextMenu(x, y, items) {
  contextMenu.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    if (item.separator) {
      li.className = "separator";
    } else {
      li.textContent = item.label;
      if (item.disabled) {
        li.classList.add("disabled");
      } else {
        li.addEventListener("click", () => {
          hideContextMenu();
          item.onSelect();
        });
      }
    }
    contextMenu.appendChild(li);
  }
  // Render first so we can measure, then clamp to viewport.
  contextMenu.style.left = "0px";
  contextMenu.style.top = "0px";
  contextMenu.hidden = false;
  const rect = contextMenu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 4;
  if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 4;
  contextMenu.style.left = `${Math.max(0, left)}px`;
  contextMenu.style.top = `${Math.max(0, top)}px`;
}

function hideContextMenu() {
  contextMenu.hidden = true;
}

document.addEventListener("mousedown", (ev) => {
  if (!contextMenu.hidden && !contextMenu.contains(ev.target)) hideContextMenu();
  if (
    !deviceMenu.hidden
    && !deviceMenu.contains(ev.target)
    && !deviceChip.contains(ev.target)
  ) {
    hideDeviceMenu();
  }
  if (
    !searchHelp.hidden
    && !searchHelp.contains(ev.target)
    && !searchHelpBtn.contains(ev.target)
  ) {
    hideSearchHelp();
  }
});
window.addEventListener("blur", () => {
  hideContextMenu();
  hideDeviceMenu();
  hideSearchHelp();
  hideShortcutsHelp();
});
document.addEventListener("scroll", hideContextMenu, true);

// Suppress the WebView's built-in context menu (its "Reload" reloads only the
// JS, not the Rust session, which then can't re-open the still-held device).
// Our own file/row menus are shown explicitly by their handlers, so this only
// kills the default. Inputs are exempt so a future search field keeps paste etc.
document.addEventListener("contextmenu", (ev) => {
  const tag = ev.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  ev.preventDefault();
});

// ---------------------------------------------------------------------------
// Delete + Save-to

async function deleteSelected() {
  if (selected.size === 0) return;
  const paths = [...selected];
  const message =
    paths.length === 1
      ? `Delete "${paths[0].split("/").pop()}"? This cannot be undone.`
      : `Delete ${paths.length} items? This cannot be undone.`;
  console.log("deleteSelected:", paths);
  let ok;
  try {
    ok = await window.api.confirm(message, {
      title: "Delete",
      kind: "warning",
      okLabel: "Delete",
    });
  } catch (err) {
    console.error("confirm dialog failed", err);
    alert(`Couldn't show delete confirmation:\n\n${err}`);
    return;
  }
  console.log("confirm result:", ok);
  if (!ok) return;

  for (const path of paths) {
    const name = path.split("/").pop();
    const ent = entries.find((x) => x.name === name);
    if (!ent) continue;
    try {
      await window.api.invoke("delete", {
        args: { path, recursive: ent.is_dir },
      });
    } catch (err) {
      console.error("delete failed", path, err);
      alert(`Couldn't delete ${name}:\n\n${err}`);
      break;
    }
  }
  // Targeted invalidation: the removed subtrees (whose handles may be reused)
  // and the parent chain whose totals shrank. Sibling folders keep their sizes.
  for (const p of paths) invalidateSubtree(p);
  invalidateAncestorsOf(cwd);
  await Promise.all([refreshList(), refreshStorage()]);
}

async function saveSelectedTo() {
  if (selected.size === 0) return;
  // Snapshot the selection before the async folder pick (it could change under us).
  const sources = [...selected];
  const sel = sources
    .map((p) => entries.find((x) => pathFor(x.name) === p))
    .filter(Boolean);
  if (sel.length === 0) return;
  if (aLongJobRunning()) {
    alert("A transfer or search is already in progress. Wait for it to finish or cancel it.");
    return;
  }
  const destDir = await window.api.pickFolder("Save to…");
  if (!destDir) return;
  // "i of N" only when no folders are selected — we don't pre-walk device folders.
  const fileCount = sel.every((e) => !e.is_dir) ? sel.length : 0;
  const job = startTransfer("download");
  if (job === null) return;
  try {
    // download_objects loops over the sources in one job, writing each as
    // dest/<name> (folders recreate their subtree), streaming progress.
    await window.api.downloadObjects(job, sources, destDir, fileCount);
  } catch (err) {
    console.error("download failed", err);
    alert(`Couldn't save:\n\n${err}`);
  } finally {
    endTransfer();
  }
}

// ---------------------------------------------------------------------------
// Open (read-only preview)
//
// Double-click / ⌘O / ⌘↓ on a file pulls it to a temp copy and opens it in the
// system default app (see open_object in commands.rs). Folders navigate
// instead. Enter stays bound to rename, matching Finder.

function openEntry(entry) {
  if (!entry) return;
  if (entry.is_dir) navigateTo(pathFor(entry.name));
  else openFile(entry);
}

function openFile(entry) {
  return openObjectAt(pathFor(entry.name), entry.object_id, entry.name);
}

// Open a file by explicit device path — used by the current folder (openFile)
// and by Everywhere results, whose files live in other folders.
async function openObjectAt(path, objectId, name) {
  const opening = `Opening ${name}…`;
  const restore = statusEl.textContent;
  statusEl.textContent = opening;
  try {
    await window.api.openObject(path, objectId);
  } catch (err) {
    console.error("open failed", name, err);
    alert(`Couldn't open ${name}:\n\n${err}`);
  } finally {
    // Only clear our transient message if nothing else overwrote it meanwhile.
    if (statusEl.textContent === opening) statusEl.textContent = restore;
  }
}

// Keyboard / menu "Open" on the current selection: open every selected file; a
// lone selected folder navigates instead (Finder's ⌘↓).
function openSelected() {
  const sel = [...selected]
    .map((p) => entries.find((x) => pathFor(x.name) === p))
    .filter(Boolean);
  if (sel.length === 0) return;
  const files = sel.filter((e) => !e.is_dir);
  if (files.length === 0) {
    if (sel.length === 1) navigateTo(pathFor(sel[0].name));
    return;
  }
  for (const f of files) openFile(f);
}

// Space = Quick Look the primary selected file (the anchor if it's a selected
// file, else the first selected file). Folders aren't previewed. v1 shows one
// file; arrow-through across a multi-selection is a follow-up.
function quickLookSelected() {
  const anchor = entries[anchorIndex];
  if (anchor && !anchor.is_dir && selected.has(pathFor(anchor.name))) {
    quickLook(anchor);
    return;
  }
  const file = [...selected]
    .map((p) => entries.find((x) => pathFor(x.name) === p))
    .find((e) => e && !e.is_dir);
  if (file) quickLook(file);
}

async function quickLook(entry) {
  const loading = `Loading preview of ${entry.name}…`;
  const restore = statusEl.textContent;
  statusEl.textContent = loading;
  try {
    await window.api.quickLookObject(pathFor(entry.name), entry.object_id);
  } catch (err) {
    console.error("quick look failed", entry.name, err);
  } finally {
    if (statusEl.textContent === loading) statusEl.textContent = restore;
  }
}

// ---------------------------------------------------------------------------
// Name-conflict resolution
//
// One Replace / Keep Both / Skip dialog shared by the three operations that
// drop an item, under its own name, into a folder that may already hold it: the
// drag move, paste-cut, and upload. (Paste-copy and Duplicate never prompt —
// making an extra copy is the whole point, so they auto-suffix instead.) The
// dialog is a centered modal over a dim backdrop, same idiom as the shortcuts
// overview; while open it swallows other shortcuts (see the keydown handler).
// Detection is client-side: the destination's names vs. each item's leaf.

let conflictResolver = null; // resolve() of the in-flight dialog promise, or null

// Finish the open dialog with `action` ("replace" | "keepboth" | "skip" |
// "cancel"), reporting whether "Apply to all" was ticked (only when offered).
function resolveConflict(action) {
  if (!conflictResolver) return;
  const applyToAll = !conflictApplyRow.hidden && conflictApplyAll.checked;
  const done = conflictResolver;
  conflictResolver = null;
  conflictDialog.hidden = true;
  done({ action, applyToAll });
}

// Ask how to resolve one collision. `remaining` is how many collisions are left
// to decide (including this one); when >1 we offer "Apply to all". `canMerge`
// shows the Merge button (folder uploads only). Returns a promise of
// { action, applyToAll }.
function showConflictDialog({ name, verb, remaining, canMerge }) {
  hideContextMenu();
  hideDeviceMenu();
  hideSearchHelp();
  // textContent (not innerHTML) — names are arbitrary and must not be parsed.
  conflictMessage.textContent = "";
  const strong = document.createElement("strong");
  strong.textContent = `“${name}”`;
  conflictMessage.append("An item named ", strong, " already exists here.");
  conflictHint.textContent =
    verb === "upload"
      ? canMerge
        ? "Merge combines the folders. Replace overwrites the one on the device. Keep Both uploads a numbered copy."
        : "Replace overwrites the one on the device. Keep Both uploads a numbered copy."
      : "Replace overwrites the existing one. Keep Both adds a numbered copy.";
  conflictMergeBtn.hidden = !canMerge;
  const offerAll = remaining > 1;
  conflictApplyRow.hidden = !offerAll;
  conflictApplyAll.checked = false;
  conflictApplyCount.textContent = offerAll ? `Apply to all (${remaining})` : "";
  conflictDialog.hidden = false;
  conflictKeepBtn.focus(); // the safe, non-destructive default
  return new Promise((resolve) => {
    conflictResolver = resolve;
  });
}

conflictReplaceBtn.addEventListener("click", () => resolveConflict("replace"));
conflictMergeBtn.addEventListener("click", () => resolveConflict("merge"));
conflictKeepBtn.addEventListener("click", () => resolveConflict("keepboth"));
conflictSkipBtn.addEventListener("click", () => resolveConflict("skip"));
conflictCancelBtn.addEventListener("click", () => resolveConflict("cancel"));
conflictCloseBtn.addEventListener("click", () => resolveConflict("cancel"));
// Click on the dim backdrop (not the card) cancels the whole operation.
conflictDialog.addEventListener("mousedown", (ev) => {
  if (ev.target === conflictDialog) resolveConflict("cancel");
});

// Resolve every top-level name collision for a batch landing in one folder.
// Each item carries { name, isDir, ... } (plus whatever the caller acts on,
// e.g. a source path); `existingLower` is the destination's current names,
// lowercased (devices fold case). Returns a parallel list of
// { ...item, destName, overwrite } for the items to act on — Skips dropped — or
// null if the user cancelled the whole operation. Keep Both reuses Finder-style
// `uniqueCopyName`, growing `taken` so a batch never collides with itself.
async function resolveConflicts(items, existingLower, { verb }) {
  const taken = new Set(existingLower);
  // Collision count up front (against the original names) for "Apply to all
  // (N)" — Keep-Both additions can't inflate it.
  let remaining = items.reduce(
    (n, it) => (existingLower.has(it.name.toLowerCase()) ? n + 1 : n),
    0,
  );
  const out = [];
  let sticky = null; // an action chosen with "Apply to all", reused thereafter
  for (const it of items) {
    const lower = it.name.toLowerCase();
    if (!taken.has(lower)) {
      out.push({ ...it, destName: it.name, overwrite: false, merge: false });
      taken.add(lower);
      continue;
    }
    let action = sticky;
    if (!action) {
      // Merge only makes sense uploading one folder into another (move/copy
      // can't combine device-side); the backend coalesces it to Replace if a
      // sticky "Merge" later lands on a file.
      const canMerge = verb === "upload" && it.isDir;
      const res = await showConflictDialog({ name: it.name, verb, remaining, canMerge });
      if (res.action === "cancel") return null;
      action = res.action;
      if (res.applyToAll) sticky = action;
    }
    remaining--;
    if (action === "skip") continue;
    if (action === "replace") {
      out.push({ ...it, destName: it.name, overwrite: true, merge: false });
    } else if (action === "merge") {
      out.push({ ...it, destName: it.name, overwrite: false, merge: true });
    } else {
      const free = uniqueCopyName(it.name, it.isDir, taken);
      taken.add(free.toLowerCase());
      out.push({ ...it, destName: free, overwrite: false, merge: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clipboard (Cut / Copy / Paste / Duplicate)
//
// An in-app clipboard of device-relative object paths, Explorer-style. ⌘C / ⌘X
// stash the selection (copy survives a paste so you can paste again; cut is
// consumed by the move). ⌘V pastes into the current folder; ⌘D duplicates the
// selection in place. The clipboard is bound to the device it was filled on —
// switching or closing the device clears it, since paths only mean anything
// within one session.
//
// Paste-copy and Duplicate never overwrite: each lands under the first free
// "name copy" / "name copy N" name in the destination (computed here, applied
// device-side by copy_objects). Paste-cut is a move (move_object); a name clash
// goes through the shared Replace / Keep Both / Skip dialog (see
// resolveConflicts). (`clipboard` itself is declared up in the App-state section.)

// Snapshot the current selection into the clipboard. No-op without a selection.
function setClipboard(mode) {
  if (!openDeviceId || selected.size === 0) return;
  clipboard = { mode, paths: [...selected], deviceId: openDeviceId };
  updateCutDOM(); // ghost the cut items (and un-ghost anything previously cut)
}

function clearClipboard() {
  clipboard = null;
  updateCutDOM();
}

// True when `name` in the current folder is a pending cut — drives the .cut
// ghost. Paths are absolute, so a cut item only ghosts while its own folder is
// shown; navigating away naturally hides it.
function isCut(name) {
  return clipboard?.mode === "cut"
    && clipboard.deviceId === openDeviceId
    && clipboard.paths.includes(pathFor(name));
}

// Repaint the .cut ghost on the rendered rows/tiles without a full rebuild.
function updateCutDOM() {
  const nodes = viewMode === "list"
    ? listBody.querySelectorAll("tr")
    : gridEl.querySelectorAll(".tile");
  nodes.forEach((n) => n.classList.toggle("cut", isCut(n.dataset.name)));
}

// Split a leaf name into [stem, ext] so " copy" can go before the extension.
// Folders and dotfiles (no real extension) keep the whole name as the stem,
// matching Finder ("archive.tar.gz" -> "archive.tar copy.gz").
function splitForCopy(name, isDir) {
  const dot = name.lastIndexOf(".");
  if (isDir || dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

// First free name for a copy of `name` in a folder whose lowercased names are
// `takenLower`: the name itself when free (paste into a folder that lacks it),
// else "stem copy", "stem copy 2", … Finder-style. The caller adds each result
// back to `takenLower` so a multi-item batch doesn't collide with itself.
function uniqueCopyName(name, isDir, takenLower) {
  if (!takenLower.has(name.toLowerCase())) return name;
  const [stem, ext] = splitForCopy(name, isDir);
  let candidate = `${stem} copy${ext}`;
  if (!takenLower.has(candidate.toLowerCase())) return candidate;
  for (let n = 2; ; n++) {
    candidate = `${stem} copy ${n}${ext}`;
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
}

// Build (source, free dest name) items for `sources` landing in `destDir`, then
// run them as one cancellable copy job. Shared by Paste-copy and Duplicate.
// `destDir` is always the current folder, so the taken-name set is `allEntries`.
async function copyItemsInto(sources, destDir) {
  if (sources.length === 0) return;
  if (aLongJobRunning()) {
    alert("A transfer or search is already in progress. Wait for it to finish or cancel it.");
    return;
  }
  const takenLower = new Set(allEntries.map((e) => e.name.toLowerCase()));
  const items = sources.map((source) => {
    const leaf = source.split("/").pop();
    // We know the source's type when it's in the current folder (Duplicate, or
    // paste into the same folder); otherwise infer file-vs-folder from the name
    // — it only matters on a name clash, to place " copy" before an extension.
    const here = allEntries.find((e) => pathFor(e.name) === source);
    const isDir = here ? here.is_dir : leaf.lastIndexOf(".") <= 0;
    const destName = uniqueCopyName(leaf, isDir, takenLower);
    takenLower.add(destName.toLowerCase());
    return { source, dest_name: destName };
  });

  const job = startTransfer("copy");
  if (job === null) return;
  try {
    await window.api.copyObjects(job, items, destDir);
  } catch (err) {
    console.error("copy failed", err);
    alert(`Couldn't copy:\n\n${err}`);
  } finally {
    endTransfer();
  }
  // The new objects grew destDir and its ancestors; refresh listing + storage.
  invalidateAncestorsOf(destDir);
  await Promise.all([refreshList(), refreshStorage()]);
  // Leave the fresh copies selected (Finder-style), but only when the paste
  // landed in the folder we're still viewing — a copy into another folder via a
  // future drop shouldn't yank the selection here.
  if (destDir === cwd) selectNamesInListing(items.map((i) => i.dest_name));
}

// ⌘D — duplicate the selection in place. Same engine as paste-copy, sourced from
// the selection and always landing in the current folder (so every name clashes
// and gets a " copy" suffix).
function duplicateSelected() {
  if (selected.size === 0) return;
  copyItemsInto([...selected], cwd);
}

// ⌘V — paste the clipboard into the current folder. Copy duplicates (keeping the
// clipboard for repeat pastes); cut moves (move_object) and is then consumed.
async function pasteClipboard() {
  if (!openDeviceId || searchResultMode) return; // no folder context in results
  if (!clipboard || clipboard.deviceId !== openDeviceId) return;
  const sources = clipboard.paths;
  if (sources.length === 0) return;

  if (clipboard.mode === "copy") {
    await copyItemsInto(sources, cwd);
    return;
  }

  // Cut = move into cwd. Skip items already here (their parent is cwd). Name
  // clashes go through the shared Replace / Keep Both / Skip dialog.
  if (aLongJobRunning()) {
    alert("A transfer or search is already in progress. Wait for it to finish or cancel it.");
    return;
  }
  const parentOf = (p) => {
    const slash = p.lastIndexOf("/");
    return slash >= 0 ? p.slice(0, slash) : "";
  };
  const toMove = sources.filter((p) => parentOf(p) !== cwd);
  if (toMove.length === 0) {
    clearClipboard();
    return;
  }
  // Cut items live outside cwd, so infer is_dir from the leaf (only affects
  // Keep-Both naming). Resolve clashes against the current folder.
  const existingLower = new Set(allEntries.map((e) => e.name.toLowerCase()));
  const items = toMove.map((p) => {
    const name = p.split("/").pop();
    return { source: p, name, isDir: name.lastIndexOf(".") <= 0 };
  });
  const resolved = await resolveConflicts(items, existingLower, { verb: "move" });
  if (resolved === null) return; // cancelled — keep the clipboard for a retry
  clearClipboard(); // committing to the move consumes the cut (even if all skipped)
  for (const r of resolved) {
    try {
      await window.api.moveObject(r.source, cwd, r.destName, r.overwrite);
    } catch (err) {
      console.error("paste-move failed", r.source, "→", cwd, err);
      alert(`Couldn't move ${r.name}:\n\n${err}`);
      break;
    }
    invalidateAncestorsOf(parentOf(r.source)); // the source's old chain shrank
  }
  invalidateAncestorsOf(cwd); // and the destination chain grew
  await Promise.all([refreshList(), refreshStorage()]);
}

// ---------------------------------------------------------------------------
// New folder
//
// Finder-style: create an "untitled folder" in the current directory, then drop
// straight into inline rename so the user can name it. The backend create_dir
// is idempotent (it reuses an existing folder of the same name rather than
// erroring), so we pick a name that doesn't collide with anything in the
// listing — otherwise "New Folder" twice would silently land on the same folder.

// First free "untitled folder" / "untitled folder N" name in the current
// listing. Matched case-insensitively so we don't pick a name a case-folding
// device would treat as a duplicate. Checks `allEntries` (the full listing),
// not the filtered `entries`, so a folder hidden by an active format filter
// still counts as taken.
function uniqueUntitledName() {
  const base = "untitled folder";
  const taken = new Set(allEntries.map((e) => e.name.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

async function createFolder() {
  if (!openDeviceId) return;
  const name = uniqueUntitledName();
  try {
    await window.api.invoke("create_dir", { path: pathFor(name) });
  } catch (err) {
    console.error("create_dir failed", name, err);
    alert(`Couldn't create folder:\n\n${err}`);
    return;
  }
  // A new folder is empty, so it adds no bytes — cached folder sizes stay
  // valid and need no invalidation. refreshList also clears any active format
  // filter, so the new folder is visible even if a filter was hiding folders.
  await refreshList();
  // Select it and open the rename field, like Finder's create-then-name flow.
  const idx = entries.findIndex((e) => e.is_dir && e.name === name);
  if (idx < 0) return;
  selected.clear();
  selected.add(pathFor(name));
  updateSelectionDOM();
  beginRename(idx);
}

// ---------------------------------------------------------------------------
// Rename (inline)
//
// Finder-style: swap the name cell/tile label for a text field, commit on
// Enter or blur, cancel on Escape. The backend `rename` is a device-side
// in-place rename (PTP SetObjectPropValue) — see commands::rename.

// Visible index of the single selected entry, or -1 if not exactly one.
function singleSelectedIndex() {
  if (selected.size !== 1) return -1;
  return entries.findIndex((e) => selected.has(pathFor(e.name)));
}

function beginRename(idx) {
  const entry = entries[idx];
  if (!entry) return;
  hideContextMenu();
  const container = viewMode === "list"
    ? listBody.querySelector(`tr[data-idx="${idx}"] .cell-name`)
    : gridEl.querySelector(`.tile[data-idx="${idx}"] .tile-name`);
  if (!container) return;

  container.textContent = "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = entry.name;
  input.spellcheck = false;
  container.appendChild(input);
  input.focus();
  selectStem(input, entry);

  // `blur` fires when the field is removed on commit/cancel, so guard against
  // running twice.
  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    applyRename(entry, input.value.trim());
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    renderList(); // restore the original cell
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // keep ⌘A / Delete / arrows out of the global handler
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
}

// Preselect the basename without its extension (Finder-style) so retyping the
// stem is one action. Folders and extensionless names select fully.
function selectStem(input, entry) {
  const dot = entry.name.lastIndexOf(".");
  if (!entry.is_dir && dot > 0) input.setSelectionRange(0, dot);
  else input.select();
}

async function applyRename(entry, newName) {
  if (!newName || newName === entry.name) { renderList(); return; }
  if (newName.includes("/")) {
    alert('A name can\'t contain "/".');
    renderList();
    return;
  }
  const path = pathFor(entry.name);
  try {
    await window.api.invoke("rename", { args: { path, new_name: newName } });
  } catch (err) {
    console.error("rename failed", path, err);
    alert(`Couldn't rename ${entry.name}:\n\n${err}`);
    renderList();
    return;
  }
  await refreshList();
  // Keep the renamed item selected under its new name.
  selected.clear();
  selected.add(pathFor(newName));
  updateSelectionDOM();
}

// Recursively total folders' sizes (Finder's "Calculate Size"). Each row's Size
// cell shows "Calculating…" then the byte total. Results live in folderSizeState
// keyed by object_id so a re-render (sort, view switch) keeps them; refreshList
// wipes them.
//
// Selecting hundreds of folders and sizing them at once has to stay responsive,
// so: mark every folder "calculating" with a SINGLE render here, then let the
// queue update one cell at a time as results arrive. Re-rendering the whole
// table per folder (what we did before) froze the UI on big selections.
// Throw away ALL computed sizes and pending work. Used only when the whole
// cache is meaningless: a device switch or unplug (object_id handles don't
// carry across sessions, and may be reused). Mutations use the targeted
// invalidators below so an edit to one folder doesn't wipe unrelated totals.
function invalidateFolderSizes() {
  folderSizeState.clear();
  sizeQueue.length = 0;
}

// Drop cached sizes that a content change at `dirPath` makes stale: `dirPath`
// itself and every ancestor (their totals include `dirPath`'s subtree).
// Siblings and unrelated branches keep their sizes. The trailing "/" guard
// stops "a/Down" from matching "a/Downloads". Used after an upload into a
// folder, and for the parent chain after a delete.
function invalidateAncestorsOf(dirPath) {
  for (const [id, v] of folderSizeState) {
    if (v.path === dirPath || dirPath.startsWith(v.path + "/")) folderSizeState.delete(id);
  }
}

// Drop cached sizes for a removed subtree: the folder at `removedPath` and
// anything cached beneath it. Those handles are gone and the device may reuse
// them for new objects, so a leftover entry could otherwise pin a dead size to
// a future folder. Used after a delete, per removed path.
function invalidateSubtree(removedPath) {
  for (const [id, v] of folderSizeState) {
    if (v.path === removedPath || v.path.startsWith(removedPath + "/")) folderSizeState.delete(id);
  }
}

function calculateFolderSizes(folders) {
  let queued = 0;
  for (const entry of folders) {
    const v = folderSizeState.get(entry.object_id);
    if (v) continue; // in flight or already known
    const path = pathFor(entry.name);
    folderSizeState.set(entry.object_id, { size: "calculating", path });
    sizeQueue.push({ entry, cwd, path });
    queued++;
  }
  if (queued > 0) renderList();
  pumpSizeQueue();
}

// Drain sizeQueue one folder at a time. Sequential on purpose: the backend
// serializes MTP access behind a single lock anyway, so concurrent dir_sizes
// calls wouldn't finish faster — they'd just tie up worker threads and starve
// other operations. One at a time keeps the device pipe busy and lets results
// stream in, and leaves a gap between folders where a navigation can interleave.
// Each call also returns the queried folder's whole subtree, so sizing a parent
// pre-fills its children — stepping in then shows their sizes immediately.
async function pumpSizeQueue() {
  if (sizeQueueRunning) return;
  sizeQueueRunning = true;
  let alerted = false;
  while (sizeQueue.length > 0) {
    const { entry, cwd: startedCwd, path } = sizeQueue.shift();
    if (cwd !== startedCwd) continue; // navigated away; state already cleared
    // Already resolved as a side effect of an earlier folder's subtree walk
    // (its ancestor was sized first) — don't re-walk it.
    const done = folderSizeState.get(entry.object_id);
    if (done && typeof done.size === "number") { updateFolderSizeCell(entry); continue; }
    try {
      // One walk returns the queried folder (rel_path "") and every folder
      // beneath it, so we cache the whole subtree — stepping into it later
      // shows child sizes with no recompute.
      const subtree = await window.api.invoke("dir_sizes", {
        args: { object_id: entry.object_id },
      });
      if (cwd !== startedCwd) continue; // navigated away while this one ran
      for (const f of subtree) {
        const fullPath = f.rel_path ? `${path}/${f.rel_path}` : path;
        folderSizeState.set(f.object_id, { size: f.size, path: fullPath });
      }
    } catch (err) {
      console.error("dir_sizes failed", entry.name, err);
      if (cwd === startedCwd) folderSizeState.delete(entry.object_id);
      if (!alerted) {
        alerted = true; // one alert per run, not one per folder
        alert(`Couldn't calculate folder size:\n\n${err}`);
      }
    }
    updateFolderSizeCell(entry); // O(1) cell repaint, not a full table rebuild
  }
  sizeQueueRunning = false;
}

// Repaint a single folder's Size cell from folderSizeState. No-op in grid view
// (no size shown there) or if the row isn't currently in the DOM.
function updateFolderSizeCell(entry) {
  if (viewMode !== "list") return;
  const row = listBody.querySelector(`tr[data-object-id="${entry.object_id}"]`);
  const cell = row && row.querySelector(".cell-size");
  if (cell) cell.textContent = folderSizeLabel(entry);
}

// ---------------------------------------------------------------------------
// Keyboard

document.addEventListener("keydown", (ev) => {
  // The conflict dialog is modal and may hold focus on its checkbox (an INPUT),
  // so handle it before the input guard below. Enter = Keep Both (the focused
  // default), Esc = cancel; swallow the rest so nothing fires behind it.
  if (!conflictDialog.hidden) {
    if (ev.key === "Enter") { ev.preventDefault(); resolveConflict("keepboth"); }
    else if (ev.key === "Escape") { ev.preventDefault(); resolveConflict("cancel"); }
    else if (!ev.metaKey && !ev.ctrlKey) ev.preventDefault();
    return;
  }

  // Don't hijack keys while typing in an input (the search box, inline rename,
  // the device-name field) — let arrows, Enter, etc. do their text thing there.
  const tag = ev.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  // The shortcuts overview is modal: while it's open only "?" and Esc act (they
  // close it, below). Swallow the rest so list shortcuts don't fire behind the
  // backdrop; leave OS combos (⌘C, ⌘Q…) untouched.
  if (!shortcutsHelp.hidden && ev.key !== "?" && ev.key !== "Escape") {
    if (!ev.metaKey && !ev.ctrlKey) ev.preventDefault();
    return;
  }

  if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === "n") {
    ev.preventDefault(); // Finder's New Folder shortcut
    createFolder();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "f") {
    ev.preventDefault(); // Finder's Find
    if (!searchInput.disabled) { searchInput.focus(); searchInput.select(); }
  } else if (ev.key === "?" && !ev.metaKey && !ev.ctrlKey) {
    ev.preventDefault(); // toggle the keyboard-shortcuts overview
    toggleShortcutsHelp();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "a") {
    if (entries.length === 0) return;
    ev.preventDefault();
    selected.clear();
    for (const e of entries) selected.add(pathFor(e.name));
    // Anchor at the top, lead at the bottom — so a following Shift+↑ shrinks
    // the all-selection from the end, the way Finder does after ⌘A.
    anchorIndex = 0;
    cursorIndex = entries.length - 1;
    updateSelectionDOM();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "c") {
    if (!openDeviceId || searchResultMode || selected.size === 0) return;
    ev.preventDefault(); // Copy the selection to the in-app clipboard
    setClipboard("copy");
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "x") {
    if (!openDeviceId || searchResultMode || selected.size === 0) return;
    ev.preventDefault(); // Cut (move on paste)
    setClipboard("cut");
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "v") {
    if (!openDeviceId || searchResultMode || !clipboard) return;
    ev.preventDefault(); // Paste into the current folder
    pasteClipboard();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "d") {
    if (!openDeviceId || searchResultMode || selected.size === 0) return;
    ev.preventDefault(); // Finder's Duplicate
    duplicateSelected();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "[") {
    ev.preventDefault(); // Finder's Back shortcut
    goBack();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "]") {
    ev.preventDefault(); // Finder's Forward shortcut
    goForward();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "o") {
    ev.preventDefault(); // Finder's Open shortcut
    openSelected();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "ArrowDown") {
    ev.preventDefault(); // Finder's ⌘↓ = open / descend
    openSelected();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "ArrowUp") {
    ev.preventDefault(); // Finder's ⌘↑ = open the enclosing folder
    goUp();
  } else if (
    !ev.metaKey && !ev.ctrlKey &&
    (ev.key === "ArrowDown" || ev.key === "ArrowUp" ||
     ev.key === "ArrowLeft" || ev.key === "ArrowRight" ||
     ev.key === "Home" || ev.key === "End")
  ) {
    if (searchResultMode || !openDeviceId || entries.length === 0) return;
    // List view has no horizontal axis (no disclosure tree), so leave ←/→ for
    // its default; only the grid is 2-D.
    if (viewMode === "list" && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) return;
    ev.preventDefault(); // arrows otherwise scroll the container under us
    const last = entries.length - 1;
    const cols = viewMode === "grid" ? gridColumns() : 1;
    let target;
    switch (ev.key) {
      case "ArrowDown":  target = cursorIndex < 0 ? 0 : cursorIndex + cols; break;
      case "ArrowUp":    target = cursorIndex < 0 ? last : cursorIndex - cols; break;
      case "ArrowRight": target = cursorIndex < 0 ? 0 : cursorIndex + 1; break;
      case "ArrowLeft":  target = cursorIndex < 0 ? last : cursorIndex - 1; break;
      case "Home":       target = 0; break;
      case "End":        target = last; break;
    }
    moveSelection(target, ev.shiftKey);
  } else if (ev.key === " ") {
    if (selected.size > 0) {
      ev.preventDefault(); // Quick Look — also stops Space scrolling the list
      quickLookSelected();
    }
  } else if (ev.key === "Backspace" || ev.key === "Delete") {
    if (selected.size === 0) return;
    ev.preventDefault();
    deleteSelected();
  } else if (ev.key === "Enter") {
    // Finder's rename shortcut: edit the single selected item in place.
    const idx = singleSelectedIndex();
    if (idx >= 0) {
      ev.preventDefault();
      beginRename(idx);
    }
  } else if (ev.key === "Escape") {
    if (!shortcutsHelp.hidden) { hideShortcutsHelp(); return; } // modal first
    hideContextMenu();
    hideDeviceMenu();
    hideSearchHelp();
    if (selected.size > 0) {
      selected.clear();
      anchorIndex = -1;
      cursorIndex = -1;
      updateSelectionDOM();
    }
  }
});

// The objects armed for the next drag-out (device-relative paths). Set on row
// mouseenter, cleared on mouseleave/cancel. Held until the drop so an in-window
// move (onDragInternal) knows the whole set — JS owns it because JS decided
// whether the gesture drags one row or the multi-selection (Swift just fans out
// one file promise per entry).
let dragOutItems = [];

function attachDragOut(tr, e) {
  // Native drag-out is initiated by the Swift event monitor on the first
  // mouseDragged after we "arm" the row. HTML5 drag is suppressed so the
  // WebView doesn't start its own drag session that competes with ours.
  //
  // Arming happens on `mouseenter` (not `mousedown`) so the Tauri IPC
  // roundtrip — ~50-100ms — completes BEFORE the user starts moving. With
  // `mousedown` arming, the user's first mouseDragged often fires within
  // ~15ms of mousedown, well before pending is set in Swift.
  tr.draggable = false;
  tr.addEventListener("dragstart", (ev) => ev.preventDefault());
  tr.addEventListener("mouseenter", () => armDragOut(e));
  tr.addEventListener("mouseleave", () => {
    window.api.invoke("drag_cancel");
    dragOutItems = [];
  });
}

// Arm the drag payload for the row under the cursor. Finder-style: if that row
// is part of a multi-selection, the whole selection drags; otherwise just the
// hovered row (its own click will have reduced the selection to it). Each entry
// becomes one file promise on the Swift side.
function armDragOut(hovered) {
  const hoveredPath = pathFor(hovered.name);
  let dragging;
  if (selected.size > 1 && selected.has(hoveredPath)) {
    // Map each selected path back to its entry for name/size/is_dir; infer from
    // the path if it isn't in the current listing (shouldn't happen — selection
    // is cleared on navigation — but keeps the drag well-formed regardless).
    dragging = [...selected].map((p) => {
      const found = allEntries.find((x) => pathFor(x.name) === p);
      return found
        ? { path: p, name: found.name, size: found.size ?? 0, isDir: found.is_dir }
        : { path: p, name: p.split("/").pop(), size: 0, isDir: p.lastIndexOf(".") <= 0 };
    });
  } else {
    dragging = [
      { path: hoveredPath, name: hovered.name, size: hovered.size ?? 0, isDir: hovered.is_dir },
    ];
  }
  dragOutItems = dragging.map((it) => it.path);
  window.api.invoke("drag_arm", {
    items: dragging.map((it) => ({
      object_path: it.path,
      suggested_name: it.name,
      size_bytes: it.size,
      is_dir: it.isDir,
    })),
  });
}

// The breadcrumb crumbs, following the device chip in the path bar. The device
// chip itself is the root (cwd ""), so we render only the path segments here —
// ancestors are clickable links (navigate, joining history), the current folder
// is bold and inert. Empty at the device root or with no device.
function renderBreadcrumb() {
  breadcrumbEl.innerHTML = "";
  if (!openDeviceId || !cwd) return;

  const segments = cwd.split("/");
  const acc = [];
  segments.forEach((seg, i) => {
    acc.push(seg);
    // A leading separator on every segment (including the first) reads as the
    // join from the device chip: "[chip ▾] › documents › Downloads".
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "›";
    breadcrumbEl.appendChild(sep);

    const isCurrent = i === segments.length - 1;
    const el = document.createElement(isCurrent ? "span" : "a");
    el.textContent = seg;
    el.className = isCurrent ? "crumb-current" : "crumb-link";
    if (!isCurrent) {
      const path = acc.join("/");
      el.addEventListener("click", () => navigateTo(path));
      // Ancestor crumbs are move targets for a dragged row (see
      // onDragInternal). The current crumb isn't tagged — moving into the
      // folder you're already in is a no-op.
      el.dataset.droppath = path;
    }
    breadcrumbEl.appendChild(el);
  });
}

navBackBtn.addEventListener("click", goBack);
navForwardBtn.addEventListener("click", goForward);
newFolderBtn.addEventListener("click", createFolder);

document.querySelectorAll("thead th").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (!key) return;
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
    renderList();
  });
});

// ---------------------------------------------------------------------------
// Resizable columns
//
// Columns auto-size to content by default (table-layout: auto — the nice
// default you get for free). The first drag of a divider freezes the current
// Size/Date widths into pixels and switches to table-layout: fixed so widths
// are honored exactly; Name is left without an explicit width, so it stays the
// flexible column that absorbs the remainder (rows always fill the width — no
// blank gap, no horizontal scroll). Widths live on the static <thead>, so they
// persist across re-renders and folders. Double-click a divider to reset.

const MIN_COL = 48;  // px floor for a resizable column
const MIN_NAME = 80; // px floor for the absorbing Name column

function initColumnResize() {
  const ths = listEl.querySelectorAll("thead th");
  if (ths.length < 3) return;
  const [nameTh, sizeTh, dateTh] = ths;
  addColResizer(nameTh, "name-size", sizeTh, dateTh); // Name│Size boundary
  addColResizer(sizeTh, "size-date", sizeTh, dateTh); // Size│Date boundary
}

// Freeze the current auto widths into explicit pixels and lock table-layout, so
// dragging is precise. No-op once already frozen (until a double-click reset).
function freezeColumns(sizeTh, dateTh) {
  if (listEl.style.tableLayout === "fixed") return;
  sizeTh.style.width = `${sizeTh.getBoundingClientRect().width}px`;
  dateTh.style.width = `${dateTh.getBoundingClientRect().width}px`;
  listEl.style.tableLayout = "fixed";
}

function addColResizer(th, boundary, sizeTh, dateTh) {
  const grip = document.createElement("span");
  grip.className = "col-resizer";
  grip.addEventListener("click", (ev) => ev.stopPropagation()); // a bare click mustn't sort
  grip.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    sizeTh.style.width = "";
    dateTh.style.width = "";
    listEl.style.tableLayout = ""; // back to the content-sized auto default
  });
  grip.addEventListener("mousedown", (ev) => {
    ev.preventDefault(); // no text selection / native drag
    freezeColumns(sizeTh, dateTh);
    const startX = ev.clientX;
    const sizeW0 = sizeTh.getBoundingClientRect().width;
    const dateW0 = dateTh.getBoundingClientRect().width;
    const tableW = listEl.getBoundingClientRect().width;
    document.body.classList.add("col-resizing");

    const onMove = (e) => {
      const dx = e.clientX - startX;
      if (boundary === "name-size") {
        // Drag right → Name grows, Size shrinks (Name absorbs). Keep Name ≥ min.
        const maxSize = tableW - dateW0 - MIN_NAME;
        sizeTh.style.width = `${Math.max(MIN_COL, Math.min(sizeW0 - dx, maxSize))}px`;
      } else {
        // Trade width between Size and Date; Name is unaffected.
        const total = sizeW0 + dateW0;
        const w = Math.max(MIN_COL, Math.min(sizeW0 + dx, total - MIN_COL));
        sizeTh.style.width = `${w}px`;
        dateTh.style.width = `${total - w}px`;
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  th.appendChild(grip);
}

// ---------------------------------------------------------------------------
// Storage info

async function refreshStorage() {
  const info = await window.api.invoke("storage_info");
  storageText = info
    ? `${humanSize(info.free_bytes)} free / ${humanSize(info.total_bytes)}`
    : "";
  updateStatusBar();
}

// Bottom status bar: item/selection count plus storage, mirroring Finder's
// "N items, X available". Empty when no device is open.
function updateStatusBar() {
  if (!openDeviceId) {
    statusEl.textContent = "";
    return;
  }
  const shown = entries.length;     // visible (after filter)
  const total = allEntries.length;  // everything in the folder
  const sel = selected.size;
  let count;
  if (sel > 0) {
    count = `${sel} of ${shown} selected`;
  } else if (activeFilters.size > 0 && shown !== total) {
    count = `${shown} of ${total} items`; // filtered down
  } else {
    count = `${shown} ${shown === 1 ? "item" : "items"}`;
  }
  statusEl.textContent = storageText ? `${count}  ·  ${storageText}` : count;
}

// ---------------------------------------------------------------------------
// Drag-in (Finder → app)

// Track in-app mouse drags so we don't mistake them (or the Swift drag-out
// session) for an external Finder→app drop. Without this, any mousedown
// inside the window — row drag-out, marquee gestures, even click+drag on
// empty space — pops the import overlay.
let internalDragInProgress = false;
document.addEventListener("mousedown", () => { internalDragInProgress = true; });
document.addEventListener("mouseup", () => { internalDragInProgress = false; });
window.addEventListener("blur", () => { internalDragInProgress = false; });

// ---------------------------------------------------------------------------
// Transfers (upload in / download out): progress bar + cancel.
//
// One job at a time — the device serializes anyway. The frontend mints the job
// id and shows the bar synchronously, so Cancel works even before the first
// byte. The backend streams throttled `transfer-progress` events; the command's
// promise resolving (or rejecting) ends the job. Drag-OUT to Finder is native
// (no command), so the backend drives the bar instead — `transfer-begin` /
// `transfer-end` events show and hide it (see onTransferBegin below).

const transferBar = $("transfer-bar");
const transferLabel = $("transfer-label");
const transferCount = $("transfer-count");
const transferFill = $("transfer-fill");
const transferCancelBtn = $("transfer-cancel");

let transferSeq = 0;
let activeTransfer = null; // { job, direction, cancelling } while one runs

// Claim a job and show the bar. Returns the job id, or null if one is already
// running (the caller should bail).
function startTransfer(direction) {
  if (aLongJobRunning()) return null;
  const job = ++transferSeq;
  activeTransfer = { job, direction, cancelling: false };
  transferLabel.textContent = direction === "upload" ? "Preparing upload…" : "Preparing…";
  transferCount.textContent = "";
  transferFill.style.width = "0%";
  transferCancelBtn.disabled = false;
  transferBar.hidden = false;
  return job;
}

function endTransfer() {
  transferBar.hidden = true;
  activeTransfer = null;
}

window.api.onTransferProgress(({ payload }) => {
  if (!activeTransfer || payload.job !== activeTransfer.job) return;
  if (activeTransfer.cancelling) {
    transferLabel.textContent = "Cancelling…";
  } else {
    const verb = payload.direction === "upload" ? "Uploading"
      : payload.direction === "copy" ? "Copying"
        : "Downloading";
    transferLabel.textContent = `${verb} ${payload.file_name}`;
  }
  transferCount.textContent =
    payload.file_count > 0
      ? `${payload.file_index} of ${payload.file_count}`
      : `${payload.file_index} file${payload.file_index === 1 ? "" : "s"}`;
  const pct =
    payload.file_total > 0
      ? Math.min(100, Math.round((payload.file_bytes / payload.file_total) * 100))
      : payload.file_bytes > 0
        ? 100
        : 0;
  transferFill.style.width = `${pct}%`;
});

transferCancelBtn.addEventListener("click", () => {
  if (!activeTransfer || activeTransfer.cancelling) return;
  activeTransfer.cancelling = true;
  transferLabel.textContent = "Cancelling…";
  transferCancelBtn.disabled = true;
  window.api.cancelTransfer(activeTransfer.job).catch((e) => console.error("cancel failed", e));
});

// Native drag-out has no frontend command to mint a job or show the bar, so the
// backend signals the bar's lifecycle: adopt the job it hands over and show the
// bar; the shared `transfer-progress` handler above then drives it. Ignore a
// begin while another transfer already owns the bar (the rare case of a drag-out
// starting atop a still-running background transfer) — the download still runs,
// just without its own bar.
window.api.onTransferBegin(({ payload }) => {
  if (activeTransfer) return;
  activeTransfer = { job: payload.job, direction: payload.direction, cancelling: false };
  transferLabel.textContent = "Downloading…";
  transferCount.textContent = "";
  transferFill.style.width = "0%";
  transferCancelBtn.disabled = false;
  transferBar.hidden = false;
});

window.api.onTransferEnd(({ payload }) => {
  if (activeTransfer && activeTransfer.job === payload.job) endTransfer();
});

window.api.onDragDrop(async (event) => {
  const payload = event.payload;
  if (payload.type === "enter" || payload.type === "over") {
    if (openDeviceId && !internalDragInProgress) dropzone.hidden = false;
  } else if (payload.type === "leave") {
    dropzone.hidden = true;
  } else if (payload.type === "drop") {
    dropzone.hidden = true;
    if (!openDeviceId || internalDragInProgress) return;
    if (aLongJobRunning()) {
      alert("A transfer or search is already in progress. Wait for it to finish or cancel it.");
      return;
    }
    // Resolve clashes against the current folder before claiming the transfer.
    // Finder hands us only paths, so is_dir is inferred from the leaf — it only
    // steers where " copy" lands on a Keep-Both rename.
    const existingLower = new Set(allEntries.map((e) => e.name.toLowerCase()));
    const dropped = payload.paths.map((p) => {
      const name = p.split("/").pop();
      return { source: p, name, isDir: name.lastIndexOf(".") <= 0 };
    });
    const resolved = await resolveConflicts(dropped, existingLower, { verb: "upload" });
    if (!resolved || resolved.length === 0) return;
    const job = startTransfer("upload");
    if (job === null) return; // a transfer slipped in
    try {
      await window.api.uploadFiles(
        job,
        resolved.map((r) => ({
          source: r.source,
          dest_name: r.destName,
          overwrite: r.overwrite,
          merge: r.merge,
        })),
        cwd,
      );
    } catch (err) {
      console.error("upload failed", err);
      alert(`Upload failed: ${err}`);
    } finally {
      endTransfer();
    }
    invalidateAncestorsOf(cwd); // new files grew this folder and its ancestors
    await Promise.all([refreshList(), refreshStorage()]);
  }
});

// ---------------------------------------------------------------------------
// Search
//
// One query language, one matcher, two scopes. A leading `all:` (or `here:`)
// sets scope; otherwise the default is the current folder. Current-folder search
// is a live client-side filter over `allEntries`. Everywhere search runs on
// Enter: a cancellable backend walk that STREAMS every object as `search-batch`
// events, matched here and rendered as a flat list with each result's location.
// Dates/times are matched in UTC to align with the displayed column (the device
// epoch is wall-clock-as-UTC — see formatModified).

const SEARCH_DAY = 86400;
const SEARCH_KINDS = {
  image: new Set(["jpg", "jpeg", "png", "gif", "bmp", "heic", "heif", "webp", "tiff", "tif", "raw", "dng", "cr2", "nef", "arw", "raf", "orf", "rw2"]),
  video: new Set(["mp4", "mov", "avi", "mkv", "webm", "m4v", "mpg", "mpeg", "wmv", "flv", "3gp"]),
  audio: new Set(["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "wma", "aiff", "opus"]),
  doc: new Set(["pdf", "doc", "docx", "txt", "rtf", "odt", "md", "ppt", "pptx", "xls", "xlsx", "csv", "pages"]),
  ebook: new Set(["epub", "mobi", "azw", "azw3", "kfx", "fb2", "cbz", "cbr", "pdf"]),
};

// --- parsing ---------------------------------------------------------------

function parseQuery(raw) {
  let s = raw.trim();
  let scope = "here";
  const scopeMatch = s.match(/^(all|everywhere|here)\s*:\s*/i);
  if (scopeMatch) {
    scope = /^h/i.test(scopeMatch[1]) ? "here" : "all";
    s = s.slice(scopeMatch[0].length);
  }
  const terms = [];
  const filters = { date: null, time: null, size: null, exts: null, kinds: null, isDir: null };
  for (const tok of tokenizeQuery(s)) {
    const m = tok.match(/^([a-z]+):(.*)$/i);
    if (m && parseField(m[1].toLowerCase(), m[2], filters)) continue;
    const t = tok.toLowerCase();
    if (t) terms.push(t);
  }
  return { scope, terms, filters };
}

// Split on whitespace, but keep "quoted phrases" together (for names with spaces).
function tokenizeQuery(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function parseField(field, value, filters) {
  switch (field) {
    case "date": { const d = parseDateExpr(value); if (d) { filters.date = d; return true; } return false; }
    case "time": { const t = parseTimeExpr(value); if (t) { filters.time = t; return true; } return false; }
    case "size": { const z = parseSizeExpr(value); if (z) { filters.size = z; return true; } return false; }
    case "ext":
    case "type": {
      const e = value.toLowerCase().replace(/^\./, "");
      if (!e) return false;
      (filters.exts ??= new Set()).add(e);
      return true;
    }
    case "kind": {
      const k = value.toLowerCase();
      if (k === "folder" || k === "dir") { filters.isDir = true; return true; }
      if (SEARCH_KINDS[k]) { (filters.kinds ??= []).push(k); return true; }
      return false;
    }
    case "is": {
      const v = value.toLowerCase();
      if (v === "folder" || v === "dir") { filters.isDir = true; return true; }
      if (v === "file") { filters.isDir = false; return true; }
      return false;
    }
    default: return false;
  }
}

function isQueryActive(q) {
  const f = q.filters;
  return q.terms.length > 0 || !!(f.date || f.time || f.size || f.exts || f.kinds) || f.isDir !== null;
}

function utcMidnight(y, m, d) { return Math.floor(Date.UTC(y, m, d) / 1000); }

// Bounds [from, to) in epoch seconds for a YYYY / YYYY-MM / YYYY-MM-DD period.
function periodBounds(v) {
  const ymd = v.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
  if (!ymd) return null;
  const y = +ymd[1], mo = ymd[2] ? +ymd[2] - 1 : null, d = ymd[3] ? +ymd[3] : null;
  if (d != null) return { from: utcMidnight(y, mo, d), to: utcMidnight(y, mo, d + 1) };
  if (mo != null) return { from: utcMidnight(y, mo, 1), to: utcMidnight(y, mo + 1, 1) };
  return { from: utcMidnight(y, 0, 1), to: utcMidnight(y + 1, 0, 1) };
}

function parseDateExpr(v) {
  v = v.trim().toLowerCase();
  const now = new Date();
  const today = utcMidnight(now.getFullYear(), now.getMonth(), now.getDate());
  if (v === "today") return { from: today, to: today + SEARCH_DAY };
  if (v === "yesterday") return { from: today - SEARCH_DAY, to: today };
  const rel = v.match(/^(\d+)d$/);
  if (rel) return { from: today - (parseInt(rel[1], 10) - 1) * SEARCH_DAY, to: today + SEARCH_DAY };
  const op = v.match(/^(>=|<=|>|<)\s*(.+)$/);
  if (op) {
    const b = periodBounds(op[2].trim());
    if (!b) return null;
    if (op[1] === ">") return { from: b.to, to: Infinity };
    if (op[1] === ">=") return { from: b.from, to: Infinity };
    if (op[1] === "<") return { from: -Infinity, to: b.from };
    return { from: -Infinity, to: b.to }; // <=
  }
  const range = v.match(/^(.+?)\.\.(.+)$/);
  if (range) {
    const a = periodBounds(range[1].trim()), c = periodBounds(range[2].trim());
    if (!a || !c) return null;
    return { from: a.from, to: c.to };
  }
  return periodBounds(v);
}

function parseTimeExpr(v) {
  const toMin = (s) => {
    const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return null;
    const h = +m[1], mi = m[2] ? +m[2] : 0;
    if (h > 23 || mi > 59) return null;
    return { min: h * 60 + mi, hourOnly: m[2] === undefined };
  };
  const range = v.trim().match(/^(.+?)\.\.(.+)$/);
  if (range) {
    const a = toMin(range[1]), b = toMin(range[2]);
    if (!a || !b) return null;
    return { lo: a.min, hi: b.hourOnly ? b.min + 59 : b.min }; // end hour inclusive
  }
  const one = toMin(v);
  if (!one) return null;
  return one.hourOnly ? { lo: one.min, hi: one.min + 59 } : { lo: one.min, hi: one.min };
}

function parseSizeExpr(v) {
  const bytes = (s) => {
    const m = s.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|k|m|g)?$/);
    if (!m) return null;
    const mult = { b: 1, k: 1024, kb: 1024, m: 1048576, mb: 1048576, g: 1073741824, gb: 1073741824 }[m[2] || "b"];
    return parseFloat(m[1]) * mult;
  };
  v = v.trim();
  const op = v.match(/^(>=|<=|>|<)\s*(.+)$/);
  if (op) {
    const n = bytes(op[2]); if (n == null) return null;
    if (op[1] === ">") return { min: n + 1, max: Infinity };
    if (op[1] === ">=") return { min: n, max: Infinity };
    if (op[1] === "<") return { min: 0, max: Math.max(0, n - 1) };
    return { min: 0, max: n }; // <=
  }
  const range = v.match(/^(.+?)\.\.(.+)$/);
  if (range) {
    const a = bytes(range[1]), b = bytes(range[2]);
    if (a == null || b == null) return null;
    return { min: a, max: b };
  }
  const n = bytes(v);
  return n == null ? null : { min: n, max: Infinity }; // bare size ≈ "at least"
}

// --- matching --------------------------------------------------------------

function matchTimeOfDay(ts, t) {
  const d = new Date(ts * 1000);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return t.lo <= t.hi ? mins >= t.lo && mins <= t.hi : mins >= t.lo || mins <= t.hi;
}

function matchEntry(e, q) {
  const name = e.name.toLowerCase();
  for (const t of q.terms) if (!name.includes(t)) return false;
  const f = q.filters;
  if (f.isDir !== null && e.is_dir !== f.isDir) return false;
  if (f.date && (e.modified_at == null || !(e.modified_at >= f.date.from && e.modified_at < f.date.to))) return false;
  if (f.time && (e.modified_at == null || !matchTimeOfDay(e.modified_at, f.time))) return false;
  if (f.size && (e.is_dir || e.size == null || !(e.size >= f.size.min && e.size <= f.size.max))) return false;
  if (f.exts && (e.is_dir || !f.exts.has(extOf(e.name)))) return false;
  if (f.kinds) {
    if (e.is_dir) return false;
    const ext = extOf(e.name);
    if (!f.kinds.some((k) => SEARCH_KINDS[k].has(ext))) return false;
  }
  return true;
}

// --- current-folder (live) -------------------------------------------------

function onSearchInput() {
  const q = parseQuery(searchInput.value);
  if (q.scope === "all") {
    // Recursive runs on Enter, not per keystroke — keep showing the folder.
    currentFolderQuery = null;
    if (!searchResultMode) applyFilter();
  } else {
    if (searchResultMode) exitSearchResults();
    currentFolderQuery = isQueryActive(q) ? q : null;
    applyFilter();
  }
}

// --- everywhere (recursive) ------------------------------------------------

async function runEverywhereSearch(q) {
  if (!openDeviceId || aLongJobRunning()) return;
  const job = ++transferSeq;
  activeSearch = { job, query: q, cancelling: false };
  searchResults = [];
  searchResultMode = true;
  searchStrip.hidden = false;
  searchCancelBtn.textContent = "Cancel";
  searchCancelBtn.disabled = false;
  searchStatusEl.textContent = "Searching everywhere…  0 found";
  renderSearchResults();
  let cancelled = false;
  try {
    await window.api.search(job, ""); // whole device
  } catch (err) {
    console.error("search failed", err);
  } finally {
    cancelled = activeSearch ? activeSearch.cancelling : false;
    activeSearch = null;
    renderSearchResults(); // refresh empty-state now that the walk is done
    const n = searchResults.length;
    searchStatusEl.textContent =
      `${cancelled ? "Search cancelled" : "Everywhere"} · ${n} result${n === 1 ? "" : "s"}`;
    searchCancelBtn.textContent = "Clear";
    searchCancelBtn.disabled = false;
  }
}

window.api.onSearchBatch(({ payload }) => {
  if (!activeSearch || payload.job !== activeSearch.job) return;
  // Append only this batch's matches — rebuilding the whole list each batch
  // would be quadratic over a big walk.
  const matched = [];
  for (const e of payload.entries) {
    if (matchEntry(e, activeSearch.query)) { searchResults.push(e); matched.push(e); }
  }
  if (!activeSearch.cancelling) {
    searchStatusEl.textContent = `Searching everywhere…  ${searchResults.length} found`;
  }
  if (matched.length) {
    emptyEl.hidden = true;
    for (const e of matched) listBody.appendChild(buildSearchRow(e));
  }
});

searchCancelBtn.addEventListener("click", () => {
  if (activeSearch && !activeSearch.cancelling) {
    activeSearch.cancelling = true;
    searchStatusEl.textContent = "Cancelling…";
    searchCancelBtn.disabled = true;
    window.api.cancelTransfer(activeSearch.job).catch((e) => console.error("cancel failed", e));
  } else if (!activeSearch) {
    clearSearch(); // the button reads "Clear" once the walk has finished
  }
});

function buildSearchRow(e) {
  const tr = document.createElement("tr");
  tr.className = "search-row";

  const nameTd = document.createElement("td");
  nameTd.className = "cell-name";
  const nameLine = document.createElement("div");
  nameLine.textContent = `${e.is_dir ? "📁" : "📄"} ${e.name}`;
  const locLine = document.createElement("div");
  locLine.className = "search-loc search-loc-link";
  locLine.textContent = e.dir || "device root";
  locLine.title = "Reveal in folder";
  locLine.addEventListener("click", (ev) => { ev.stopPropagation(); navigateTo(e.dir); });
  nameTd.append(nameLine, locLine);

  const sizeTd = document.createElement("td");
  sizeTd.className = "cell-size";
  sizeTd.textContent = e.is_dir ? "—" : e.size != null ? humanSize(e.size) : "—";
  const modTd = document.createElement("td");
  modTd.className = "cell-modified";
  modTd.textContent = formatModified(e.modified_at);

  tr.append(nameTd, sizeTd, modTd);
  tr.addEventListener("dblclick", () => openSearchResult(e));
  return tr;
}

function renderSearchResults() {
  gridEl.hidden = true;
  listEl.hidden = false;
  listBody.innerHTML = "";
  for (const e of searchResults) listBody.appendChild(buildSearchRow(e));
  const showEmpty = searchResults.length === 0 && !activeSearch;
  emptyEl.textContent = "No matches.";
  emptyEl.hidden = !showEmpty;
}

function openSearchResult(e) {
  const path = e.dir ? `${e.dir}/${e.name}` : e.name;
  if (e.is_dir) navigateTo(path); // navigateTo resets search for us
  else openObjectAt(path, e.object_id, e.name);
}

// --- exit / reset ----------------------------------------------------------

function exitSearchResults() {
  if (activeSearch) {
    window.api.cancelTransfer(activeSearch.job).catch(() => {});
    activeSearch = null;
  }
  searchResultMode = false;
  searchResults = [];
  searchStrip.hidden = true;
}

// Full reset on navigation/device switch: drop results AND the input text.
function resetSearch() {
  exitSearchResults();
  currentFolderQuery = null;
  searchInput.value = "";
}

function clearSearch() {
  resetSearch();
  applyFilter(); // re-render the current folder (cwd is unchanged)
}

function aLongJobRunning() {
  return activeTransfer !== null || activeSearch !== null;
}

searchInput.addEventListener("input", onSearchInput);
searchInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    const q = parseQuery(searchInput.value);
    if (q.scope === "all" && isQueryActive(q)) { ev.preventDefault(); runEverywhereSearch(q); }
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    if (!searchHelp.hidden) { hideSearchHelp(); return; }
    clearSearch();
    searchInput.blur();
  }
});

// Syntax cheat-sheet popover, toggled by the "?" beside the search box. Same
// open/close idiom as the device menu (click-away + Esc + window blur close it).
function hideSearchHelp() { searchHelp.hidden = true; }
searchHelpBtn.addEventListener("click", () => { searchHelp.hidden = !searchHelp.hidden; });

// Keyboard-shortcuts overview, toggled by "?". Opening it dismisses the other
// popovers so they don't peek out from under the backdrop.
function hideShortcutsHelp() { shortcutsHelp.hidden = true; }
function toggleShortcutsHelp() {
  if (!shortcutsHelp.hidden) { hideShortcutsHelp(); return; }
  hideContextMenu();
  hideDeviceMenu();
  hideSearchHelp();
  shortcutsHelp.hidden = false;
}
shortcutsClose.addEventListener("click", hideShortcutsHelp);
// Click on the dim backdrop (the overlay itself, not the card) closes it.
shortcutsHelp.addEventListener("mousedown", (ev) => {
  if (ev.target === shortcutsHelp) hideShortcutsHelp();
});

// ---------------------------------------------------------------------------
// In-app move by drag (onto a folder row/tile, a breadcrumb crumb, or the chip)
//
// Drag-out is a NATIVE macOS drag (see FilePromise.swift), so the WebView gets
// no DOM drag events. Swift instead streams the cursor position back as
// `drag-internal` events: phase 1 while moving, phase 2 when released inside
// the window (Finder didn't take it), phase 0 when released outside. Anything
// carrying a `data-droppath` is a drop target — the ancestor crumbs and the
// device chip (= root) in the path bar, plus every folder row/tile in the
// listing. We highlight the one under the cursor and, on an in-window drop,
// relocate the dragged object there with the `move_object` command.

// The device chip is the path root, so it's the "move to top level" target.
// Tagged once; the handler still gates on an open device and a real change.
deviceChip.dataset.droppath = "";

let dragHoverTarget = null; // drop-target element currently highlighted, if any

// The drop target under a client point: the nearest ancestor carrying a
// destination path (a crumb, the chip, or a folder row/tile). null when the
// point isn't over one, or when it's one of the dragged objects' own rows — a
// folder can't be moved into itself (or into another item being dragged).
function dropTargetAt(x, y, sourcePaths) {
  const el = document.elementFromPoint(x, y);
  const target = el ? el.closest("[data-droppath]") : null;
  if (target && sourcePaths.includes(target.dataset.droppath)) return null;
  return target;
}

function clearDropHighlight() {
  if (dragHoverTarget) {
    dragHoverTarget.classList.remove("drop-target-active");
    dragHoverTarget = null;
  }
}

async function commitMoveMany(sourcePaths, destDir) {
  if (!sourcePaths.length) return;
  // The drop target is usually NOT the folder we're viewing (a sub-folder row,
  // an ancestor crumb, or the root chip), so fetch its listing once to detect
  // clashes. `cwd` is the rare exception and reuses the in-memory listing.
  let destNamesLower;
  try {
    const listing =
      destDir === cwd ? allEntries : await window.api.invoke("list_dir", { path: destDir });
    destNamesLower = new Set(listing.map((e) => e.name.toLowerCase()));
  } catch (err) {
    console.error("move: couldn't read destination", destDir, err);
    alert(`Couldn't move:\n\n${err}`);
    return;
  }
  // is_dir is known when the source is in the current listing; else infer it.
  const items = sourcePaths.map((p) => {
    const name = p.split("/").pop();
    const here = allEntries.find((e) => pathFor(e.name) === p);
    const isDir = here ? here.is_dir : name.lastIndexOf(".") <= 0;
    return { source: p, name, isDir };
  });
  const resolved = await resolveConflicts(items, destNamesLower, { verb: "move" });
  if (!resolved || resolved.length === 0) return;
  let failures = 0;
  for (const r of resolved) {
    try {
      await window.api.moveObject(r.source, destDir, r.destName, r.overwrite);
    } catch (err) {
      failures++;
      console.error("move failed", r.source, "→", destDir, err);
    }
  }
  if (failures) {
    alert(`Couldn't move ${failures} item${failures > 1 ? "s" : ""}.`);
  }
  // The objects left `cwd` and landed in `destDir`; cached folder sizes along
  // both chains are now wrong. Invalidate ancestors of each, then refresh.
  invalidateAncestorsOf(cwd);
  invalidateAncestorsOf(destDir);
  await Promise.all([refreshList(), refreshStorage()]);
}

window.api.onDragInternal(({ payload }) => {
  const { x, y, phase } = payload;
  // The dragged set is whatever JS armed for this gesture (one row or the whole
  // selection); the event's own path is ignored in favor of that.
  const sources = dragOutItems;
  if (phase === 1) {
    // Moving: mark the bar droppable and highlight the target under the cursor.
    pathBar.classList.add("drag-active");
    const target = dropTargetAt(x, y, sources);
    if (target !== dragHoverTarget) {
      clearDropHighlight();
      if (target) {
        target.classList.add("drop-target-active");
        dragHoverTarget = target;
      }
    }
    return;
  }
  // Any other phase = the drag ended. Commit to whatever target was lit at
  // release — that's exactly what the user saw under the cursor. We trust the
  // tracked hover target over re-hit-testing the end coordinates, because
  // AppKit's `endedAt` doesn't reliably report the release point (it can hand
  // back a slide-back/origin point, which would miss the target). Fall back to
  // a coordinate hit-test only if nothing was highlighted.
  pathBar.classList.remove("drag-active");
  internalDragInProgress = false; // the native drag likely consumed our mouseup
  const target = dragHoverTarget || dropTargetAt(x, y, sources);
  clearDropHighlight();
  if (target && openDeviceId && sources.length) {
    const destDir = target.dataset.droppath; // "" = device root
    // Skip a no-op move into the folder the objects already live in (e.g.
    // dropping on the chip while at root). dropTargetAt already excluded a drop
    // on a dragged object's own row.
    if (destDir !== cwd) commitMoveMany(sources, destDir);
  }
  dragOutItems = []; // gesture finished; release the armed set
});

// ---------------------------------------------------------------------------
// Helpers

function humanSize(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

// modified_at is the device's recorded wall-clock encoded as a UTC-based epoch
// (the device gives no usable timezone — see datetime_to_unix in mtp-core). We
// must render it back in UTC so the user sees exactly what the device wrote;
// using the local zone here would re-shift every timestamp by the viewer's
// offset. Returns "—" for entries with no date (e.g. folders).
function formatModified(epochSecs) {
  if (!epochSecs) return "—";
  return new Date(epochSecs * 1000).toLocaleString(undefined, { timeZone: "UTC" });
}

// Size-column text for a folder row. Folders have no size until the user asks
// for one via "Calculate Size" (see calculateFolderSizes); until then, "—".
function folderSizeLabel(e) {
  const v = folderSizeState.get(e.object_id);
  if (!v) return "—";
  if (v.size === "calculating") return "Calculating…";
  if (typeof v.size === "number") return humanSize(v.size);
  return "—";
}

// The chip is the path root: its body jumps to the device's top level, while
// the ▾ chevron opens the device switcher. With no device open there's no root
// to go to, so the whole chip falls back to opening the menu (to pick/refresh).
deviceChip.addEventListener("click", () => {
  if (openDeviceId) {
    hideDeviceMenu();
    navigateTo("");
  } else {
    toggleDeviceMenu();
  }
});
deviceChipChevron.addEventListener("click", (ev) => {
  ev.stopPropagation(); // don't also trigger the chip's go-to-root click
  toggleDeviceMenu();
});
// Re-enumerate when the window regains focus so hot-plugged devices show up
// without the user having to open the chip menu first. Cheap call.
window.addEventListener("focus", () => { refreshDevices(); });

viewListBtn.addEventListener("click", () => setViewMode("list"));
viewGridBtn.addEventListener("click", () => setViewMode("grid"));

function setViewMode(mode) {
  if (viewMode === mode) return;
  viewMode = mode;
  viewListBtn.classList.toggle("active", mode === "list");
  viewGridBtn.classList.toggle("active", mode === "grid");
  renderList();
}

// ---------------------------------------------------------------------------
// Boot

updateNavButtons(); // disabled until a device opens and seeds history
initColumnResize();
refreshDevices({ autoOpen: true });
