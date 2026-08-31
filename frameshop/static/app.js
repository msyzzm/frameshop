const TOKEN = document.body.dataset.token;
const $ = (id) => document.getElementById(id);

const state = {
  frames: [],          // [{name, w, h}]
  picked: new Set(),   // names
  cursor: 0,           // index the preview is parked on
  anchor: 0,           // shift-click range origin
  images: new Map(),   // name -> HTMLImageElement (preview rendition)
  crop: null,          // {x, y, w, h} in source pixels
  playing: false,
};

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
    state.cursor = i;
    syncPicks();
    draw();
  };
}

function syncPicks() {
  const tiles = $("grid").children;
  state.frames.forEach((frame, i) => {
    tiles[i].classList.toggle("picked", state.picked.has(frame.name));
    tiles[i].classList.toggle("cursor", i === state.cursor);
  });
  $("count").textContent = `${state.picked.size} / ${state.frames.length} picked`;
}

// -- preview -----------------------------------------------------------------

function loadImage(name) {
  if (state.images.has(name)) return state.images.get(name);
  const img = new Image();
  state.images.set(name, img);
  blobUrl(`/api/preview?name=${encodeURIComponent(name)}`).then((url) => {
    img.onload = draw;
    img.src = url;
  });
  return img;
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
}

function draw() {
  const frame = state.frames[state.cursor];
  if (!frame) return;

  const canvas = $("view");
  const wrap = $("canvasWrap");
  const scale = Math.min(wrap.clientWidth / frame.w, wrap.clientHeight / frame.h, 1);
  canvas.width = Math.max(1, Math.round(frame.w * scale));
  canvas.height = Math.max(1, Math.round(frame.h * scale));

  const ctx = canvas.getContext("2d");
  paintBackground(ctx, canvas.width, canvas.height);

  const img = loadImage(frame.name);
  if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  drawCropOverlay(ctx, canvas, frame);

  $("scrub").value = state.cursor;
  $("frameLabel").textContent = `${state.cursor + 1}/${state.frames.length}  ${frame.name}`;
}

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
    state.cursor = list[(at + 1) % list.length];
    syncPicks();
    draw();
  }, 1000 / Math.max(1, Number($("fps").value)));
}

// -- crop --------------------------------------------------------------------

function bindCropDrag() {
  const canvas = $("view");
  let origin = null;

  const toSource = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const frame = state.frames[state.cursor];
    return {
      x: Math.round((ev.clientX - rect.left) / rect.width * frame.w),
      y: Math.round((ev.clientY - rect.top) / rect.height * frame.h),
    };
  };

  canvas.onpointerdown = (ev) => {
    if (!$("cropOn").checked) return;
    origin = toSource(ev);
    canvas.setPointerCapture(ev.pointerId);
  };
  canvas.onpointermove = (ev) => {
    if (!origin) return;
    const now = toSource(ev);
    state.crop = {
      x: Math.min(origin.x, now.x), y: Math.min(origin.y, now.y),
      w: Math.abs(now.x - origin.x), h: Math.abs(now.y - origin.y),
    };
    syncCropInputs();
    draw();
  };
  canvas.onpointerup = () => {
    origin = null;
    if (state.crop && (state.crop.w < 4 || state.crop.h < 4)) resetCrop();
  };
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
    log(`${out.count} frames @ ${out.size[0]}x${out.size[1]}`, "ok");
    out.written.forEach((f) => log(`  ${f.path}  (${(f.bytes / 1048576).toFixed(1)} MB)`, "ok"));
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
  $("cropReset").onclick = resetCrop;
  $("sizeReset").onclick = syncSizeFromCrop;
  ["cx", "cy", "cw", "ch"].forEach((id) => { $(id).onchange = readCropInputs; });
  document.querySelectorAll("[data-pick]").forEach((b) => {
    b.onclick = () => pickAll(b.dataset.pick);
  });
  $("scrub").oninput = (ev) => { state.cursor = Number(ev.target.value); syncPicks(); draw(); };
  $("export").onclick = doExport;
  window.onresize = draw;

  window.onkeydown = (ev) => {
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT") return;
    if (ev.key === " ") { ev.preventDefault(); setPlaying(!state.playing); }
    if (ev.key === "ArrowRight") state.cursor = Math.min(state.cursor + 1, state.frames.length - 1);
    if (ev.key === "ArrowLeft") state.cursor = Math.max(state.cursor - 1, 0);
    if (ev.key === "x") pickToggle(state.cursor);
    syncPicks();
    draw();
  };
}

async function boot() {
  const data = await api("/api/frames");
  state.frames = data.frames;
  state.frames.forEach((f) => state.picked.add(f.name));

  $("dir").textContent = data.directory;
  $("stem").value = data.directory.split(/[\\/]/).filter(Boolean).pop() || "frames";
  $("outdir").value = data.directory.replace(/[\\/][^\\/]*$/, "") + "\\frameshop_out";
  $("scrub").max = state.frames.length - 1;
  if (!data.uniform) log("frames are not all the same size - set an explicit size before export", "err");

  buildGrid();
  syncPicks();
  syncCropInputs();
  bindCropDrag();
  bindAspect();
  bindControls();
  draw();
}

boot().catch((err) => log(err.message, "err"));
