"""Localhost-only HTTP server: the static UI plus a JSON API over one Library.

The API is guarded by a per-run random token that only the page we serve ever
receives. Without it, any web page you happened to have open could POST to this
port and make the tool write files.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import posixpath
import secrets
import shutil
import tempfile
import threading
import zipfile
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import export as exporters
from . import key
from . import transform
from .jobs import Runner
from .library import PREVIEW_MAX, THUMB_MAX, Library

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TOKEN_HEADER = "X-Frameshop-Token"
TEXT = "text/plain; charset=utf-8"


UPLOAD_CHUNK = 1 << 20
MAX_UPLOAD = 4 << 30        # 4 GiB; an unbounded upload endpoint fills the disk


def _loopback(host):
    return host in ("127.0.0.1", "::1", "localhost")


class Handler(BaseHTTPRequestHandler):
    library = None          # rebound whenever step 1 finishes or a dir is opened
    workroot = ""
    root = ""               # every path the client names must sit under this
    password = ""           # Basic auth; empty means the port is trusted
    token = ""
    jobs = Runner()
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
        """CSRF guard. Not authentication — the page hands this out freely."""
        if self.headers.get(TOKEN_HEADER) == self.token:
            return True
        self._json(403, {"error": "bad or missing token"})
        return False

    def _authenticated(self):
        """Basic auth, when a password is configured. This IS the front door.

        Plaintext over HTTP, so it is only meaningful behind TLS, a reverse
        proxy, or a private network. It stops a stranger driving the tool; it
        does not stop anyone reading the wire.
        """
        if not self.password:
            return True

        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            try:
                supplied = base64.b64decode(header[6:]).decode().partition(":")[2]
            except (ValueError, UnicodeDecodeError):
                supplied = ""
            if secrets.compare_digest(supplied, self.password):
                return True

        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="frameshop"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def _within_root(self, path):
        """Resolve a client-supplied path, refusing anything outside the root.

        Without this, `outdir` and `directory` are arbitrary file write and
        read on whatever account the server runs as.
        """
        full = os.path.abspath(path)
        if not self.root:
            return full                 # no jail: the localhost default
        try:
            allowed = os.path.commonpath([full, self.root]) == self.root
        except ValueError:              # different drives on Windows
            allowed = False
        if not allowed:
            raise ValueError(f"path must be inside {self.root}")
        return full

    # -- GET --------------------------------------------------------------

    def do_GET(self):
        if not self._authenticated():
            return
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
                return self._json(200, self._frames_payload())
            if route == "/api/job":
                return self._json(200, self.jobs.status)
            if route in ("/api/thumb", "/api/preview"):
                longest = THUMB_MAX if route == "/api/thumb" else PREVIEW_MAX
                return self._rendition(query, longest)
            if route == "/api/full":
                return self._full(query)
            if route == "/api/download":
                return self._download(query)

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

    def _frames_payload(self):
        lib = self.library
        if lib is None:                     # nothing opened yet: the UI shows step 1
            return {"directory": None, "uniform": True, "frames": [],
                    "workroot": self.workroot, "ffmpeg": key.have_ffmpeg()}
        sizes = {(f.width, f.height) for f in lib.frames}
        return {
            "directory": lib.directory,
            "uniform": len(sizes) == 1,
            "workroot": self.workroot,
            "ffmpeg": key.have_ffmpeg(),
            "frames": [{"name": f.name, "w": f.width, "h": f.height} for f in lib.frames],
        }

    def _rendition(self, query, longest):
        name = (query.get("name") or [""])[0]
        if not self.library or not self.library.get(name):
            return self._send(404, b"unknown frame", TEXT)
        self._send(200, self.library.rendition(name, longest), "image/png")

    def _send_file(self, path, filename):
        """Stream a file as an attachment. Streamed, not read: a full-res APNG
        of a long clip is not something to hold in memory to hand over."""
        self.send_response(200)
        self.send_header("Content-Type",
                         mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(os.path.getsize(path)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        with open(path, "rb") as handle:
            shutil.copyfileobj(handle, self.wfile, UPLOAD_CHUNK)

    def _download(self, query):
        """Hand exported files back to the browser.

        Everything runs server-side, so without this the results of a remote
        session sit on the server and you go find them over ssh.
        """
        try:
            paths = [self._within_root(p) for p in query.get("path") or []]
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})

        missing = [p for p in paths if not os.path.isfile(p)]
        if not paths or missing:
            return self._json(404, {"error": f"no such file: {missing or 'nothing requested'}"})

        if len(paths) == 1:
            return self._send_file(paths[0], os.path.basename(paths[0]))

        stem = (query.get("name") or ["frameshop"])[0]
        fd, archive = tempfile.mkstemp(prefix="frameshop_zip_", suffix=".zip")
        os.close(fd)
        try:
            # Stored, not deflated: PNG/GIF are already compressed, so deflate
            # would spend the CPU for roughly nothing.
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as bundle:
                for path in paths:
                    bundle.write(path, os.path.basename(path))
            self._send_file(archive, f"{os.path.basename(stem) or 'frameshop'}.zip")
        finally:
            os.unlink(archive)

    def _full(self, query):
        """The untouched source file — the preview rendition is too small to
        zoom into, which is the whole point of zooming."""
        name = (query.get("name") or [""])[0]
        frame = self.library.get(name) if self.library else None
        if not frame:
            return self._send(404, b"unknown frame", TEXT)
        ctype = mimetypes.guess_type(frame.path)[0] or "application/octet-stream"
        with open(frame.path, "rb") as handle:
            self._send(200, handle.read(), ctype)

    # -- POST -------------------------------------------------------------

    def do_POST(self):
        if not self._authenticated():
            return
        route = urlparse(self.path).path
        handlers = {"/api/export": self._export, "/api/autocrop": self._autocrop,
                    "/api/open": self._open}
        if route != "/api/import" and route not in handlers:
            return self._send(404, b"not found", TEXT)
        if not self._authorised():
            return
        if route == "/api/import":
            return self._import()           # binary body, not JSON

        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"error": "malformed JSON"})

        try:
            self._json(200, handlers[route](request))
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except OSError as exc:
            self._json(500, {"error": f"{type(exc).__name__}: {exc}"})

    def _picked(self, request):
        if not self.library:
            raise ValueError("no frames are open")
        names = [n for n in request.get("names") or [] if self.library.get(n)]
        if not names:
            raise ValueError("nothing selected")
        return names

    def _open(self, request):
        directory = (request.get("directory") or "").strip()
        if not directory:
            raise ValueError("no directory given")
        Handler.library = Library(self._within_root(directory))
        return self._frames_payload()

    def _spool_upload(self, suffix):
        """Stream the request body to a temp file. Videos are too big to hold."""
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            raise ValueError("empty upload")
        if length > MAX_UPLOAD:
            raise ValueError(f"upload is larger than the {MAX_UPLOAD >> 30} GiB limit")

        fd, path = tempfile.mkstemp(prefix="frameshop_upload_", suffix=suffix)
        with os.fdopen(fd, "wb") as handle:
            left = length
            while left > 0:
                chunk = self.rfile.read(min(UPLOAD_CHUNK, left))
                if not chunk:
                    break
                handle.write(chunk)
                left -= len(chunk)
        return path

    def _import(self):
        """Step 1: raw video bytes in the body, keyed PNG sequence out.

        Raw rather than multipart - there is exactly one file and no form
        fields, so multipart would only add a parser to get wrong.
        """
        query = parse_qs(urlparse(self.path).query)
        arg = lambda name, default="": (query.get(name) or [default])[0]  # noqa: E731

        filename = os.path.basename(arg("name", "clip.mp4"))
        stem = os.path.splitext(filename)[0] or "clip"

        try:
            outdir = self._within_root(
                os.path.join(arg("outdir") or self.workroot, f"{stem}_keyed_png"))
            video = self._spool_upload(os.path.splitext(filename)[1] or ".mp4")
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})

        def work(progress):
            try:
                end = arg("end")
                result = key.key_video(
                    video, outdir,
                    start=float(arg("start", "0")),
                    end=float(end) if end else None,
                    lo=float(arg("lo", key.DEFAULT_LO)),
                    hi=float(arg("hi", key.DEFAULT_HI)),
                    progress=progress)
            finally:
                os.unlink(video)            # the upload was only ever a scratch copy
            Handler.library = Library(result["directory"])
            return result

        try:
            self.jobs.start(work, label=filename)
        except ValueError as exc:
            os.unlink(video)
            return self._json(409, {"error": str(exc)})
        return self._json(202, {"started": True, "outdir": outdir})

    def _autocrop(self, request):
        names = self._picked(request)
        box = transform.subject_bbox(
            (self.library.open_rgba(n) for n in names),
            threshold=int(request.get("threshold") or 8),
            padding=int(request.get("padding") or 0))
        if box is None:
            raise ValueError("every picked frame is fully transparent")
        return {**box, "frames": len(names)}

    def _export(self, request):
        names = self._picked(request)

        outdir = (request.get("outdir") or "").strip()
        if not outdir:
            raise ValueError("no output directory")
        outdir = self._within_root(outdir)

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


def _check_writable(directory):
    """Fail at startup rather than halfway through someone's first import.

    A bind-mounted volume carries the host directory's ownership and overrides
    whatever the image chowned, which is the usual reason this is unwritable.
    """
    probe = os.path.join(directory, ".frameshop-write-test")
    try:
        os.makedirs(directory, exist_ok=True)
        with open(probe, "w"):
            pass
        os.remove(probe)
    except OSError as exc:
        uid = getattr(os, "getuid", lambda: "?")()
        raise SystemExit(
            f"cannot write to {directory}: {exc}\n"
            f"this process runs as uid {uid}. In Docker a bind-mounted volume "
            f"keeps the host directory's owner, so either chown it to that uid "
            f"or use a named volume.")


def serve(library=None, workroot="", root="", host="127.0.0.1", port=8765,
          password="", open_browser=True):
    # Fail closed. Exposing this without auth hands anyone who can reach the
    # port arbitrary file read and write as whatever user we run as.
    if not _loopback(host) and not password:
        raise SystemExit(
            f"refusing to bind {host} without a password - set FRAMESHOP_TOKEN")

    Handler.library = library
    Handler.workroot = os.path.abspath(workroot or "frameshop_work")
    _check_writable(Handler.workroot)
    Handler.root = os.path.abspath(root) if root else ""
    Handler.password = password
    Handler.token = secrets.token_urlsafe(16)

    httpd = ThreadingHTTPServer((host, port), Handler)
    shown = "127.0.0.1" if host == "0.0.0.0" else host
    url = f"http://{shown}:{port}/"

    if library:
        print(f"{len(library.frames)} frames from {library.directory}")
    else:
        print(f"no frames open - start at step 1. keyed output goes to {Handler.workroot}")
    if Handler.root:
        print(f"paths confined to {Handler.root}")
    if password:
        print("basic auth on (user: anything, password: $FRAMESHOP_TOKEN)")
    if not key.have_ffmpeg():
        print("ffmpeg/ffprobe not on PATH - step 1 (video import) will not work")
    print(f"listening on {host}:{port} - open {url}   (ctrl-c to stop)")
    if open_browser:
        threading.Timer(0.4, webbrowser.open, args=[url]).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
