// Finder-shaped browser UI. All backend calls go through `window.api`
// (defined in api.js). No build step — this file is served as-is by Tauri.

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
};

const deviceListEl = $("device-list");
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
const refreshDevicesBtn = $("refresh-devices");

// ---------------------------------------------------------------------------
// App state

let openDeviceId = null;
let cwd = ""; // device-relative, no leading slash
let entries = [];
let sortKey = "name";
let sortDir = "asc";
let viewMode = "list"; // "list" or "grid"

// Per-listing thumbnail cache: device-relative path → object URL.
// Cleared on every refreshList so we don't keep blob URLs alive across
// folder changes (each one pins a Vec<u8> in the WebView).
const thumbCache = new Map();
let thumbObserver = null;
// Cap concurrent get_thumbnail IPC calls. Each one serializes through the
// MTP session mutex on the Rust side, and Tauri's command workers are
// finite — flooding 50+ calls at once on a folder of camera shots freezes
// the UI while the queue drains.
const MAX_THUMB_LOADS = 4;
const thumbQueue = [];
let activeThumbLoads = 0;
// Bumped on every render so in-flight loads can detect that the user
// switched view mode or folder and bail instead of writing into stale DOM.
let renderGen = 0;

// Selection. Holds device-relative paths (`cwd` + name) so it's stable
// across re-renders. Cleared on every refreshList — selection only lives
// inside the current directory listing.
const selected = new Set();
let anchorIndex = -1; // for shift-click range; -1 when no anchor

function pathFor(name) {
  return cwd ? `${cwd}/${name}` : name;
}

// ---------------------------------------------------------------------------
// Device sidebar

async function refreshDevices() {
  const devices = await window.api.invoke("list_devices");
  deviceListEl.innerHTML = "";
  if (devices.length === 0) {
    const placeholder = document.createElement("div");
    placeholder.className = "device";
    placeholder.style.color = "#888";
    placeholder.textContent = "(no MTP devices)";
    deviceListEl.appendChild(placeholder);
    return;
  }
  for (const d of devices) {
    const item = document.createElement("button");
    item.className = "device";
    if (d.id === openDeviceId) item.classList.add("active");
    item.textContent = d.label;
    item.title = `${d.vendor_id.toString(16)}:${d.product_id.toString(16)} · ${d.id}`;
    item.addEventListener("click", () => openDevice(d));
    deviceListEl.appendChild(item);
  }
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
  await Promise.all([refreshList(), refreshStorage(), refreshDevices()]);
}

// ---------------------------------------------------------------------------
// List view

async function refreshList() {
  selected.clear();
  anchorIndex = -1;
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
  resetThumbObserver();
  thumbQueue.length = 0;
  // Free any blob URLs we built on the prior render — viewMode swaps and
  // folder changes both go through here.
  for (const url of thumbCache.values()) URL.revokeObjectURL(url);
  thumbCache.clear();

  if (entries.length === 0 && openDeviceId) {
    emptyEl.textContent = "Empty folder.";
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = entries.length > 0 || !!openDeviceId;
    if (!openDeviceId) emptyEl.textContent = "No device selected.";
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
    sizeTd.textContent = e.is_dir ? "—" : humanSize(e.size ?? 0);
    const modTd = document.createElement("td");
    modTd.className = "cell-modified";
    modTd.textContent = e.modified_at
      ? new Date(e.modified_at * 1000).toLocaleString()
      : "—";

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
    thumbBox.textContent = "🖼";
    thumbBox.dataset.path = pathFor(e.name);
    if (thumbObserver) thumbObserver.observe(thumbBox);
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

function resetThumbObserver() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver.unobserve(entry.target);
        enqueueThumbLoad(entry.target);
      }
    },
    { root: $("list-container"), rootMargin: "200px" }
  );
}

function enqueueThumbLoad(box) {
  thumbQueue.push({ box, gen: renderGen });
  pumpThumbQueue();
}

function pumpThumbQueue() {
  while (activeThumbLoads < MAX_THUMB_LOADS && thumbQueue.length > 0) {
    const { box, gen } = thumbQueue.shift();
    if (gen !== renderGen || !box.isConnected) continue;
    activeThumbLoads++;
    loadThumbnail(box, gen).finally(() => {
      activeThumbLoads--;
      pumpThumbQueue();
    });
  }
}

async function loadThumbnail(box, gen) {
  const path = box.dataset.path;
  if (!path) return;
  if (thumbCache.has(path)) {
    showThumb(box, thumbCache.get(path));
    return;
  }
  try {
    const bytes = await window.api.invoke("get_thumbnail", { path });
    if (gen !== renderGen || !box.isConnected) return; // user moved on
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    thumbCache.set(path, url);
    showThumb(box, url);
  } catch (err) {
    console.warn("thumbnail failed", path, err);
    // Leave the placeholder glyph in place; not worth alerting the user.
  }
}

function showThumb(box, url) {
  box.textContent = "";
  const img = document.createElement("img");
  img.src = url;
  img.loading = "lazy";
  box.appendChild(img);
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
  const count = selected.size;

  showContextMenu(ev.clientX, ev.clientY, [
    {
      label: count > 1 ? `Save ${count} items to…` : "Save to…",
      disabled: !anyFile,
      onSelect: saveSelectedTo,
    },
    { separator: true },
    {
      label: count > 1 ? `Delete ${count} items` : "Delete",
      onSelect: deleteSelected,
    },
  ]);
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
  if (contextMenu.hidden) return;
  if (!contextMenu.contains(ev.target)) hideContextMenu();
});
window.addEventListener("blur", hideContextMenu);
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

refreshDevicesBtn.addEventListener("click", refreshDevices);

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

refreshDevices();
