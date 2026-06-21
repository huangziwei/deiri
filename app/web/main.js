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

// ---------------------------------------------------------------------------
// App state

let openDeviceId = null;
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
let anchorIndex = -1; // for shift-click range; -1 when no anchor

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
  if (navIndex >= 0 && navHistory[navIndex] === path) return; // already here
  navHistory = navHistory.slice(0, navIndex + 1);
  navHistory.push(path);
  navIndex = navHistory.length - 1;
  cwd = path;
  updateNavButtons();
  refreshList();
}

function goBack() {
  if (navIndex <= 0) return;
  navIndex--;
  cwd = navHistory[navIndex];
  updateNavButtons();
  refreshList();
}

function goForward() {
  if (navIndex >= navHistory.length - 1) return;
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
  endRename(); // if the device vanished mid-rename, restore the chip
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
  renderFilterPills(); // refresh active states
  applyFilter();
}

// Derive the rendered `entries` from `allEntries`. With no filter, show
// everything. When a format filter is active, hide folders too — "show me PDFs"
// shouldn't leave subfolders cluttering the view; only matching files pass.
function applyFilter() {
  entries = activeFilters.size === 0
    ? allEntries.slice()
    : allEntries.filter((e) => !e.is_dir && activeFilters.has(extOf(e.name)));
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
  sortEntries();
  renderGen++;

  if (entries.length === 0 && openDeviceId) {
    emptyEl.textContent = activeFilters.size > 0 ? "No items match the filter." : "Empty folder.";
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
    if (selected.has(pathFor(e.name))) tr.classList.add("selected");

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
    tr.addEventListener("dblclick", () => {
      if (e.is_dir) navigateTo(cwd ? `${cwd}/${e.name}` : e.name);
    });
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
  if (selected.has(pathFor(e.name))) tile.classList.add("selected");

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
  tile.addEventListener("dblclick", () => {
    if (e.is_dir) navigateTo(cwd ? `${cwd}/${e.name}` : e.name);
  });
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
  // Rename is a single-item action (in-place device rename).
  if (count === 1) {
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
  items.push({ separator: true });
  items.push({
    label: count > 1 ? `Delete ${count} items` : "Delete",
    onSelect: deleteSelected,
  });

  showContextMenu(ev.clientX, ev.clientY, items);
}

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
});
window.addEventListener("blur", () => {
  hideContextMenu();
  hideDeviceMenu();
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
  const destDir = await window.api.pickFolder("Save to…");
  if (!destDir) return;
  for (const path of [...selected]) {
    const name = path.split("/").pop();
    const ent = entries.find((x) => x.name === name);
    if (!ent) continue;
    try {
      // download_to recreates a folder's whole subtree at dest when source is
      // a directory; for a file it just writes the file.
      await window.api.invoke("download_to", {
        args: { source: path, dest: `${destDir}/${name}` },
      });
    } catch (err) {
      console.error("download failed", path, err);
      alert(`Couldn't save ${name}:\n\n${err}`);
      break;
    }
  }
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
  // Don't hijack keys while typing in an input/textarea (we have none yet,
  // but a future search box would want them).
  const tag = ev.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if ((ev.metaKey || ev.ctrlKey) && ev.key === "a") {
    if (entries.length === 0) return;
    ev.preventDefault();
    selected.clear();
    for (const e of entries) selected.add(pathFor(e.name));
    anchorIndex = entries.length - 1;
    updateSelectionDOM();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "[") {
    ev.preventDefault(); // Finder's Back shortcut
    goBack();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "]") {
    ev.preventDefault(); // Finder's Forward shortcut
    goForward();
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
    hideContextMenu();
    hideDeviceMenu();
    if (selected.size > 0) {
      selected.clear();
      anchorIndex = -1;
      updateSelectionDOM();
    }
  }
});

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
  tr.addEventListener("mouseenter", () => {
    window.api.invoke("drag_arm", {
      objectPath: cwd ? `${cwd}/${e.name}` : e.name,
      suggestedName: e.name,
      sizeBytes: e.size ?? 0,
      isDir: e.is_dir,
    });
  });
  tr.addEventListener("mouseleave", () => {
    window.api.invoke("drag_cancel");
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

window.api.onDragDrop(async (event) => {
  const payload = event.payload;
  if (payload.type === "enter" || payload.type === "over") {
    if (openDeviceId && !internalDragInProgress) dropzone.hidden = false;
  } else if (payload.type === "leave") {
    dropzone.hidden = true;
  } else if (payload.type === "drop") {
    dropzone.hidden = true;
    if (!openDeviceId || internalDragInProgress) return;
    try {
      await window.api.invoke("upload_files", {
        args: { sources: payload.paths, dest_dir: cwd },
      });
    } catch (err) {
      console.error("upload failed", err);
      alert(`Upload failed: ${err}`);
    }
    invalidateAncestorsOf(cwd); // new files grew this folder and its ancestors
    await Promise.all([refreshList(), refreshStorage()]);
  }
});

// ---------------------------------------------------------------------------
// Drag onto the breadcrumb (in-app move to an ancestor folder)
//
// Drag-out is a NATIVE macOS drag (see FilePromise.swift), so the WebView gets
// no DOM drag events. Swift instead streams the cursor position back as
// `drag-internal` events: phase 1 while moving, phase 2 when released inside
// the window (Finder didn't take it), phase 0 when released outside. We treat
// the path bar's ancestor crumbs (and the device chip = root) as drop targets:
// highlight the one under the cursor, and on an in-window drop relocate the
// dragged object there with the `move_object` command.

// The device chip is the path root, so it's the "move to top level" target.
// Tagged once; the handler still gates on an open device and a real change.
deviceChip.dataset.droppath = "";

let dragHoverTarget = null; // drop-target element currently highlighted, if any

// The drop target under a client point: the nearest ancestor carrying a
// destination path (crumbs + the chip). null when the point isn't over one.
function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest("[data-droppath]") : null;
}

function clearDropHighlight() {
  if (dragHoverTarget) {
    dragHoverTarget.classList.remove("drop-target-active");
    dragHoverTarget = null;
  }
}

async function commitBreadcrumbMove(sourcePath, destDir) {
  const name = sourcePath.split("/").pop();
  try {
    await window.api.invoke("move_object", {
      args: { source: sourcePath, dest_dir: destDir },
    });
  } catch (err) {
    console.error("move failed", sourcePath, "→", destDir, err);
    alert(`Couldn't move ${name}:\n\n${err}`);
    return;
  }
  // The object left `cwd` and landed in `destDir`; cached folder sizes along
  // both chains are now wrong. Invalidate ancestors of each, then refresh.
  invalidateAncestorsOf(cwd);
  invalidateAncestorsOf(destDir);
  await Promise.all([refreshList(), refreshStorage()]);
}

window.api.onDragInternal(({ payload }) => {
  const { object_path: sourcePath, x, y, phase } = payload;
  if (phase === 1) {
    // Moving: mark the bar droppable and highlight the crumb under the cursor.
    pathBar.classList.add("drag-active");
    const target = dropTargetAt(x, y);
    if (target !== dragHoverTarget) {
      clearDropHighlight();
      if (target) {
        target.classList.add("drop-target-active");
        dragHoverTarget = target;
      }
    }
    return;
  }
  // Any other phase = the drag ended. Commit to whatever crumb was lit at
  // release — that's exactly what the user saw under the cursor. We trust the
  // tracked hover target over re-hit-testing the end coordinates, because
  // AppKit's `endedAt` doesn't reliably report the release point (it can hand
  // back a slide-back/origin point, which would miss the crumb). Fall back to
  // a coordinate hit-test only if nothing was highlighted.
  pathBar.classList.remove("drag-active");
  internalDragInProgress = false; // the native drag likely consumed our mouseup
  const target = dragHoverTarget || dropTargetAt(x, y);
  clearDropHighlight();
  if (target && openDeviceId) {
    const destDir = target.dataset.droppath; // "" = device root
    // Guard the no-op move into the object's current folder (crumbs are
    // ancestors so this shouldn't be a target, but the chip-at-root case can).
    if (destDir !== cwd) commitBreadcrumbMove(sourcePath, destDir);
  }
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
