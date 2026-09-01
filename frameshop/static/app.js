const TOKEN = document.body.dataset.token;
const $ = (id) => document.getElementById(id);

const state = {
  frames: [],          // [{name, w, h}]
  picked: new Set(),   // names
  cursor: 0,           // index the preview is parked on
  anchor: 0,           // shift-click range origin
  images: new Map(),   // name -> {img, ready, done}   preview rendition
  full: new Map(),     // name -> {img, ready, done}   full-resolution source
  lastImg: null,       // last fully decoded image, so playback never blanks
  crop: null,          // {x, y, w, h} in source pixels
  zoom: 0,             // 0 = fit to the pane; otherwise an absolute scale
  playing: false,
  clip: null,          // step 1: the File, held back until you press Key it
  clipUrl: "",         // its object URL, for local preview
};

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

const authed = (options = {}) => ({
  ...options,
  headers: { ...(options.headers || {}), "X-Frameshop-Token": TOKEN },
});

const api = async (path, options = {}) => {
  const res = await fetch(path, authed(options));
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
};

const blobUrl = async (path) =>
  URL.createObjectURL(await (await fetch(path, authed())).blob());

const log = (msg, cls = "") => {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  $("log").prepend(line);
};

const logAction = (msg, onClick) => {
  const line = document.createElement("a");
  line.className = "act";
  line.textContent = msg;
  line.onclick = onClick;
  $("log").prepend(line);
};

/** Pull exported files back to this machine.
 *
 * Fetched rather than linked: the API wants a token header, and an <a href>
 * cannot send one. The response becomes a blob URL and a synthetic click.
 */
async function download(paths, stem = "frameshop") {
  const params = new URLSearchParams();
  paths.forEach((p) => params.append("path", p));
  if (paths.length > 1) params.set("name", stem);

  const res = await fetch(`/api/download?${params}`, authed());
  if (!res.ok) return log((await res.json()).error, "err");

  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = paths.length > 1 ? `${stem}.zip` : paths[0].split(/[\\/]/).pop();
  link.click();
  URL.revokeObjectURL(url);
}

// -- selection ---------------------------------------------------------------

function pickOnly(i) {
  state.picked.clear();
  state.picked.add(state.frames[i].name);
  state.anchor = i;
}

function pickToggle(i) {
  const name = state.frames[i].name;
  if (state.picked.has(name)) state.picked.delete(name);
  else state.picked.add(name);
  state.anchor = i;
}

function pickRange(i) {
  const [lo, hi] = state.anchor <= i ? [state.anchor, i] : [i, state.anchor];
  for (let k = lo; k <= hi; k++) state.picked.add(state.frames[k].name);
}

function pickAll(mode) {
  if (mode === "all") state.frames.forEach((f) => state.picked.add(f.name));
  else if (mode === "none") state.picked.clear();
  else state.frames.forEach((f) => {
    if (state.picked.has(f.name)) state.picked.delete(f.name);
    else state.picked.add(f.name);
  });
  syncPicks();
}

/** Names in sequence order — export must not follow click order. */
const pickedNames = () => state.frames.map((f) => f.name).filter((n) => state.picked.has(n));

/** Thin the picks to every nth, evenly spaced, counted over the picks only. */
function thin(n) {
  const picked = pickedNames();
  if (!picked.length) return;
  state.picked = new Set(picked.filter((_, i) => i % n === 0));
  syncPicks();
}

// -- grid --------------------------------------------------------------------

function buildGrid() {
  const grid = $("grid");
  grid.innerHTML = "";

  state.frames.forEach((frame, i) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.i = i;
    tile.innerHTML = `<img alt=""><span class="n">${i + 1}</span>`;
    grid.appendChild(tile);
    // Thumbnails are token-guarded, so a plain <img src> would 403.
    blobUrl(`/api/thumb?name=${encodeURIComponent(frame.name)}`)
      .then((url) => { tile.querySelector("img").src = url; });
  });

  grid.onclick = (ev) => {
    const tile = ev.target.closest(".tile");
    if (!tile) return;
    const i = Number(tile.dataset.i);
    if (ev.shiftKey) pickRange(i);
    else if (ev.ctrlKey || ev.metaKey) pickToggle(i);
    else pickOnly(i);
    moveCursor(i);
    syncPicks();
  };
}

