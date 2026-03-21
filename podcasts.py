"""Podcast subscription management and auto-sync."""

import os
import json
import asyncio
import time

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
SUBS_FILE = os.path.join(DATA_DIR, "podcast_subs.json")

_subs: list[dict] = []
# Each sub: {"show_name": str, "spotify_id": str, "image": str, "max_episodes": 0 (0=unlimited), "added_at": float}


def _load():
    global _subs
    if os.path.exists(SUBS_FILE):
        try:
            with open(SUBS_FILE) as f:
                _subs = json.load(f)
        except (json.JSONDecodeError, OSError):
            _subs = []


def _save():
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SUBS_FILE, "w") as f:
        json.dump(_subs, f, indent=2)


_load()


def get_subs() -> list[dict]:
    return list(_subs)


def subscribe(show_name: str, spotify_id: str, image: str = "", max_episodes: int = 0) -> bool:
    if any(s["spotify_id"] == spotify_id for s in _subs):
        return False
    _subs.append({
        "show_name": show_name,
        "spotify_id": spotify_id,
        "image": image,
        "max_episodes": max_episodes,
        "added_at": time.time(),
    })
    _save()
    return True


def unsubscribe(spotify_id: str) -> bool:
    global _subs
    before = len(_subs)
    _subs = [s for s in _subs if s["spotify_id"] != spotify_id]
    if len(_subs) < before:
        _save()
        return True
    return False


def update_sub(spotify_id: str, max_episodes: int | None = None) -> bool:
    for sub in _subs:
        if sub["spotify_id"] == spotify_id:
            if max_episodes is not None:
                sub["max_episodes"] = max_episodes
            _save()
            return True
    return False


def get_local_episodes(show_name: str) -> list[str]:
    """Get list of downloaded episode filenames (without extension) for a show."""
    music_dir = os.environ.get("MUSIC_DIR", "/music")
    show_dir = os.path.join(music_dir, "Podcasts", show_name)
    if not os.path.isdir(show_dir):
        return []
    return [os.path.splitext(f)[0] for f in os.listdir(show_dir) if os.path.isfile(os.path.join(show_dir, f))]


def cleanup_old_episodes(show_name: str, max_episodes: int) -> int:
    """Delete oldest episodes beyond the limit. Returns number deleted."""
    if max_episodes <= 0:
        return 0
    music_dir = os.environ.get("MUSIC_DIR", "/music")
    show_dir = os.path.join(music_dir, "Podcasts", show_name)
    if not os.path.isdir(show_dir):
        return 0
    files = []
    for f in os.listdir(show_dir):
        fpath = os.path.join(show_dir, f)
        if os.path.isfile(fpath):
            files.append((fpath, os.path.getmtime(fpath)))
    files.sort(key=lambda x: x[1], reverse=True)  # newest first
    deleted = 0
    for fpath, _ in files[max_episodes:]:
        os.remove(fpath)
        deleted += 1
    return deleted
