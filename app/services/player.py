"""Audio streaming and queue persistence for the in-browser player."""
import asyncio
import json
import os
import re
import time
from pathlib import Path

import httpx

from app.services import library

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
PLAYER_DIR = DATA_DIR / "player"
MUSIC_DIR = Path(os.environ.get("MUSIC_DIR", "/music"))

# In-memory cache for resolved YouTube stream URLs (4h TTL)
_url_cache: dict[str, tuple[dict, float]] = {}
_URL_TTL = 4 * 3600  # 4 hours


def _cache_key(name: str, artist: str) -> str:
    return f"{artist.lower().strip()}:{name.lower().strip()}"


def _sanitize(s: str) -> str:
    """Match downloader.py sanitization for filename lookup."""
    return re.sub(r'[/\\:*?"<>|]', '_', s).strip().rstrip('.')


def _resolve_local_file(name: str, artist: str) -> dict | None:
    """Check if track exists as a downloaded file in any user's folder."""
    if not MUSIC_DIR.is_dir():
        return None
    safe_title = _sanitize(name) if name else ""
    safe_artist = _sanitize(artist) if artist else ""
    if not safe_title:
        return None
    # Generate title variants to handle different sanitization styles
    title_variants = {safe_title}
    # Also try with spaces instead of underscores (older downloads)
    alt = re.sub(r'[/\\:*?"<>|]', ' ', name).strip().rstrip('.')
    alt = re.sub(r'\s+', ' ', alt)  # collapse multiple spaces
    title_variants.add(alt)

    # Search across all user dirs: /music/{user}/{artist}/{album}/{title}.ext
    for user_dir in MUSIC_DIR.iterdir():
        if not user_dir.is_dir() or user_dir.name.startswith('.'):
            continue
        search_dirs = []
        if safe_artist:
            artist_dir = user_dir / safe_artist
            if artist_dir.is_dir():
                search_dirs.append(artist_dir)
        else:
            search_dirs.append(user_dir)
        for search_dir in search_dirs:
            for title in title_variants:
                for ext in ("flac", "mp3", "opus", "m4a"):
                    matches = list(search_dir.rglob(f"{title}.{ext}"))
                    if matches:
                        return {"source": "local", "path": str(matches[0])}
    return None


def find_track_file(name: str, artist: str) -> str | None:
    """Find the file path of a downloaded track. Returns path or None."""
    result = _resolve_local_file(name, artist)
    return result["path"] if result else None


def delete_track_file(name: str, artist: str) -> bool:
    """Delete a downloaded track file from disk."""
    path = find_track_file(name, artist)
    if not path:
        return False
    try:
        os.remove(path)
        # Clean up empty parent dirs
        parent = Path(path).parent
        while parent != MUSIC_DIR and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
        # Invalidate URL cache
        key = _cache_key(name, artist)
        _url_cache.pop(key, None)
        return True
    except Exception:
        return False


def delete_album_files(artist: str, album: str) -> int:
    """Delete all files for an album. Returns count of deleted files."""
    if not MUSIC_DIR.is_dir() or not artist or not album:
        return 0
    safe_artist = _sanitize(artist)
    deleted = 0
    for user_dir in MUSIC_DIR.iterdir():
        if not user_dir.is_dir() or user_dir.name.startswith('.'):
            continue
        artist_dir = user_dir / safe_artist
        if not artist_dir.is_dir():
            continue
        album_dir = artist_dir / _sanitize(album)
        if album_dir.is_dir():
            import shutil
            shutil.rmtree(album_dir)
            deleted += 1
        else:
            # Check for files matching album in subdirs
            for f in artist_dir.rglob("*"):
                if f.is_file() and _sanitize(album).lower() in f.parent.name.lower():
                    f.unlink()
                    deleted += 1
    # Clean up empty dirs
    for user_dir in MUSIC_DIR.iterdir():
        if not user_dir.is_dir() or user_dir.name.startswith('.'):
            continue
        artist_dir = user_dir / safe_artist
        if artist_dir.is_dir() and not any(artist_dir.iterdir()):
            artist_dir.rmdir()
    return deleted


async def resolve_stream(name: str, artist: str) -> dict | None:
    """Resolve a track to a streamable source. Local file > Navidrome > YouTube."""
    # Check cache first
    key = _cache_key(name, artist)
    cached = _url_cache.get(key)
    if cached and time.time() - cached[1] < _URL_TTL:
        return cached[0]

    # Try local downloaded files first
    result = _resolve_local_file(name, artist)
    if result:
        _url_cache[key] = (result, time.time())
        return result

    # Try Navidrome
    result = await _resolve_navidrome(name, artist)
    if result:
        _url_cache[key] = (result, time.time())
        return result

    # Fall back to YouTube
    result = await _resolve_youtube(name, artist)
    if result:
        _url_cache[key] = (result, time.time())
        return result

    return None


async def _resolve_navidrome(name: str, artist: str) -> dict | None:
    """Check if track exists in Navidrome and return stream info."""
    try:
        song_id = await library.find_song_id(name, artist)
        if not song_id:
            return None
        return {
            "source": "navidrome",
            "song_id": song_id,
        }
    except Exception:
        return None


