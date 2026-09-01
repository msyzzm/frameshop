"""The keyed sequences under the work root, and the sidecar describing each.

A project is just a directory of frames - the same thing step 2 opens. The
sidecar exists because the interesting part isn't recoverable from the images:
which clip it came from, what span was keyed, and whether the key worked. All
of that is computed once and then thrown away unless it is written down.
"""

from __future__ import annotations

import json
import os

from .library import SUFFIXES

SIDECAR = "frameshop.json"


def write(directory, info):
    with open(os.path.join(directory, SIDECAR), "w", encoding="utf-8") as handle:
        json.dump(info, handle, indent=2)


def read(directory):
    try:
        with open(os.path.join(directory, SIDECAR), encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}          # hand-made or pre-sidecar directory; still openable


def summarise(directory):
    """Describe a project directory, or None if it isn't one.

    Also the guard for deletion: "has frames in it" is what separates a project
    from an arbitrary directory someone typed.
    """
    if not os.path.isdir(directory):
        return None

    frames = [f for f in os.listdir(directory) if f.lower().endswith(SUFFIXES)]
    if not frames:
        return None        # not a sequence; don't offer it as a project

    total = 0
    for frame in frames:
        try:
            total += os.path.getsize(os.path.join(directory, frame))
        except OSError:
            pass

    # Sidecar first so the measured values win if the two ever disagree.
    return {
        **read(directory),
        "name": os.path.basename(directory),
        "directory": directory,
        "frames": len(frames),
        "bytes": total,
        "modified": os.path.getmtime(directory),
    }


def listing(workroot):
    """Every keyed sequence under the work root, newest first."""
    if not os.path.isdir(workroot):
        return []
    found = (summarise(os.path.join(workroot, n)) for n in os.listdir(workroot))
    return sorted((p for p in found if p), key=lambda p: p["modified"], reverse=True)
