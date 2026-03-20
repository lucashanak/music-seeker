FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools     && rm -rf /var/lib/apt/lists/*

RUN pip install fastapi uvicorn httpx shazamio python-multipart pyacoustid --quiet

WORKDIR /app
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090"]
