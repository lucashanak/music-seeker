FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools     && rm -rf /var/lib/apt/lists/*

RUN pip install fastapi uvicorn httpx shazamio python-multipart pyacoustid spotdl --quiet

WORKDIR /app
COPY . .

ENTRYPOINT ["/app/entrypoint.sh"]
