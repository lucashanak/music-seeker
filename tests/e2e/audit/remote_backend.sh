#!/bin/sh
# Local backend for tests/e2e/audit/remote.mjs — the remote-control fix changes the
# BACKEND (tab_id, per-tab delivery, GET /api/remote/queue, transfer merge), and
# serveWorktree() only swaps the FRONTEND in front of production. This runs the tree's
# own FastAPI app on this host so "passes over the tree" means the tree's backend too.
#
#   tests/e2e/audit/remote_backend.sh start [TREE]   # prints MS_URL=… when ready
#   tests/e2e/audit/remote_backend.sh stop           # kills it and DELETES the scratch dir
#
# What it is and is not:
#   - a COPY of the tree (taken at `start`; restart to pick up new edits), with the same
#     cache-bust rewrite entrypoint.sh does, served by uvicorn on 127.0.0.1:$MS_PORT;
#   - a scratch DATA_DIR holding ONLY claude_test's user record, read (read-only) from
#     the production users.json over ssh — no other user's record is ever copied;
#   - an empty MUSIC_DIR and a scratch TMPDIR (stream caches), so tracks stream from the
#     real Navidrome at 192.168.1.22:4533 as claude_test. Use OWNED tracks only: an
#     unowned one would go to YouTube from this host's address.
#   - Navidrome playlist writes (Up Next of the test devices) are REAL, same as a run
#     against production.
# `stop` removes the whole scratch dir, including the copied record.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=${2:-$(cd "$HERE/../../.." && pwd)}
PORT=${MS_PORT:-18094}
DIR=${MS_HARNESS_DIR:-${TMPDIR:-/tmp}/ms-remote-harness-$(id -u)}
KEY=${MS_SSH_KEY:-$HOME/.ssh/yams_key}

case "${1:-}" in
start)
  if [ -f "$DIR/pid" ] && kill -0 "$(cat "$DIR/pid")" 2>/dev/null; then
    echo "already running (pid $(cat "$DIR/pid")); stop it first" >&2; exit 1
  fi
  rm -rf "${DIR:?}/app"
  mkdir -p "$DIR/app" "$DIR/data" "$DIR/music" "$DIR/tmp"
  chmod 700 "$DIR"
  # The tree, minus what the image never ships either.
  tar -C "$TREE" --exclude='.git' --exclude='data' --exclude='__pycache__' \
      --exclude='node_modules' --exclude='notes' --exclude='screenshots' -cf - . \
    | tar -C "$DIR/app" -xf - || { echo "copy of $TREE failed" >&2; exit 2; }
  STAMP=$(date +%s)
  sed -i "s/__CACHE_BUST__/${STAMP}/g" "$DIR/app/static/index.html"
  for f in "$DIR"/app/static/js/*.js; do sed -i "s/\.js'/\.js?v=${STAMP}'/g" "$f"; done
  if [ ! -s "$DIR/data/users.json" ]; then
    ssh -i "$KEY" -o ConnectTimeout=8 -o BatchMode=yes deploy@192.168.1.22 \
      "sudo python3 -c \"import json;u=json.load(open('/home/yams/yams-server/config/music-seeker/users.json'));print(json.dumps({'claude_test':u['claude_test']}))\"" \
      > "$DIR/data/users.json.tmp" || { echo "could not read claude_test's record" >&2; rm -f "$DIR/data/users.json.tmp"; exit 2; }
    python3 -c "import json,sys;d=json.load(open(sys.argv[1]));assert list(d)==['claude_test']" "$DIR/data/users.json.tmp" \
      || { echo "record is not exactly claude_test" >&2; rm -f "$DIR/data/users.json.tmp"; exit 2; }
    mv "$DIR/data/users.json.tmp" "$DIR/data/users.json"
    chmod 600 "$DIR/data/users.json"
  fi
  cd "$DIR/app" || exit 2
  # library.py returns nothing at all while the SERVICE account has no password, and
  # falls back to the service account wherever no user is bound. Make the service
  # account claude_test itself, so even an unbound call never acts as anyone else.
  NDPW=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['claude_test'].get('navidrome_password',''))" "$DIR/data/users.json")
  NDUSER=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['claude_test'].get('navidrome_user',''))" "$DIR/data/users.json")
  DATA_DIR="$DIR/data" MUSIC_DIR="$DIR/music" TMPDIR="$DIR/tmp" \
  NAVIDROME_URL=http://192.168.1.22:4533 NAVIDROME_USER="$NDUSER" NAVIDROME_PASSWORD="$NDPW" \
  YTDLP_NO_UPDATE=1 \
    nohup python3 -m uvicorn main:app --host 127.0.0.1 --port "$PORT" > "$DIR/server.log" 2>&1 &
  echo $! > "$DIR/pid"
  i=0
  while [ $i -lt 60 ]; do
    if curl -s -m 2 "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1; then
      echo "MS_URL=http://127.0.0.1:$PORT  (tree $TREE, log $DIR/server.log)"; exit 0
    fi
    kill -0 "$(cat "$DIR/pid")" 2>/dev/null || break
    sleep 1; i=$((i + 1))
  done
  echo "backend did not come up; last log lines:" >&2; tail -20 "$DIR/server.log" >&2; exit 2
  ;;
stop)
  if [ -f "$DIR/pid" ]; then kill "$(cat "$DIR/pid")" 2>/dev/null; sleep 1; kill -9 "$(cat "$DIR/pid")" 2>/dev/null; fi
  rm -rf "${DIR:?}"
  echo "stopped; $DIR removed"
  ;;
restart)
  # Fresh copy of the tree, same scratch data (the record is not fetched again).
  if [ -f "$DIR/pid" ]; then kill "$(cat "$DIR/pid")" 2>/dev/null; sleep 1; kill -9 "$(cat "$DIR/pid")" 2>/dev/null; fi
  exec "$0" start "$TREE"
  ;;
log) tail -n "${3:-60}" "$DIR/server.log" ;;
*) echo "usage: $0 start [TREE] | restart [TREE] | stop | log" >&2; exit 2 ;;
esac
