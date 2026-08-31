"""Write the picked frames out as a sprite sheet, a GIF, or an APNG.

Every writer takes `frames` as a list of (name, RGBA Image) that are already
cropped and resized, and already verified to share one size.
"""

from __future__ import annotations

import json
import math
import os

from PIL import Image

# GIF has one palette slot for transparency and no partial alpha at all, so the
# soft matte edge has to snap somewhere. 128 splits it down the middle.
GIF_TRANSPARENT_INDEX = 255
GIF_ALPHA_CUTOFF = 128


def _duration_ms(fps):
    return max(10, round(1000.0 / fps))


def sprite_sheet(frames, outdir, stem, fps, columns=0):
    count = len(frames)
    frame_w, frame_h = frames[0][1].size
    cols = columns if columns > 0 else math.ceil(math.sqrt(count))
    cols = max(1, min(cols, count))
    rows = math.ceil(count / cols)

    sheet = Image.new("RGBA", (cols * frame_w, rows * frame_h), (0, 0, 0, 0))
    placed = []
    for i, (name, im) in enumerate(frames):
        x, y = (i % cols) * frame_w, (i // cols) * frame_h
        sheet.paste(im, (x, y))
        placed.append({"name": name, "x": x, "y": y, "w": frame_w, "h": frame_h})

    png_path = os.path.join(outdir, f"{stem}_sheet.png")
    sheet.save(png_path)

    json_path = os.path.join(outdir, f"{stem}_sheet.json")
    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump({
            "image": os.path.basename(png_path),
            "frameWidth": frame_w,
            "frameHeight": frame_h,
            "columns": cols,
            "rows": rows,
            "count": count,
            "fps": fps,
            "frames": placed,
        }, handle, indent=2)

    return [png_path, json_path]


def _gif_frame(im):
    """RGBA -> palette image whose index 255 is the transparent one."""
    alpha = im.getchannel("A")
    paletted = im.convert("RGB").convert(
        "P", palette=Image.ADAPTIVE, colors=GIF_TRANSPARENT_INDEX)
    transparent = alpha.point(lambda a: 255 if a < GIF_ALPHA_CUTOFF else 0)
    paletted.paste(GIF_TRANSPARENT_INDEX, transparent)
    return paletted


def gif(frames, outdir, stem, fps):
    images = [_gif_frame(im) for _, im in frames]
    path = os.path.join(outdir, f"{stem}.gif")
    images[0].save(
        path, save_all=True, append_images=images[1:],
        duration=_duration_ms(fps), loop=0,
        transparency=GIF_TRANSPARENT_INDEX, disposal=2, optimize=False)
    return [path]


def apng(frames, outdir, stem, fps):
    images = [im for _, im in frames]
    # Named _anim so it can't be mistaken for a still next to the sheet PNG.
    path = os.path.join(outdir, f"{stem}_anim.png")
    images[0].save(
        path, save_all=True, append_images=images[1:],
        duration=_duration_ms(fps), loop=0, disposal=1)
    return [path]
