FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg flac git gcc g++ \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install cython && pip install -r requirements.txt --quiet

# yt-dlp: install the NIGHTLY channel — YouTube frequently breaks the stable build
# between releases, and nightly patches it faster. entrypoint.sh also self-updates
# yt-dlp on every container start so a long-running container stays current.
RUN pip install -U --pre "yt-dlp[default]"

WORKDIR /app
COPY . .

ENTRYPOINT ["/app/entrypoint.sh"]