/** Full repaint of the grid. Too heavy to run on every played frame. */
function syncPicks() {
  const tiles = $("grid").children;
  state.frames.forEach((frame, i) => {
    tiles[i].classList.toggle("picked", state.picked.has(frame.name));
    tiles[i].classList.toggle("cursor", i === state.cursor);
  });
  $("count").textContent = `${state.picked.size} / ${state.frames.length} picked`;
}

/** Cheap cursor move: touch the two tiles that changed, not all of them. */
function moveCursor(i) {
  const tiles = $("grid").children;
  tiles[state.cursor]?.classList.remove("cursor");
  state.cursor = i;
  tiles[i]?.classList.add("cursor");
  tiles[i]?.scrollIntoView({ block: "nearest" });
  draw();
}

// -- preview -----------------------------------------------------------------

function cachedImage(cache, name, url) {
  const cached = cache.get(name);
  if (cached) return cached;

  const entry = { img: new Image(), ready: false };
  entry.done = blobUrl(url).then((blob) => new Promise((resolve) => {
    entry.img.onload = () => {
      entry.ready = true;
      if (state.frames[state.cursor]?.name === name) draw();
      resolve(entry);
    };
    entry.img.onerror = () => resolve(entry);
    entry.img.src = blob;
  }));

  cache.set(name, entry);
  return entry;
}

const loadPreview = (name) =>
  cachedImage(state.images, name, `/api/preview?name=${encodeURIComponent(name)}`);

/** Full-resolution source, fetched only once the zoom outruns the preview. */
const loadFull = (name) =>
  cachedImage(state.full, name, `/api/full?name=${encodeURIComponent(name)}`);

/** Warm every preview up front: playback that fetches per frame just blinks. */
async function prefetch(concurrency = 6) {
  const queue = state.frames.map((f) => f.name);
  let done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      await loadPreview(queue.shift()).done;
      $("count").title = `${++done}/${state.frames.length} previews loaded`;
    }
  }));
  log(`${state.frames.length} previews loaded`, "ok");
}

/** Frame indices the player walks, honouring the "picked only" toggle. */
function playlist() {
  if (!$("onlyPicked").checked || state.picked.size === 0) return state.frames.map((_, i) => i);
  const idx = [];
  state.frames.forEach((f, i) => { if (state.picked.has(f.name)) idx.push(i); });
  return idx;
}

function paintBackground(ctx, w, h) {
  const bg = $("bg").value;
  if (bg !== "checker") {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const size = 16;
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = ((x / size + y / size) & 1) ? "#3a4049" : "#2a2f37";
      ctx.fillRect(x, y, size, size);
    }
  }
}

function drawCropOverlay(ctx, canvas, frame) {
  if (!$("cropOn").checked || !state.crop) return;
  const k = canvas.width / frame.w;
  const { x, y, w, h } = state.crop;
  ctx.fillStyle = "#000a";
  ctx.fillRect(0, 0, canvas.width, y * k);
  ctx.fillRect(0, (y + h) * k, canvas.width, canvas.height - (y + h) * k);
  ctx.fillRect(0, y * k, x * k, h * k);
  ctx.fillRect((x + w) * k, y * k, canvas.width - (x + w) * k, h * k);
  ctx.strokeStyle = "#4a9eff";
  ctx.lineWidth = 1;
  ctx.strokeRect(x * k + 0.5, y * k + 0.5, w * k, h * k);

  // Handles, so it reads as draggable rather than as a drawn-once rectangle.
  const size = 7;
  ctx.fillStyle = "#4a9eff";
  for (const px of [x, x + w / 2, x + w]) {
    for (const py of [y, y + h / 2, y + h]) {
      if (px === x + w / 2 && py === y + h / 2) continue;
      ctx.fillRect(px * k - size / 2, py * k - size / 2, size, size);
    }
  }
}

/** Scale actually used to paint: the explicit zoom, or fit-to-pane. */
function effectiveScale(frame) {
  if (state.zoom) return state.zoom;
  const wrap = $("canvasWrap");
  return Math.min(wrap.clientWidth / frame.w, wrap.clientHeight / frame.h, 1);
}

