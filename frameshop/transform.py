"""Uniform crop + resize applied to every exported frame.

The crop rect and target size are global, never per-image: sequence frames that
don't share a size can't go into a sprite sheet, and would jitter as animation.
"""

from __future__ import annotations

from PIL import Image


def clamp_crop(crop, width, height):
    """Clip a crop rect to the image. Returns None when it covers everything."""
    if not crop:
        return None
    x = max(0, min(int(crop["x"]), width - 1))
    y = max(0, min(int(crop["y"]), height - 1))
    w = max(1, min(int(crop["w"]), width - x))
    h = max(1, min(int(crop["h"]), height - y))
    if (x, y, w, h) == (0, 0, width, height):
        return None
    return x, y, w, h


def subject_bbox(images, threshold=8, padding=0):
    """Union of the opaque region over every frame -> {x, y, w, h}, or None.

    Union, not per-frame: one crop has to hold the subject through the whole
    animation, so a box that fits frame 1 but clips frame 40 is worthless.

    The threshold matters - a keyed matte trails pixels at alpha 1-5 well past
    anything you would call the subject, and getbbox() on the raw alpha would
    happily include them.
    """
    box = None
    width = height = 0

    for im in images:
        width, height = max(width, im.width), max(height, im.height)
        mask = im.getchannel("A").point(lambda a: 255 if a > threshold else 0)
        found = mask.getbbox()
        if found is None:
            continue        # fully transparent frame contributes nothing
        box = found if box is None else (
            min(box[0], found[0]), min(box[1], found[1]),
            max(box[2], found[2]), max(box[3], found[3]))

    if box is None:
        return None

    left = max(0, box[0] - padding)
    top = max(0, box[1] - padding)
    right = min(width, box[2] + padding)
    bottom = min(height, box[3] + padding)
    return {"x": left, "y": top, "w": right - left, "h": bottom - top}


def apply(im, crop=None, resize=None):
    box = clamp_crop(crop, im.width, im.height)
    if box:
        x, y, w, h = box
        im = im.crop((x, y, x + w, y + h))

    if resize:
        size = (max(1, int(resize["w"])), max(1, int(resize["h"])))
        if size != im.size:
            im = im.resize(size, Image.LANCZOS)

    return im
