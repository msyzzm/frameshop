# frameshop

Two steps, in the browser:

1. **Key a video** — drop in a green-screen clip, get an RGBA PNG sequence.
2. **Pick frames** — preview them as animation, keep the ones that work, crop
   and resize, export a sprite sheet / GIF / APNG.

Step 1 hands its output straight to step 2, so the usual path is drop a clip and
keep going.

The browser is only the UI. Every pixel is read, keyed, cropped, resized and
written by Pillow and numpy on the Python side, so RGBA survives intact; nothing
round-trips through a `<canvas>`.

## Run

```bash
python frameshop.py                               # start at step 1
python frameshop.py D:\Download\clip_keyed_png    # jump straight to step 2
```

Opens <http://127.0.0.1:8765>.

```
-p, --port     default 8765
--work DIR     where keyed sequences land (default: ./frameshop_work)
--no-open      don't launch a browser
```

Needs Pillow and numpy. Step 1 also needs `ffmpeg` and `ffprobe` on PATH — the
UI says so up front if they are missing, and step 2 works without them.

## Step 1 — keying

Drop a clip (or click to choose, or paste a folder path to skip straight to step
2 with frames you already have).

| Field | Meaning |
|---|---|
| `trim` | drop this many frames off the front — AI clips often open on a bad beat |
| `lo` | `G-max(R,B)` at/below which a pixel is fully opaque (default 8) |
| `hi` | `G-max(R,B)` at/above which a pixel is fully transparent (default 45) |
| `out` | where the `<name>_keyed_png/` folder is written |

Alpha comes from a colour-difference key, and then the background's
*contribution* is subtracted outright rather than despilled:

```
observed   I     = a*FG + (1-a)*BG      BG is known
premult    a*FG  = I - (1-a)*BG         no division, no instability
```

Despill only cancels the green cast. It leaves the screen's luminance in the
edge pixels, which reads as a bright fringe the moment you composite over
anything dark. Subtracting `(1-a)*BG` removes both at once.

When it finishes you get the numbers that say whether it worked:

```
91 frames, screen 39,152,55, leak 2.65/255, core alpha 1.0
```

- **leak** — mean luminance left where the plate was unambiguously screen.
  Near 0 is right. Above ~10 the clip probably wasn't a green screen, and the
  frames will look fine in the grid and wrong the moment you composite them.
- **core alpha** — mean alpha where the plate was unambiguously subject. Must
  be 1.0; below that the key is eating the subject, so lower `lo`.

The screen colour is sampled once, from the four corners of the first frame, so
the plate has to be static and reasonably even. Synthetic and AI-generated
plates are. A hand-held shot with a drifting gradient is not.

## Step 2 — picking

**Picking.** Every frame starts picked. In the grid on the right:

| | |
|---|---|
| click | pick just this one |
| ctrl / cmd + click | toggle one |
| shift + click | pick the range back to the last click |
| `All` / `None` / `Invert` | bulk |
| `1/2` / `1/3` | keep every 2nd or 3rd of what's already picked, evenly spaced |
| `x` | toggle the frame under the cursor |
| `left` / `right` | step the cursor |
| space | play / pause |
| `-` / `+` / `0` | zoom out / in / fit |

**Playing.** *picked only* loops just the selection, so you see the cut before
you commit to it. Set the background to black, white or magenta to judge a matte
edge — magenta is the one that exposes residual green.

**Zooming.** `−` `+` `fit` `1:1` under the preview, or `-` `+` `0` on the
keyboard, or ctrl+wheel to zoom about the pointer. Plain wheel and the
scrollbars pan. Above 1:1 the canvas switches to the full-resolution source and
turns off smoothing, so you are looking at real pixels rather than an
interpolated guess — which is the only way to judge a matte edge.

**Cropping.** Tick `crop`, then drag a rect on the preview. Drag an edge or a
corner handle to adjust it, or drag the middle to move the whole box; the four
numbers in the footer (`x` `y` `w` `h`, in source pixels) take typed values too.