function draw() {
  const frame = state.frames[state.cursor];
  if (!frame) return;

  const canvas = $("view");
  const scale = effectiveScale(frame);
  canvas.width = Math.max(1, Math.round(frame.w * scale));
  canvas.height = Math.max(1, Math.round(frame.h * scale));

  const ctx = canvas.getContext("2d");
  paintBackground(ctx, canvas.width, canvas.height);

  // Hold the previous frame rather than flash empty while this one decodes.
  const entry = loadPreview(frame.name);
  let shown = entry.ready ? entry.img : state.lastImg;
  if (entry.ready) state.lastImg = entry.img;

  // Past the rendition's own width the preview is just a blurry upscale, which
  // defeats the point of zooming in. Swap in the source once it has arrived.
  if (canvas.width > entry.img.naturalWidth) {
    const full = loadFull(frame.name);
    if (full.ready) shown = full.img;
  }

  // Above 1:1 you are looking at pixels, so stop the browser inventing them.
  ctx.imageSmoothingEnabled = scale <= 1;
  if (shown) ctx.drawImage(shown, 0, 0, canvas.width, canvas.height);

  drawCropOverlay(ctx, canvas, frame);

  $("scrub").value = state.cursor;
  $("frameLabel").textContent = `${state.cursor + 1}/${state.frames.length}  ${frame.name}`;
  $("zoomLabel").textContent = state.zoom
    ? `${Math.round(scale * 100)}%`
    : `fit ${Math.round(scale * 100)}%`;
}

/** Zoom about a viewport point, so whatever sits under it stays under it. */
function zoomTo(point, after) {
  const frame = state.frames[state.cursor];
  if (!frame) return;
  const before = effectiveScale(frame);
  after = clamp(after, MIN_ZOOM, MAX_ZOOM);
  if (after === before) return;

  const view = $("view").getBoundingClientRect();
  const source = { x: (point.x - view.left) / before, y: (point.y - view.top) / before };

  state.zoom = after;
  draw();

  const wrap = $("canvasWrap");
  const box = wrap.getBoundingClientRect();
  wrap.scrollLeft = source.x * after - (point.x - box.left);
  wrap.scrollTop = source.y * after - (point.y - box.top);
}

const paneCentre = () => {
  const box = $("canvasWrap").getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
};

/** Buttons and keys zoom about the middle of the pane, not the top-left. */
function setZoom(z) {
  if (!z) {
    state.zoom = 0;
    $("canvasWrap").scrollTo(0, 0);
    return draw();
  }
  zoomTo(paneCentre(), z);
}

const zoomBy = (factor) =>
  setZoom(effectiveScale(state.frames[state.cursor]) * factor);

let timer = null;
function setPlaying(on) {
  state.playing = on;
  $("play").textContent = on ? "Pause" : "Play";
  clearInterval(timer);
  if (!on) return;

  timer = setInterval(() => {
    const list = playlist();
    if (!list.length) return;
    const at = list.indexOf(state.cursor);
    moveCursor(list[(at + 1) % list.length]);
  }, 1000 / Math.max(1, Number($("fps").value)));
}

// -- crop --------------------------------------------------------------------

