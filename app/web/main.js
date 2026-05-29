// Finder-shaped browser UI. All backend calls go through `window.api`
// (defined in api.js). No build step — this file is served as-is by Tauri.

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
};

const deviceChip = $("device-chip");
const deviceChipLabel = $("device-chip-label");
const deviceMenu = $("device-menu");
const breadcrumbEl = $("breadcrumb");
const storageEl = $("storage");
const listEl = $("list");
const listBody = $("list-body");
const gridEl = $("grid");
const emptyEl = $("empty");
const dropzone = $("dropzone-overlay");
const contextMenu = $("context-menu");
const upBtn = $("up");
const viewListBtn = $("view-list");
const viewGridBtn = $("view-grid");

// ---------------------------------------------------------------------------
// App state

let openDeviceId = null;
let cwd = ""; // device-relative, no leading slash
let entries = [];
let sortKey = "name";
let sortDir = "asc";
let viewMode = "list"; // "list" or "grid"

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
// session). Value is the literal "calculating" while a dir_size call is in
// flight, or a byte count once it resolves. Read by the list view's size cell;
// cleared on every refreshList so a fresh listing recomputes rather than
// showing a possibly-stale total. See calculateFolderSize.
const folderSizeState = new Map();

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
  deviceChipLabel.textContent = open ? open.label : "No device";
  deviceChip.title = open
    ? `${open.vendor_id.toString(16)}:${open.product_id.toString(16)} · ${open.id}`
    : "Pick a device";
  deviceChip.classList.toggle("no-device", !open);
  // Hide the chevron when there's nothing to switch to — the chip then reads
  // as a label rather than a control. Still clickable to refresh.
  deviceChip.classList.toggle("solo", lastDevices.length <= 1);
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
      label.textContent = d.label;
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
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "device-menu-refresh";
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
  emptyEl.hidden = true;
  updateDeviceChip();
  await Promise.all([refreshList(), refreshStorage()]);
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
  try {
    await window.api.invoke("close_device");
  } catch (err) {
    console.error("close_device failed", err);
  }
  updateDeviceChip();
  await refreshList();
  renderBreadcrumb(); // reset to just "Device" (refreshList skips it when no device)
  storageEl.textContent = "";
}

// ---------------------------------------------------------------------------
// List view

async function refreshList() {
  selected.clear();
  anchorIndex = -1;
  folderSizeState.clear();
  if (!openDeviceId) {
    entries = [];
    renderList();
    return;
  }
  entries = await window.api.invoke("list_dir", { path: cwd });
  renderList();
  renderBreadcrumb();
}

function sortEntries() {
  const dir = sortDir === "asc" ? 1 : -1;
  entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    switch (sortKey) {
      case "name":     return a.name.localeCompare(b.name) * dir;
      case "size":     return ((a.size ?? 0) - (b.size ?? 0)) * dir;
      case "modified": return ((a.modified_at ?? 0) - (b.modified_at ?? 0)) * dir;
      default:         return 0;
    }
  });
}

function renderList() {
  sortEntries();
  renderGen++;

  if (entries.length === 0 && openDeviceId) {
    emptyEl.textContent = "Empty folder.";
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = entries.length > 0 || !!openDeviceId;
    if (!openDeviceId) emptyEl.textContent = "Connect an MTP device to begin.";
  }

  listEl.hidden = viewMode !== "list";
  gridEl.hidden = viewMode !== "grid";
  if (viewMode === "list") renderListView();
  else renderGridView();
}

