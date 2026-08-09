"""Per-user recognition history: persist, cap, retrieve, remove."""

import os
import json
import tempfile
import time

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
HISTORY_DIR = os.path.join(DATA_DIR, "recognize_history")
MAX_ENTRIES = 200


def _path(username: str) -> str:
    return os.path.join(HISTORY_DIR, f"{username}.json")


def _load(username: str) -> list:
    path = _path(username)
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except json.JSONDecodeError:
            # A corrupt file used to be silently treated as an empty list, and
            # since _save() overwrites the file wholesale, the next add_entry()
            # would then destroy whatever was actually on disk. Rename it aside
            # instead so the data isn't lost and the corruption is visible.
            try:
                os.replace(path, f"{path}.corrupt")
            except OSError:
                pass
        except OSError:
            pass
    return []


def _save(username: str, entries: list):
    """Persist history atomically, same pattern as commit 43d0e53's _save_users fix.
    A plain open("w") truncates the file before writing, so a crash or a full disk
    mid-write can leave it empty or half-written. Write to a temp file in the same
    directory, fsync, then os.replace(): a reader always sees either the old complete
    file or the new one, never a partial one.
    """
    os.makedirs(HISTORY_DIR, exist_ok=True)
    payload = json.dumps(entries, indent=2)
    fd, tmp = tempfile.mkstemp(dir=HISTORY_DIR, prefix=".history.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())  # the rename is only safe once the bytes are on disk
        os.replace(tmp, _path(username))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def add_entry(username: str, result: dict, recognized_by: str):
    """Prepend a new entry and cap to MAX_ENTRIES."""
    entry = {
        "ts": time.time(),
        "name": result.get("name", ""),
        "artist": result.get("artist", ""),
        "album": result.get("album", ""),
        "image": result.get("image", ""),
        "url": result.get("url") or result.get("spotify_url", ""),
        "recognized_by": recognized_by,
    }
    entries = _load(username)
    entries.insert(0, entry)
    if len(entries) > MAX_ENTRIES:
        entries = entries[:MAX_ENTRIES]
    _save(username, entries)


def get_history(username: str) -> list:
    """Return entries newest-first."""
    return _load(username)


def clear_history(username: str):
    entries = []
    _save(username, entries)


def remove_entry(username: str, ts: float) -> bool:
    """Remove entry matching ts. Returns True if found."""
    entries = _load(username)
    new_entries = [e for e in entries if abs(e.get("ts", 0) - ts) > 0.001]
    if len(new_entries) == len(entries):
        return False
    _save(username, new_entries)
    return True
