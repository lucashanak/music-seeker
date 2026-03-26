#!/bin/sh

# Auto-bump cache version on every container start
CACHE_BUST=$(date +%s)

# Replace placeholders in HTML (CSS links, favicon, main script tag)
sed -i "s/__CACHE_BUST__/${CACHE_BUST}/g" /app/static/index.html

# Add cache bust to all JS module imports (from './foo.js' → from './foo.js?v=...')
for f in /app/static/js/*.js; do
  sed -i "s/\.js'/\.js?v=${CACHE_BUST}'/g" "$f"
done

if [ -f /app/certs/cert.pem ] && [ -f /app/certs/key.pem ]; then
  echo "Starting with HTTPS..."
  exec uvicorn main:app --host 0.0.0.0 --port 8090 --ssl-keyfile /app/certs/key.pem --ssl-certfile /app/certs/cert.pem
else
  echo "Starting with HTTP (no certs found)..."
  exec uvicorn main:app --host 0.0.0.0 --port 8090
fi
