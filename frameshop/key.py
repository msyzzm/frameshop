"""Green screen in, RGBA PNG sequence out.

Alpha comes from a colour-difference key, then the background's *contribution*
is subtracted outright rather than despilled:

    observed   I     = a*FG + (1-a)*BG      BG is known
    premult    a*FG  = I - (1-a)*BG         no division, no instability

Despill only cancels the green cast. It leaves the screen's luminance sitting
in the edge pixels, which reads as a bright fringe over a dark background.
Subtracting (1-a)*BG removes both at once.

The screen colour is sampled once, from the corners of the first frame, so the
plate has to be static and reasonably even. Synthetic/AI plates are; a
hand-held live-action shot with a drifting gradient is not.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image

CORNER_PATCH = 60      # px square sampled at each corner for the screen colour
ALPHA_FLOOR = 0.004    # below this the straight-alpha division is meaningless
DEFAULT_LO = 8.0       # G-max(R,B) at/below which alpha = 1
DEFAULT_HI = 45.0      # G-max(R,B) at/above which alpha = 0

# Pixels past these limits are unambiguously screen / unambiguously subject,
# which is what makes them useful as a "did this key actually work" measure.
SCREEN_MARGIN = 70
SUBJECT_MARGIN = 0


def have_ffmpeg():
    return bool(shutil.which("ffmpeg")) and bool(shutil.which("ffprobe"))


def probe_fps(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True).stdout.strip().splitlines()[0]
    num, den = out.split("/")
    return float(num) / float(den)


def decode(video, dest, start=0.0, end=None):
    """Decode [start, end) seconds to a PNG sequence.

    -ss goes before -i so ffmpeg seeks the input instead of decoding and
    throwing away everything up to that point, and the span is given as a
    duration after it, which leaves no doubt about what -to would be relative
    to.
    """
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", video]
    if end is not None and end > start:
        cmd += ["-t", f"{end - start:.3f}"]
    subprocess.run(cmd + [os.path.join(dest, "%05d.png")], check=True)


def screen_colour(rgb):
    p = CORNER_PATCH
    corners = np.concatenate([rgb[:p, :p].reshape(-1, 3), rgb[:p, -p:].reshape(-1, 3),
                              rgb[-p:, :p].reshape(-1, 3), rgb[-p:, -p:].reshape(-1, 3)])
    return np.median(corners, 0)


def screen_colour_over(paths, samples=9):
    """Median corner colour across frames spread through the clip.

    Frame 1 is a bad sole witness. Clips routinely open on a fade or an
    unsettled exposure - one measured here read [5, 218, 28] on frame 1 against
    a steady [39, 152, 55] by frame 6 - and one wrong BG then poisons the
    subtraction on every frame, which surfaces as a large leak.
    """
    step = max(1, len(paths) // samples)
    picked = paths[::step][:samples] or paths[:1]
    corners = [screen_colour(np.asarray(Image.open(p).convert("RGB")).astype(np.float32))
               for p in picked]
    return np.median(np.stack(corners), 0)


def key_frame(rgb, bg, lo, hi):
    """-> (straight RGBA uint8, premultiplied float, alpha float, difference float)"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    # max() rather than the mean of the other two: it keeps alpha independent
    # of the foreground's own colour.
    diff = g - np.maximum(r, b)
    a = np.clip((hi - diff) / (hi - lo), 0.0, 1.0)[..., None]

    premult = np.clip(rgb - (1.0 - a) * bg, 0.0, 255.0)
    straight = np.where(a > ALPHA_FLOOR,
                        np.clip(premult / np.maximum(a, 1e-6), 0.0, 255.0), 0.0)
    return np.dstack([straight, a * 255.0]).astype(np.uint8), premult, a[..., 0], diff


def key_video(video, outdir, start=0.0, end=None, lo=DEFAULT_LO, hi=DEFAULT_HI,
              progress=None):
    if not have_ffmpeg():
        raise RuntimeError("ffmpeg and ffprobe have to be on PATH to import a video")

    os.makedirs(outdir, exist_ok=True)
    work = tempfile.mkdtemp(prefix="frameshop_decode_")
    try:
        decode(video, work, start, end)
        names = sorted(os.listdir(work))
        if not names:
            raise RuntimeError("ffmpeg decoded no frames from that file")

        bg = screen_colour_over([os.path.join(work, n) for n in names])

        leaks, cores = [], []
        for i, name in enumerate(names):
            rgb = np.asarray(Image.open(os.path.join(work, name)).convert("RGB")).astype(np.float32)
            rgba, premult, alpha, diff = key_frame(rgb, bg, lo, hi)
            Image.fromarray(rgba).save(os.path.join(outdir, name))

            # Measure the premultiplied result, never the straight one: straight
            # is already forced to 0 wherever alpha is, so a leak read off it is
            # tautological and always reports 0.
            screen, subject = diff > SCREEN_MARGIN, diff < SUBJECT_MARGIN
            leaks.append(float(premult[screen].mean()) if screen.any() else 0.0)
            cores.append(float(alpha[subject].mean()) if subject.any() else 1.0)

            if progress:
                progress(i + 1, len(names))

        return {
            "directory": outdir,
            "frames": len(names),
            "fps": round(probe_fps(video), 3),
            "screen": [round(float(c), 1) for c in bg],
            "leak": round(float(np.mean(leaks)), 2),
            "core": round(float(np.mean(cores)), 4),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)