const HANDLE_PX = 9;                    // grab tolerance, in on-screen pixels
const CURSORS = {
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
  move: "move",
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/** Which part of the crop rect is under `pt`: an edge/corner, "move", or null. */
function cropHitZone(pt, tol) {
  const c = state.crop;
  if (!c) return null;
  const [l, t, r, b] = [c.x, c.y, c.x + c.w, c.y + c.h];
  if (pt.x < l - tol || pt.x > r + tol || pt.y < t - tol || pt.y > b + tol) return null;

  const zone = (Math.abs(pt.y - t) <= tol ? "n" : Math.abs(pt.y - b) <= tol ? "s" : "")
             + (Math.abs(pt.x - l) <= tol ? "w" : Math.abs(pt.x - r) <= tol ? "e" : "");
  if (zone) return zone;
  return (pt.x > l && pt.x < r && pt.y > t && pt.y < b) ? "move" : null;
}

function applyCropDrag(zone, from, start, pt, frame) {
  if (zone === "move") {
    return {
      x: clamp(start.x + pt.x - from.x, 0, frame.w - start.w),
      y: clamp(start.y + pt.y - from.y, 0, frame.h - start.h),
      w: start.w, h: start.h,
    };
  }
  let [l, t, r, b] = [start.x, start.y, start.x + start.w, start.y + start.h];
  if (zone.includes("w")) l = clamp(pt.x, 0, r - 1);
  if (zone.includes("e")) r = clamp(pt.x, l + 1, frame.w);
  if (zone.includes("n")) t = clamp(pt.y, 0, b - 1);
  if (zone.includes("s")) b = clamp(pt.y, t + 1, frame.h);
  return { x: l, y: t, w: r - l, h: b - t };
}

function bindCropDrag() {
  const canvas = $("view");
  let drag = null;    // {zone, from, start} while a pointer is down

  const toSource = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const frame = state.frames[state.cursor];
    return {
      x: Math.round((ev.clientX - rect.left) / rect.width * frame.w),
      y: Math.round((ev.clientY - rect.top) / rect.height * frame.h),
      // Tolerance has to be in source px, and the canvas is drawn scaled.
      tol: HANDLE_PX * frame.w / rect.width,
    };
  };

  canvas.onpointerdown = (ev) => {
    if (!$("cropOn").checked) return;
    const pt = toSource(ev);
    drag = { zone: cropHitZone(pt, pt.tol) || "new", from: pt, start: state.crop };
    if (drag.zone === "new") state.crop = { x: pt.x, y: pt.y, w: 0, h: 0 };
    canvas.setPointerCapture(ev.pointerId);
  };

  canvas.onpointermove = (ev) => {
    const pt = toSource(ev);
    if (!drag) {
      if ($("cropOn").checked) {
        canvas.style.cursor = CURSORS[cropHitZone(pt, pt.tol)] || "crosshair";
      }
      return;
    }
    state.crop = drag.zone === "new"
      ? {
          x: Math.min(drag.from.x, pt.x), y: Math.min(drag.from.y, pt.y),
          w: Math.abs(pt.x - drag.from.x), h: Math.abs(pt.y - drag.from.y),
        }
      : applyCropDrag(drag.zone, drag.from, drag.start, pt, state.frames[state.cursor]);
    syncCropInputs();
    draw();
  };

  canvas.onpointerup = () => {
    // Only a fresh drag can be a stray click. Nudging an edge inward is
    // deliberate, and applyCropDrag already floors it at 1px.
    const stray = drag?.zone === "new" && state.crop
      && (state.crop.w < 4 || state.crop.h < 4);
    drag = null;
    if (stray) resetCrop();
  };
}

async function autoCrop() {
  const names = pickedNames();
  if (!names.length) return log("nothing picked", "err");

  $("cropAuto").disabled = true;
  try {
    const box = await api("/api/autocrop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names, padding: 2 }),
    });
    state.crop = { x: box.x, y: box.y, w: box.w, h: box.h };
    $("cropOn").checked = true;
    syncCropInputs();
    draw();
    log(`auto crop ${box.w}x${box.h} at ${box.x},${box.y} over ${box.frames} frames`, "ok");
  } catch (err) {
    log(err.message, "err");
  } finally {
    $("cropAuto").disabled = false;
  }
}

function syncCropInputs() {
  const c = state.crop || { x: "", y: "", w: "", h: "" };
  $("cx").value = c.x; $("cy").value = c.y; $("cw").value = c.w; $("ch").value = c.h;
  syncSizeFromCrop();
}

