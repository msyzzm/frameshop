FROM python:3.12-slim

# ffmpeg/ffprobe are step 1's decoder. Without them the image still serves
# step 2, but a video import fails before the first frame.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "pillow>=10" "numpy>=1.24"

WORKDIR /app
COPY frameshop.py ./
COPY frameshop ./frameshop

# Everything the client can name is confined to /data, and nothing runs as
# root: an upload endpoint plus a client-supplied output path is a bad pair to
# hand a privileged account.
RUN useradd --create-home --uid 10001 app \
 && mkdir -p /data \
 && chown -R app:app /data
USER app

VOLUME ["/data"]
EXPOSE 8765

# FRAMESHOP_TOKEN is required at runtime: the server refuses a non-loopback
# bind without one, rather than coming up open to the network.
CMD ["python", "frameshop.py", \
     "--no-open", \
     "--host", "0.0.0.0", \
     "--port", "8765", \
     "--root", "/data", \
     "--work", "/data/work"]
