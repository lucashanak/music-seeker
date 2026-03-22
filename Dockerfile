FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools flac     && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt --quiet

WORKDIR /app
COPY . .

ENTRYPOINT ["/app/entrypoint.sh"]
