"""Imported playlists: app-side persistence for lists that aren't in Navidrome.

An imported playlist is the whole list a user pasted/harvested (e.g. 155 tracks of
which they own 78). It deliberately does NOT become a Navidrome playlist: Subsonic
playlists can only reference songs that exist in the library, so persisting there
would silently drop every track the user hasn't downloaded. Missing tracks still
play (local -> Navidrome -> YouTube), so the whole list is worth keeping as-is.

Storage mirrors the playlist_covers.json / likes.json pattern in
app/routers/library.py: one JSON file under DATA_DIR, `{username: {playlist_id: entry}}`,
written atomically (temp file + os.replace) under a threading.Lock, and degrading to
`{}` on a missing or corrupt file rather than raising.
"""

import json
import os
import re
import tempfile
import threading
import time
import uuid

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
IMPORTED_PLAYLISTS_FILE = os.path.join(DATA_DIR, "imported_playlists.json")
_lock = threading.Lock()

# Imported ids share a namespace with Navidrome playlist ids in the frontend
# (both end up in the same Library grid and in playlist routes), so they carry a
# prefix that a Subsonic id can never have.
ID_PREFIX = "imp_"

# Bounds. This is user-supplied JSON landing on a small disk (prod root is 63 GB),
# and the whole store is read+rewritten on every save, so it must stay bounded.
MAX_TRACKS = 2000               # per playlist; a save past this truncates and says so
MAX_PLAYLISTS = 100             # per user; a save past this is rejected
MAX_NAME_LEN = 200
MAX_URL_LEN = 2048              # image / source_url
MAX_SOURCE_LEN = 40             # "spotify", "deezer", "harvest", ...
MAX_TRACK_FIELD_LEN = 500       # name / artist / album
MAX_TRACK_ID_LEN = 128

DEFAULT_NAME = "Imported playlist"

# The exact stored track shape. Anything else in an incoming track is dropped.
TRACK_KEYS = ("name", "artist", "album", "image", "duration_ms", "id")


class PlaylistLimit(Exception):
    """Raised when a user is already at MAX_PLAYLISTS saved imports."""


def _clean(value, limit: int) -> str:
    """Collapse whitespace, trim, and cap length. Non-strings become ""."""
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()[:limit]


def _load() -> dict:
    """Load the whole store: {username: {playlist_id: entry}}. Never raises."""
    if os.path.exists(IMPORTED_PLAYLISTS_FILE):
        try:
            with open(IMPORTED_PLAYLISTS_FILE) as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, OSError, ValueError):
            pass
    return {}


def _save_store(data: dict):
    """Atomic write (same pattern as _save_playlist_covers): temp file in the same
    dir, fsync, then os.replace — a crash mid-dump can't truncate the file and wipe
    every user's saved imports. Written compact on purpose: with the caps above the
    payload can reach tens of MB and indent=2 would roughly double that."""
    os.makedirs(DATA_DIR, exist_ok=True)
    payload = json.dumps(data, separators=(",", ":"))
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix=".imported_playlists.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())  # the rename is only safe once the bytes are on disk
        os.replace(tmp, IMPORTED_PLAYLISTS_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _new_id() -> str:
    return f"{ID_PREFIX}{uuid.uuid4().hex[:12]}"


def normalize_tracks(tracks) -> tuple[list[dict], bool]:
    """Reduce incoming tracks to exactly TRACK_KEYS, capped at MAX_TRACKS.

    Returns `(tracks, truncated)`. Entries without a usable `name` are skipped —
    they'd be unplayable rows in the list.
    """
    out: list[dict] = []
    truncated = False
    for raw in (tracks or []):
        if not isinstance(raw, dict):
            continue
        name = _clean(raw.get("name"), MAX_TRACK_FIELD_LEN)
        if not name:
            continue
        if len(out) >= MAX_TRACKS:
            truncated = True
            break
        duration = raw.get("duration_ms")
        if not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration < 0:
            duration = 0
        out.append({
            "name": name,
            "artist": _clean(raw.get("artist"), MAX_TRACK_FIELD_LEN),
            "album": _clean(raw.get("album"), MAX_TRACK_FIELD_LEN),
            "image": _clean(raw.get("image"), MAX_URL_LEN),
            "duration_ms": int(duration),
            "id": _clean(raw.get("id"), MAX_TRACK_ID_LEN),
        })
    return out, truncated


def _summary(entry: dict) -> dict:
    """Entry minus its track array — the Library grid must not have to download a
    155-track payload per card just to render the tiles."""
    return {k: v for k, v in entry.items() if k != "tracks"}


def list_for(username: str) -> list[dict]:
    """Summaries (no `tracks`) of one user's saved imports, newest first."""
    with _lock:
        entries = _load().get(username) or {}
    if not isinstance(entries, dict):
        return []
    out = [_summary(e) for e in entries.values() if isinstance(e, dict)]
    out.sort(key=lambda e: e.get("created_at") or 0, reverse=True)
    return out


def get(username: str, pid: str) -> dict | None:
    """One full entry (including `tracks`), or None when the id isn't this user's."""
    with _lock:
        entry = (_load().get(username) or {}).get(pid)
    return entry if isinstance(entry, dict) else None


def save(username: str, data: dict) -> dict:
    """Persist a new imported playlist. Returns its summary plus `truncated`.

    `data` takes `{name, image, source, source_url, tracks}`; unknown keys are
    ignored. Raises PlaylistLimit once the user holds MAX_PLAYLISTS imports.
    """
    tracks, truncated = normalize_tracks(data.get("tracks"))
    now = time.time()
    entry = {
        "id": _new_id(),
        "name": _clean(data.get("name"), MAX_NAME_LEN) or DEFAULT_NAME,
        "image": _clean(data.get("image"), MAX_URL_LEN),
        "source": _clean(data.get("source"), MAX_SOURCE_LEN),
        "source_url": _clean(data.get("source_url"), MAX_URL_LEN),
        "count": len(tracks),
        "created_at": now,
        "updated_at": now,
        "tracks": tracks,
    }
    with _lock:
        store = _load()
        entries = store.get(username)
        if not isinstance(entries, dict):
            entries = {}
        if len(entries) >= MAX_PLAYLISTS:
            raise PlaylistLimit(
                f"You already have {MAX_PLAYLISTS} saved imported playlists — "
                "delete one before importing another.")
        while entry["id"] in entries:
            entry["id"] = _new_id()
        entries[entry["id"]] = entry
        store[username] = entries
        _save_store(store)
    return {**_summary(entry), "truncated": truncated}


def rename(username: str, pid: str, name: str) -> dict | None:
    """Rename one entry. Returns the new summary, or None when the id is unknown."""
    with _lock:
        store = _load()
        entries = store.get(username)
        if not isinstance(entries, dict):
            return None
        entry = entries.get(pid)
        if not isinstance(entry, dict):
            return None
        entry["name"] = _clean(name, MAX_NAME_LEN) or DEFAULT_NAME
        entry["updated_at"] = time.time()
        store[username] = entries
        _save_store(store)
        return _summary(entry)


def delete(username: str, pid: str) -> bool:
    """Drop one entry. False when the id isn't this user's (nothing was written)."""
    with _lock:
        store = _load()
        entries = store.get(username)
        if not isinstance(entries, dict) or pid not in entries:
            return False
        entries.pop(pid, None)
        store[username] = entries
        _save_store(store)
        return True
