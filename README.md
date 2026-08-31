# frameshop

Pick frames out of an image sequence in the browser, then export a sprite sheet,
a GIF, or an APNG. Built for curating keyed RGBA frames down to the handful that
actually animate well.

The browser is only the UI. Every pixel is read, cropped, resized and written by
Pillow on the Python side, so RGBA survives intact; nothing round-trips through
a `<canvas>`.

## Run

```bash
python frameshop.py D:\Download\clip_keyed_png
```

Opens <http://127.0.0.1:8765>. Requires Pillow; everything else is stdlib.

```
-p, --port     default 8765
--no-open      don't launch a browser
```

## Using it

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

## Layout

```
frameshop.py            CLI entry
frameshop/
  library.py            scan a directory, cache scaled renditions
  transform.py          global crop + resize
  export.py             sheet / gif / apng writers
  server.py             stdlib http.server, routes, token guard
  static/               index.html, app.css, app.js
```

## A note on the token

The server binds `127.0.0.1` only, and every `/api/*` request must carry a
random per-run token that is injected into the page it serves. Without that, any
site you happened to have open in another tab could POST to this port and make
the tool write files wherever it liked.
