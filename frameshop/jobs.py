"""One background job at a time, with a status the UI can poll.

Keying a clip takes tens of seconds. Doing it inside the POST would leave the
page staring at a hung request with no idea whether it was working or wedged.
One slot is enough: there is a single person driving a single library.
"""

from __future__ import annotations

import threading


class Runner:
    def __init__(self):
        self._lock = threading.Lock()
        self.status = {"state": "idle"}

    def start(self, work, label=""):
        """`work` is called with a progress(done, total) callback."""
        with self._lock:
            if self.status.get("state") == "running":
                raise ValueError("a job is already running")
            self.status = {"state": "running", "label": label, "done": 0, "total": 0}

        threading.Thread(target=self._run, args=(work,), daemon=True).start()

    def _run(self, work):
        try:
            result = work(self._progress)
            self.status = {"state": "done", **(result or {})}
        except Exception as exc:                    # surfaced to the UI verbatim
            self.status = {"state": "error", "error": f"{type(exc).__name__}: {exc}"}

    def _progress(self, done, total):
        # Mutating in place is deliberate: a poll may catch a half-updated dict,
        # and a progress number one frame out of date is harmless.
        if self.status.get("state") == "running":
            self.status["done"], self.status["total"] = done, total
