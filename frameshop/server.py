"""Localhost-only HTTP server: the static UI plus a JSON API over one Library.

The API is guarded by a per-run random token that only the page we serve ever
receives. Without it, any web page you happened to have open could POST to this
port and make the tool write files.
"""

from __future__ import annotations

import json
import mimetypes
import os
import posixpath
import secrets
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import export as exporters
from . import transform
from .library import PREVIEW_MAX, THUMB_MAX

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TOKEN_HEADER = "X-Frameshop-Token"
TEXT = "text/plain; charset=utf-8"


class Handler(BaseHTTPRequestHandler):
    library = None
    token = ""
    server_version = "frameshop"

    def log_message(self, fmt, *args):
        pass    # a request log line per thumbnail would bury the useful output

    # -- plumbing ---------------------------------------------------------

    def _send(self, code, body=b"", ctype="application/octet-stream"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json")

    def _authorised(self):
        if self.headers.get(TOKEN_HEADER) == self.token:
            return True
        self._json(403, {"error": "bad or missing token"})
        return False

    # -- GET --------------------------------------------------------------

    def do_GET(self):
        url = urlparse(self.path)
        route, query = url.path, parse_qs(url.query)

        if route == "/":
            return self._index()
        if route.startswith("/static/"):
            return self._static(route)

        if route.startswith("/api/"):
            if not self._authorised():
                return
            if route == "/api/frames":
                return self._frames()
            if route in ("/api/thumb", "/api/preview"):
                longest = THUMB_MAX if route == "/api/thumb" else PREVIEW_MAX
                return self._rendition(query, longest)

        self._send(404, b"not found", TEXT)

    def _index(self):
        with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as handle:
            page = handle.read().replace("__TOKEN__", self.token)
        self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")

    def _static(self, route):
        rel = posixpath.normpath(route[len("/static/"):]).lstrip("./")
        path = os.path.abspath(os.path.join(STATIC_DIR, *rel.split("/")))
        if not path.startswith(STATIC_DIR) or not os.path.isfile(path):
            return self._send(404, b"not found", TEXT)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as handle:
            self._send(200, handle.read(), ctype)

    def _frames(self):
        lib = self.library
        sizes = {(f.width, f.height) for f in lib.frames}
        self._json(200, {
            "directory": lib.directory,
            "uniform": len(sizes) == 1,
            "frames": [{"name": f.name, "w": f.width, "h": f.height} for f in lib.frames],
        })

    def _rendition(self, query, longest):
        name = (query.get("name") or [""])[0]
        if not self.library.get(name):
            return self._send(404, b"unknown frame", TEXT)
        self._send(200, self.library.rendition(name, longest), "image/png")

    # -- POST -------------------------------------------------------------

    def do_POST(self):
        if urlparse(self.path).path != "/api/export":
            return self._send(404, b"not found", TEXT)
        if not self._authorised():
            return

        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"error": "malformed JSON"})

        try:
            self._json(200, self._export(request))
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except OSError as exc:
            self._json(500, {"error": f"{type(exc).__name__}: {exc}"})

    def _export(self, request):
        names = [n for n in request.get("names") or [] if self.library.get(n)]
        if not names:
            raise ValueError("nothing selected")

        outdir = (request.get("outdir") or "").strip()
        if not outdir:
            raise ValueError("no output directory")

        formats = request.get("formats") or []
        if not formats:
            raise ValueError("pick at least one export format")

        fps = float(request.get("fps") or 24)
        if fps <= 0:
            raise ValueError("fps must be positive")

        stem = (request.get("stem") or "").strip() \
            or os.path.basename(self.library.directory) or "frames"
        os.makedirs(outdir, exist_ok=True)

        crop, resize = request.get("crop"), request.get("resize")
        frames = [(name, transform.apply(self.library.open_rgba(name), crop, resize))
                  for name in names]

        sizes = {im.size for _, im in frames}
        if len(sizes) != 1:
            raise ValueError(f"frames differ in size after transform: {sorted(sizes)}"
                             " - set an explicit resize")

        written = []
        if "sheet" in formats:
            written += exporters.sprite_sheet(
                frames, outdir, stem, fps, int(request.get("columns") or 0))
        if "gif" in formats:
            written += exporters.gif(frames, outdir, stem, fps)
        if "apng" in formats:
            written += exporters.apng(frames, outdir, stem, fps)

        return {
            "count": len(frames),
            "size": list(frames[0][1].size),
            "written": [{"path": p, "bytes": os.path.getsize(p)} for p in written],
        }


def serve(library, port=8765, open_browser=True):
    Handler.library = library
    Handler.token = secrets.token_urlsafe(16)

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"

    print(f"{len(library.frames)} frames from {library.directory}")
    print(f"open {url}   (ctrl-c to stop)")
    if open_browser:
        threading.Timer(0.4, webbrowser.open, args=[url]).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
