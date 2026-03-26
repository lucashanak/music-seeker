#!/bin/sh

# Auto-bump cache version on every container start
CACHE_BUST=$(date +%s)
sed -i "s/__CACHE_BUST__/${CACHE_BUST}/g" /app/static/index.html

if [ -f /app/certs/cert.pem ] && [ -f /app/certs/key.pem ]; then
  echo "Starting with HTTPS..."
  exec uvicorn main:app --host 0.0.0.0 --port 8090 --ssl-keyfile /app/certs/key.pem --ssl-certfile /app/certs/cert.pem
else
  echo "Starting with HTTP (no certs found)..."
  exec uvicorn main:app --host 0.0.0.0 --port 8090
fi
