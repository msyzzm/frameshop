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