async def _resolve_youtube(name: str, artist: str) -> dict | None:
    """Get direct audio URL from YouTube via yt-dlp."""
    query = f"{artist} {name}" if artist else name
    try:
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp", "-f", "bestaudio", "--print", "url",
            "--no-playlist", f"ytsearch1:{query}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode != 0 or not stdout:
            return None
        url = stdout.decode().strip()
        if not url:
            return None
        return {
            "source": "youtube",
            "url": url,
        }
    except (asyncio.TimeoutError, Exception):
        return None


async def stream_local_file(file_path: str):
    """Stream a local audio file, transcoding to MP3 if needed via ffmpeg."""
    ext = Path(file_path).suffix.lower()
    if ext == ".mp3":
        # Stream MP3 directly without transcoding
        with open(file_path, "rb") as f:
            while True:
                chunk = f.read(8192)
                if not chunk:
                    break
                yield chunk
    else:
        # Transcode to MP3 via ffmpeg
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-i", file_path,
            "-f", "mp3", "-ab", "192k", "-vn",
            "-y", "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            while True:
                chunk = await proc.stdout.read(8192)
                if not chunk:
                    break
                yield chunk
        finally:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()


async def cache_navidrome_stream(song_id: str) -> str | None:
    """Download Navidrome stream to temp file and return path.
    Cached files enable Content-Length, Range requests, and correct duration."""
    import tempfile
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-nav-cache")
    os.makedirs(cache_dir, exist_ok=True)
    cache_path = os.path.join(cache_dir, f"{song_id}.mp3")
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path
    params = library._params(id=song_id, format="mp3", maxBitRate=192)
    url = f"{library.NAVIDROME_URL}/rest/stream"
    try:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            async with client.stream("GET", url, params=params) as resp:
                resp.raise_for_status()
                with open(cache_path + ".tmp", "wb") as f:
                    async for chunk in resp.aiter_bytes(8192):
                        f.write(chunk)
        os.rename(cache_path + ".tmp", cache_path)
        return cache_path
    except Exception:
        # Cleanup partial file
        for p in (cache_path + ".tmp", cache_path):
            if os.path.exists(p):
                os.unlink(p)
        return None


async def stream_navidrome(song_id: str):
    """Yield audio chunks from Navidrome Subsonic stream endpoint."""
    params = library._params(id=song_id, format="mp3", maxBitRate=192)
    url = f"{library.NAVIDROME_URL}/rest/stream"
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        async with client.stream("GET", url, params=params) as resp:
            resp.raise_for_status()
            async for chunk in resp.aiter_bytes(8192):
                yield chunk


async def stream_youtube(youtube_url: str):
    """Transcode YouTube audio to MP3 via ffmpeg and yield chunks."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-reconnect", "1", "-reconnect_streamed", "1",
        "-i", youtube_url,
        "-f", "mp3", "-ab", "128k", "-vn",
        "-y", "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        while True:
            chunk = await proc.stdout.read(8192)
            if not chunk:
                break
            yield chunk
    finally:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()


async def cache_youtube_stream(youtube_url: str, name: str, artist: str) -> str | None:
    """Download YouTube audio to temp file via ffmpeg. Returns file path."""
    import tempfile, hashlib
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-yt-cache")
    os.makedirs(cache_dir, exist_ok=True)
    key = hashlib.md5(f"{artist}:{name}".lower().encode()).hexdigest()[:12]
    cache_path = os.path.join(cache_dir, f"{key}.mp3")
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-reconnect", "1", "-reconnect_streamed", "1",
            "-i", youtube_url,
            "-f", "mp3", "-ab", "128k", "-vn",
            "-y", cache_path + ".tmp",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=120)
        if proc.returncode == 0 and os.path.exists(cache_path + ".tmp"):
            os.rename(cache_path + ".tmp", cache_path)
            return cache_path
    except Exception:
        pass
    for p in (cache_path + ".tmp", cache_path):
        if os.path.exists(p):
            try:
                os.unlink(p)
            except Exception:
                pass
    return None


def invalidate_cache(name: str, artist: str):
    """Remove a cached URL (e.g. on stream error for re-resolution)."""
    key = _cache_key(name, artist)
    _url_cache.pop(key, None)


# ── Queue Persistence ──

def _ensure_player_dir():
    PLAYER_DIR.mkdir(parents=True, exist_ok=True)


def _queue_path(username: str, device_id: str = "default") -> Path:
    """Get queue file path. Falls back to legacy path for migration."""
    if device_id and device_id != "default":
        return PLAYER_DIR / f"{username}_{device_id}.json"
    return PLAYER_DIR / f"{username}.json"


def load_queue(username: str, device_id: str = "default") -> dict:
    _ensure_player_dir()
    # Try device-specific file first
    path = _queue_path(username, device_id)
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    # Fallback to legacy file (migration)
    if device_id and device_id != "default":
        legacy = PLAYER_DIR / f"{username}.json"
        if legacy.exists():
            try:
                return json.loads(legacy.read_text())
            except (json.JSONDecodeError, OSError):
                pass
    return {"queue": [], "current_index": -1, "position_seconds": 0.0, "volume": 1.0}


def save_queue(username: str, data: dict, device_id: str = "default"):
    _ensure_player_dir()
    path = _queue_path(username, device_id)
    path.write_text(json.dumps(data, indent=2))


def clear_queue(username: str, device_id: str = "default"):
    path = _queue_path(username, device_id)
    if path.exists():
        path.unlink()