function readCropInputs() {
  const [x, y, w, h] = ["cx", "cy", "cw", "ch"].map((id) => Number($(id).value));
  state.crop = (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
    ? { x: x || 0, y: y || 0, w, h } : null;
  syncSizeFromCrop();
  draw();
}

function resetCrop() {
  state.crop = null;
  syncCropInputs();
  draw();
}

// -- resize ------------------------------------------------------------------

const sourceSize = () => {
  const frame = state.frames[state.cursor] || state.frames[0];
  return state.crop ? [state.crop.w, state.crop.h] : [frame.w, frame.h];
};

function syncSizeFromCrop() {
  const [w, h] = sourceSize();
  $("rw").value = w;
  $("rh").value = h;
}

function bindAspect() {
  const ratio = () => { const [w, h] = sourceSize(); return w / h; };
  $("rw").oninput = () => {
    if ($("linkAspect").checked) $("rh").value = Math.round(Number($("rw").value) / ratio());
  };
  $("rh").oninput = () => {
    if ($("linkAspect").checked) $("rw").value = Math.round(Number($("rh").value) * ratio());
  };
}

// -- export ------------------------------------------------------------------

async function doExport() {
  const [sw, sh] = sourceSize();
  const rw = Number($("rw").value);
  const rh = Number($("rh").value);

  const payload = {
    names: pickedNames(),
    crop: state.crop,
    resize: (rw === sw && rh === sh) ? null : { w: rw, h: rh },
    outdir: $("outdir").value,
    stem: $("stem").value,
    fps: Number($("fps").value),
    columns: Number($("cols").value),
    formats: [...document.querySelectorAll(".fmt:checked")].map((el) => el.value),
  };

  $("export").disabled = true;
  try {
    const out = await api("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // Everything above ran on the server, so the files are on the server. Offer
    // them back rather than making a remote session end in an scp.
    const paths = out.written.map((f) => f.path);
    const stem = $("stem").value || "frameshop";
    out.written.forEach((f) => logAction(
      `  download ${f.path.split(/[\\/]/).pop()}  (${(f.bytes / 1048576).toFixed(1)} MB)`,
      () => download([f.path])));
    if (paths.length > 1) {
      logAction(`  download all ${paths.length} as ${stem}.zip`, () => download(paths, stem));
    }
    log(`${out.count} frames @ ${out.size[0]}x${out.size[1]} -> ${out.written[0].path}`, "ok");
  } catch (err) {
    log(err.message, "err");
  } finally {
    $("export").disabled = false;
  }
}

// -- boot --------------------------------------------------------------------

function bindControls() {
  $("play").onclick = () => setPlaying(!state.playing);
  $("fps").onchange = () => { if (state.playing) setPlaying(true); };
  $("bg").onchange = draw;
  $("cropOn").onchange = draw;
  $("cropAuto").onclick = autoCrop;
  $("cropReset").onclick = resetCrop;

  $("zoomIn").onclick = () => zoomBy(1.25);
  $("zoomOut").onclick = () => zoomBy(1 / 1.25);
  $("zoomFit").onclick = () => setZoom(0);
  $("zoom1").onclick = () => setZoom(1);
  // Ctrl+wheel zooms, plain wheel is left alone so it still pans the overflow.
  $("canvasWrap").addEventListener("wheel", (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    const scale = effectiveScale(state.frames[state.cursor]);
    zoomTo({ x: ev.clientX, y: ev.clientY }, scale * (ev.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  $("sizeReset").onclick = syncSizeFromCrop;
  ["cx", "cy", "cw", "ch"].forEach((id) => { $(id).onchange = readCropInputs; });
  document.querySelectorAll("[data-pick]").forEach((b) => {
    b.onclick = () => pickAll(b.dataset.pick);
  });
  document.querySelectorAll("[data-thin]").forEach((b) => {
    b.onclick = () => thin(Number(b.dataset.thin));
  });
  $("scrub").oninput = (ev) => moveCursor(Number(ev.target.value));
  $("export").onclick = doExport;
  window.onresize = draw;

  window.onkeydown = (ev) => {
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT") return;
    if (ev.key === " ") { ev.preventDefault(); setPlaying(!state.playing); }
    else if (ev.key === "ArrowRight") moveCursor(Math.min(state.cursor + 1, state.frames.length - 1));
    else if (ev.key === "ArrowLeft") moveCursor(Math.max(state.cursor - 1, 0));
    else if (ev.key === "x") { pickToggle(state.cursor); syncPicks(); }
    else if (ev.key === "+" || ev.key === "=") zoomBy(1.25);
    else if (ev.key === "-") zoomBy(1 / 1.25);
    else if (ev.key === "0") setZoom(0);
  };
}

// -- step 1: video -> keyed PNG sequence -------------------------------------

function showStep(n) {
  document.body.classList.toggle("step1", n === 1);
  $("tab1").classList.toggle("on", n === 1);
  $("tab2").classList.toggle("on", n === 2);
  $("tab2").disabled = !state.frames.length;
  if (n === 2) draw();
}

const setKeyStatus = (text, cls = "") => {
  const el = $("keyStatus");
  el.textContent = text;
  el.className = `small ${cls || "muted"}`;
};

async function pollJob() {
  const bar = $("keyProgress");
  for (;;) {
    const job = await api("/api/job");

    if (job.state === "running") {
      bar.hidden = false;
      bar.max = job.total || 1;
      bar.value = job.done || 0;
      setKeyStatus(job.total ? `keying ${job.done}/${job.total}` : "decoding video…");
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    bar.hidden = true;
    if (job.state === "error") return setKeyStatus(job.error, "err");
    if (job.state !== "done") return setKeyStatus("");

    setKeyStatus(`${job.frames} frames, screen ${job.screen.join(",")}, `
      + `leak ${job.leak}/255, core alpha ${job.core}`, "ok");
    // A high leak means the plate was not really a green screen; say so, since
    // the frames will look fine in the grid and wrong the moment you composite.
    if (job.leak > 10) log(`leak ${job.leak}/255 is high - was that really a green screen?`, "err");
    loadProjects();
    return openLibrary({ directory: job.directory });
  }
}

/** Preview the file the browser is already holding - no upload, no server
 *  round trip, and nothing transferred for a clip you end up discarding. */
function pickFile(file) {
  if (!file) return;
  if (state.clipUrl) URL.revokeObjectURL(state.clipUrl);

  state.clip = file;
  state.clipUrl = URL.createObjectURL(file);

  const video = $("vid");
  video.src = state.clipUrl;
  $("clip").hidden = false;
  $("drop").querySelector("strong").textContent = file.name;

  video.onloadedmetadata = () => {
    $("tStart").value = 0;
    $("tEnd").value = video.duration.toFixed(2);
    syncRange();
  };
  // Some containers ffmpeg handles happily are ones no browser will decode.
  video.onerror = () => {
    $("clip").hidden = true;
    setKeyStatus("this browser can't preview that container - keying still works");
  };
  setKeyStatus(`${(file.size / 1048576).toFixed(1)} MB ready - pick a range, then Key it`);
}

function syncRange() {
  const start = Number($("tStart").value) || 0;
  const end = Number($("tEnd").value) || 0;
  const whole = $("vid").duration || 0;
  const span = Math.max(0, end - start);
  $("clipInfo").textContent = span
    ? `${span.toFixed(2)}s of ${whole.toFixed(2)}s`
    : `${whole.toFixed(2)}s`;
}

async function uploadVideo() {
  const file = state.clip;
  if (!file) return $("file").click();

  const start = Number($("tStart").value) || 0;
  const end = Number($("tEnd").value) || 0;
  const params = new URLSearchParams({
    name: file.name,
    start,
    lo: $("lo").value || 8,
    hi: $("hi").value || 45,
    outdir: $("workroot").value || "",
  });
  if (end > start) params.set("end", end);

  setKeyStatus(`uploading ${(file.size / 1048576).toFixed(1)} MB…`);
  try {
    await api(`/api/import?${params}`, { method: "POST", body: file });
    await pollJob();
  } catch (err) {
    setKeyStatus(err.message, "err");
  }
}

const MB = 1048576;

function projectRow(project) {
  const row = document.createElement("div");
  row.className = "proj";
  row.dataset.directory = project.directory;

  const span = project.end != null ? `${project.start ?? 0}-${project.end}s` : "whole clip";
  const when = new Date((project.created || project.modified) * 1000).toLocaleString();
  // Surface leak here too: a badly keyed project looks perfectly fine as
  // thumbnails and only betrays itself once you composite it.
  const bad = project.leak > 10;

  row.innerHTML = `
    <div class="proj-main">
      <strong>${project.source || project.name}</strong>
      <span class="muted small">${project.frames} frames &middot;
        ${(project.bytes / MB).toFixed(1)} MB &middot; ${span}</span>
    </div>
    <div class="proj-meta muted small mono">
      ${project.leak != null ? `<span class="${bad ? "err" : "ok"}">leak ${project.leak}</span>` : ""}
      <span>${when}</span>
    </div>
    <button class="proj-del ghost" title="delete this project">&times;</button>`;
  row.querySelector(".proj-del").dataset.summary =
    `${project.source || project.name} - ${project.frames} frames, ${(project.bytes / MB).toFixed(1)} MB`;
  return row;
}

async function deleteProject(directory, summary) {
  if (!confirm(`Delete this project?\n\n${summary}\n${directory}\n\nThe frames are removed from disk. This cannot be undone.`)) return;
  try {
    const data = await api("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory }),
    });
    log(`deleted ${data.deleted}`, "ok");
    loadProjects();
    // Step 2 may have been showing the frames that just went.
    if ($("dir").textContent === data.deleted) {
      state.frames = [];
      $("dir").textContent = "";
      $("grid").innerHTML = "";
      showStep(1);
    }
  } catch (err) {
    log(err.message, "err");
  }
}

async function loadProjects() {
  const box = $("projects");
  try {
    const data = await api("/api/projects");
    $("projRoot").textContent = data.workroot;
    box.innerHTML = "";
    if (!data.projects.length) {
      box.innerHTML = '<div class="muted small">nothing keyed yet</div>';
      return;
    }
    data.projects.forEach((p) => box.appendChild(projectRow(p)));
  } catch (err) {
    box.innerHTML = "";
    box.textContent = err.message;
  }
}

async function openDirectory(directory) {
  try {
    await openLibrary(await api("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory }),
    }));
  } catch (err) {
    setKeyStatus(err.message, "err");
  }
}

function bindStep1() {
  const drop = $("drop");
  const file = $("file");

  $("projRefresh").onclick = loadProjects;
  $("projects").onclick = (ev) => {
    const row = ev.target.closest(".proj");
    if (!row) return;
    const del = ev.target.closest(".proj-del");
    if (del) deleteProject(row.dataset.directory, del.dataset.summary);
    else openDirectory(row.dataset.directory);
  };

  drop.onclick = () => file.click();
  file.onchange = () => pickFile(file.files[0]);

  drop.ondragover = (ev) => { ev.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (ev) => {
    ev.preventDefault();
    drop.classList.remove("over");
    pickFile(ev.dataTransfer.files[0]);
  };

  $("setIn").onclick = () => { $("tStart").value = $("vid").currentTime.toFixed(2); syncRange(); };
  $("setOut").onclick = () => { $("tEnd").value = $("vid").currentTime.toFixed(2); syncRange(); };
  $("rangeReset").onclick = () => {
    $("tStart").value = 0;
    $("tEnd").value = ($("vid").duration || 0).toFixed(2);
    syncRange();
  };
  $("tStart").oninput = syncRange;
  $("tEnd").oninput = syncRange;

  $("keyGo").onclick = () => uploadVideo();
  $("openGo").onclick = () => openDirectory($("openDir").value);

  $("tab1").onclick = () => showStep(1);
  $("tab2").onclick = () => showStep(2);
}

// -- step 2 -------------------------------------------------------------------

async function openLibrary(data) {
  if (!data.frames) data = await api("/api/frames");
  if (!data.frames.length) return;

  state.frames = data.frames;
  state.picked = new Set(data.frames.map((f) => f.name));
  state.images.clear();
  state.full.clear();
  state.lastImg = null;
  state.cursor = 0;
  state.crop = null;
  state.zoom = 0;

  $("dir").textContent = data.directory;
  $("stem").value = data.directory.split(/[\\/]/).filter(Boolean).pop() || "frames";
  // Follow the server's separator. A hard-coded backslash builds a directory
  // literally named "work\frameshop_out" when the server runs on Linux.
  const sep = data.directory.includes("\\") ? "\\" : "/";
  $("outdir").value = data.directory.replace(/[\\/][^\\/]*$/, "") + sep + "frameshop_out";
  $("scrub").max = state.frames.length - 1;
  if (!data.uniform) log("frames are not all the same size - set an explicit size before export", "err");

  buildGrid();
  syncPicks();
  syncCropInputs();
  showStep(2);
  prefetch();
}

async function boot() {
  bindCropDrag();
  bindAspect();
  bindControls();
  bindStep1();

  const data = await api("/api/frames");
  $("workroot").value = data.workroot || "";
  if (!data.ffmpeg) setKeyStatus("ffmpeg/ffprobe not on PATH - step 1 is unavailable", "err");

  loadProjects();
  if (data.frames.length) await openLibrary(data);
  else showStep(1);
}

boot().catch((err) => log(err.message, "err"));