`auto` fits the box for you: it reads the alpha of every *picked* frame and
returns the union of their opaque regions, so the box holds the subject for the
whole animation rather than just the frame you happen to be looking at. Pixels
at alpha 8 or below are ignored — a keyed matte trails stray near-transparent
pixels well past anything you would call the subject.

The crop is global, never per-frame: a sprite sheet needs one frame size, and a
varying crop would make the animation jitter.

**Resizing.** The size fields default to the crop (or the source). `lock ratio`
keeps them proportional. `reset` snaps back.

## Output

Pick a name and an output folder, tick formats, hit Export.

| Format | Files | Notes |
|---|---|---|
| sheet | `<name>_sheet.png` + `.json` | RGBA, row-major. `cols 0` = auto (near-square) |
| gif | `<name>.gif` | 1-bit transparency; the soft matte edge snaps at alpha 128. Durations quantise to 10 ms |
| apng | `<name>_anim.png` | full alpha, exact durations |

`<name>_sheet.json`:

```json
{
  "image": "hero_sheet.png",
  "frameWidth": 270, "frameHeight": 480,
  "columns": 8, "rows": 4, "count": 31, "fps": 12,
  "frames": [{ "name": "00001.png", "x": 0, "y": 0, "w": 270, "h": 480 }]
}
```

Frames go out in sequence order, not the order you clicked them.

Everything runs server-side, so the files land on the server — the wrong
machine when you are driving it over the network. The log turns each result
into a download link, plus one that zips the lot, so a remote session doesn't
have to end in an `scp`. The zip is stored rather than deflated: PNG and GIF
are already compressed, so deflate would spend the CPU for nothing.

## Layout

```
frameshop.py            CLI entry
frameshop/
  key.py                step 1: ffmpeg decode + colour-difference key
  jobs.py               one background job, with a pollable status
  library.py            scan a directory, cache scaled renditions
  transform.py          global crop + resize, subject bbox
  export.py             sheet / gif / apng writers
  server.py             stdlib http.server, routes, token guard
  static/               index.html, app.css, app.js
```

## Docker

```bash
export FRAMESHOP_TOKEN=$(openssl rand -hex 24)
docker compose up -d --build
```

Then <http://127.0.0.1:8765> — any username, that token as the password. Work
lands in `./data` on the host.

The compose file publishes on the host's **loopback** only. To reach it from
another machine, tunnel (`ssh -L 8765:localhost:8765 server`) or put a
TLS-terminating reverse proxy in front. Widening the mapping to `8765:8765`
puts a plaintext password on the wire.

Running it by hand instead:

```bash
docker build -t frameshop .
docker run -d --name frameshop \
  -p 127.0.0.1:8765:8765 \
  -e FRAMESHOP_TOKEN="$FRAMESHOP_TOKEN" \
  -v "$PWD/data:/data" \
  frameshop
```

## Exposing it beyond localhost

The default — loopback, no password, no path jail — assumes one person on one
machine. That assumption is what makes `outdir` and `directory` safe to accept
as free-form paths. Off localhost it stops holding, so three things change:

| Flag / env | Effect |
|---|---|
| `--host` | bind address. Anything but loopback **refuses to start** without a password |
| `FRAMESHOP_TOKEN` | turns on HTTP Basic auth for every request, `/` included |
| `--root DIR` | every path the client names — `outdir`, `directory`, the import target — must resolve inside `DIR` |

Without `--root`, `POST /api/export` is an arbitrary file write and
`POST /api/open` an arbitrary directory read, as whatever user the server runs
as. The Docker image sets `--root /data` and runs as a non-root user for
exactly that reason.

Uploads are capped at 4 GiB.

Basic auth over plain HTTP is a lock, not a tunnel. It stops a stranger driving
the tool; it does nothing about anyone reading the wire. Terminate TLS in front
of it, or keep it on a private network.

## A note on the token

The server binds `127.0.0.1` only, and every `/api/*` request must carry a
random per-run token that is injected into the page it serves. Without that, any
site you happened to have open in another tab could POST to this port and make
the tool write files wherever it liked.
