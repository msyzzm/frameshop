#!/usr/bin/env python3
"""Key a green screen out of a video, then curate the frames - in the browser.

    python frameshop.py                               # start at step 1
    python frameshop.py D:\\Download\\clip_keyed_png    # jump straight to step 2
"""

import argparse

from frameshop.library import Library
from frameshop.server import serve


def main():
    ap = argparse.ArgumentParser(
        description="Key a video and curate the resulting frames, in the browser.")
    ap.add_argument("directory", nargs="?",
                    help="folder of frames to open; omit to start at step 1")
    ap.add_argument("--work", default="frameshop_work",
                    help="where keyed PNG sequences land (default: ./frameshop_work)")
    ap.add_argument("-p", "--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true", help="don't launch a browser")
    args = ap.parse_args()

    try:
        library = Library(args.directory) if args.directory else None
    except ValueError as exc:
        raise SystemExit(str(exc))

    serve(library, workroot=args.work, port=args.port, open_browser=not args.no_open)


if __name__ == "__main__":
    main()
