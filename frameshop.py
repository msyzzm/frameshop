#!/usr/bin/env python3
"""Pick frames out of an image sequence in the browser.

    python frameshop.py D:\\Download\\clip_keyed_png
"""

import argparse

from frameshop.library import Library
from frameshop.server import serve


def main():
    ap = argparse.ArgumentParser(description="Curate an image sequence in the browser.")
    ap.add_argument("directory", help="folder of frames to load")
    ap.add_argument("-p", "--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true", help="don't launch a browser")
    args = ap.parse_args()

    serve(Library(args.directory), port=args.port, open_browser=not args.no_open)


if __name__ == "__main__":
    main()
