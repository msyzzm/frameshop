"""The frames in one directory, plus a lazy cache of scaled renditions."""

from __future__ import annotations

import io
import os
import threading
from dataclasses import dataclass

from PIL import Image

SUFFIXES = (".png", ".webp", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff")
THUMB_MAX = 180      # longest side of a grid thumbnail
PREVIEW_MAX = 720    # longest side of a playback frame


@dataclass(frozen=True)
class Frame:
    name: str
    path: str
    width: int
    height: int


class Library:
    def __init__(self, directory: str):
        self.directory = os.path.abspath(directory)
        # ValueError, not SystemExit: the server opens libraries on request, and
        # a bad path there is a 400, not a reason to take the process down.
        if not os.path.isdir(self.directory):
            raise ValueError(f"not a directory: {self.directory}")

        self.frames = self._scan()
        if not self.frames:
            raise ValueError(f"no images in {self.directory}")

        self._by_name = {f.name: f for f in self.frames}
        self._cache: dict[tuple[str, int], bytes] = {}
        self._lock = threading.Lock()

    def _scan(self) -> list[Frame]:
        found = []
        for name in sorted(os.listdir(self.directory)):
            if not name.lower().endswith(SUFFIXES):
                continue
            path = os.path.join(self.directory, name)
            try:
                with Image.open(path) as im:
                    found.append(Frame(name, path, im.width, im.height))
            except OSError:
                continue    # named like an image, isn't one
        return found

    def get(self, name: str) -> Frame | None:
        return self._by_name.get(name)

    def open_rgba(self, name: str) -> Image.Image:
        with Image.open(self._by_name[name].path) as im:
            return im.convert("RGBA")

    def rendition(self, name: str, longest: int) -> bytes:
        """PNG bytes of `name`, scaled so its longest side is `longest`."""
        key = (name, longest)
        with self._lock:
            hit = self._cache.get(key)
        if hit is not None:
            return hit

        im = self.open_rgba(name)
        im.thumbnail((longest, longest), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "PNG")
        data = buf.getvalue()

        with self._lock:
            self._cache[key] = data
        return data