function renderListView() {
  listBody.innerHTML = "";
  entries.forEach((e, idx) => {
    const tr = document.createElement("tr");
    tr.dataset.name = e.name;
    tr.dataset.isDir = String(e.is_dir);
    tr.dataset.idx = String(idx);
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
      if (e.is_dir) {
        cwd = cwd ? `${cwd}/${e.name}` : e.name;
        refreshList();
      }
    });
    tr.addEventListener("contextmenu", (ev) => onRowContextMenu(idx, ev));

    if (!e.is_dir) attachDragOut(tr, e);

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
    if (e.is_dir) {
      cwd = cwd ? `${cwd}/${e.name}` : e.name;
      refreshList();
    }
  });
  tile.addEventListener("contextmenu", (ev) => onRowContextMenu(idx, ev));
  if (!e.is_dir) attachDragOut(tile, e);
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
  const anyFile = selectedEntries.some((e) => !e.is_dir);
  const selectedFolders = selectedEntries.filter((e) => e.is_dir);
  const count = selected.size;

  const items = [
    {
      label: count > 1 ? `Save ${count} items to…` : "Save to…",
      disabled: !anyFile,
      onSelect: saveSelectedTo,
    },
  ];
  // Recursive folder sizing only has somewhere to show in the list view, so
  // only offer it there. Acts on the folders in the selection; any files are
  // left alone (they already show a size).
  if (viewMode === "list" && selectedFolders.length > 0) {
    items.push({
      label: selectedFolders.length > 1
        ? `Calculate size of ${selectedFolders.length} folders`
        : "Calculate Size",
      onSelect: () => selectedFolders.forEach(calculateFolderSize),
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
  await Promise.all([refreshList(), refreshStorage()]);
}

async function saveSelectedTo() {
  if (selected.size === 0) return;
  const destDir = await window.api.pickFolder("Save to…");
  if (!destDir) return;
  for (const path of [...selected]) {
    const name = path.split("/").pop();
    const ent = entries.find((x) => x.name === name);
    // Skip dirs for now — recursive MTP download isn't wired yet.
    if (!ent || ent.is_dir) continue;
    try {
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

// Recursively total a folder's size (Finder's "Calculate Size"). The row's
// Size cell shows "Calculating…" while the dir_size call runs, then the byte
// total. The result lives in folderSizeState keyed by object_id so a re-render
// (sort, another folder finishing) keeps it; refreshList wipes it. Folders can
// be sized concurrently — each call repaints only if we're still in the folder
// it was started from, so a result that lands after the user navigated away is
// dropped rather than written into the wrong listing.
async function calculateFolderSize(entry) {
  if (folderSizeState.get(entry.object_id) === "calculating") return;
  const startedCwd = cwd;
  const path = pathFor(entry.name);
  folderSizeState.set(entry.object_id, "calculating");
  renderList();
  try {
    const bytes = await window.api.invoke("dir_size", { path });
    if (cwd !== startedCwd) return;
    folderSizeState.set(entry.object_id, bytes);
  } catch (err) {
    console.error("dir_size failed", path, err);
    if (cwd === startedCwd) folderSizeState.delete(entry.object_id);
    alert(`Couldn't calculate the size of ${entry.name}:\n\n${err}`);
  }
  if (cwd === startedCwd) renderList();
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
  } else if (ev.key === "Backspace" || ev.key === "Delete") {
    if (selected.size === 0) return;
    ev.preventDefault();
    deleteSelected();
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
    });
  });
  tr.addEventListener("mouseleave", () => {
    window.api.invoke("drag_cancel");
  });
}

function renderBreadcrumb() {
  breadcrumbEl.innerHTML = "";

  const rootLink = document.createElement("a");
  rootLink.textContent = "Device";
  rootLink.addEventListener("click", () => {
    cwd = "";
    refreshList();
  });
  breadcrumbEl.appendChild(rootLink);

  if (!cwd) {
    upBtn.disabled = true;
    return;
  }

  const segments = cwd.split("/");
  const acc = [];
  for (const seg of segments) {
    acc.push(seg);
    const sep = document.createElement("span");
    sep.textContent = " / ";
    breadcrumbEl.appendChild(sep);
    const a = document.createElement("a");
    a.textContent = seg;
    const path = acc.join("/");
    a.addEventListener("click", () => {
      cwd = path;
      refreshList();
    });
    breadcrumbEl.appendChild(a);
  }
  upBtn.disabled = false;
}

upBtn.addEventListener("click", () => {
  if (!cwd) return;
  cwd = cwd.split("/").slice(0, -1).join("/");
  refreshList();
});

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
// Storage info

async function refreshStorage() {
  const info = await window.api.invoke("storage_info");
  if (!info) {
    storageEl.textContent = "";
    return;
  }
  storageEl.textContent = `${humanSize(info.free_bytes)} free / ${humanSize(info.total_bytes)}`;
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
    await Promise.all([refreshList(), refreshStorage()]);
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
// for one via "Calculate Size" (see calculateFolderSize); until then, "—".
function folderSizeLabel(e) {
  const s = folderSizeState.get(e.object_id);
  if (s === "calculating") return "Calculating…";
  if (typeof s === "number") return humanSize(s);
  return "—";
}

deviceChip.addEventListener("click", toggleDeviceMenu);
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

refreshDevices({ autoOpen: true });
