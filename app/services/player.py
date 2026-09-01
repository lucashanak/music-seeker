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
_URL_CACHE_MAX = 500  # bound memory — keys derive from user-supplied track/artist names

# On-disk temp cache size caps (bytes). Files are evicted oldest-first by mtime
# once a cache dir exceeds its cap, except files touched within EVICT_RECENCY_SEC.
NAV_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024   # ms-nav-cache (transcoded MP3 / FLAC)
YT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024    # ms-yt-cache (YouTube audio)
BPM_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024   # ms-bpm-cache (FLAC for BPM analysis)
LOCAL_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024  # ms-local-cache (transcoded local FLAC→MP3)
EVICT_RECENCY_SEC = 5 * 60  # never delete a file modified/accessed in the last 5 min


def evict_cache_dir(path: str, max_bytes: int) -> None:
    """Best-effort LRU-ish sweep of an on-disk temp cache directory.

    When the directory's total size exceeds ``max_bytes``, delete files
    oldest-first (by mtime) until back under the cap. Any file modified or
    accessed within ``EVICT_RECENCY_SEC`` is skipped so we never remove a file
    that may be mid-stream or freshly written. This function must never raise:
    it runs after a cache write on the stream hot path, so all errors are
    swallowed and it simply gives up on anything it can't handle.
    """
    try:
        now = time.time()
        entries = []
        total = 0
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                total += st.st_size
                # Use the most recent of mtime/atime as the "last touched" time.
                last_touch = max(st.st_mtime, st.st_atime)
                entries.append((last_touch, st.st_size, entry.path))
        if total <= max_bytes:
            return
        # Oldest first.
        entries.sort(key=lambda e: e[0])
        for last_touch, size, fpath in entries:
            if total <= max_bytes:
                break
            if now - last_touch < EVICT_RECENCY_SEC:
                continue  # too recently touched — may be mid-stream/just-written
            try:
                os.unlink(fpath)
                total -= size
            except OSError:
                # File vanished or is locked; ignore and keep sweeping.
                continue
    except Exception:
        # Sweep is opportunistic and must never break a stream response.
        pass


# Per-cache-target in-flight build locks. Pre-warm and the real stream GET can
# hit the same uncached song concurrently; without this both would transcode
# (double CPU). The lock serializes builds per key so the second caller reuses
# the first's result (double-checked existence inside the lock).
#
# Refcount design: _get_build_lock increments a per-key counter (synchronously,
# no await between ++ and store, so a plain int is safe in asyncio). The lock is
# only removed from the dict when the refcount reaches 0, preventing the race
# where locked() returns False between holder exit and waiter resume — which
# would cause a new caller to create a fresh lock and double-transcode.
_build_locks: dict[str, asyncio.Lock] = {}
_build_lock_refs: dict[str, int] = {}


def _get_build_lock(key: str) -> asyncio.Lock:
    lock = _build_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _build_locks[key] = lock
    _build_lock_refs[key] = _build_lock_refs.get(key, 0) + 1
    return lock


def _release_build_lock(key: str) -> None:
    """Decrement refcount; pop lock from the dict only when it reaches 0.
    This keeps the dict bounded while never orphaning a lock a waiter still
    holds — unlike a locked()-check which races between holder exit and waiter
    resume."""
    count = _build_lock_refs.get(key, 1) - 1
    if count <= 0:
        _build_locks.pop(key, None)
        _build_lock_refs.pop(key, None)
    else:
        _build_lock_refs[key] = count


def _cache_key(name: str, artist: str) -> str:
    return f"{artist.lower().strip()}:{name.lower().strip()}"


def _cache_put(key: str, result: dict) -> None:
    """Store a resolved source, evicting the oldest entry when the cache is full."""
    if key not in _url_cache and len(_url_cache) >= _URL_CACHE_MAX:
        oldest = min(_url_cache, key=lambda k: _url_cache[k][1])
        _url_cache.pop(oldest, None)
    _url_cache[key] = (result, time.time())


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
    # Pass 1: match artist dir if exists. Pass 2: search all dirs (fallback).
    for broad_search in (False, True):
        for user_dir in MUSIC_DIR.iterdir():
            if not user_dir.is_dir() or user_dir.name.startswith('.'):
                continue
            if not broad_search and safe_artist:
                artist_dir = user_dir / safe_artist
                if not artist_dir.is_dir():
                    continue
                search_dirs = [artist_dir]
            else:
                search_dirs = [user_dir]
            for search_dir in search_dirs:
                for title in title_variants:
                    for ext in ("flac", "mp3", "opus", "m4a"):
                        for p in search_dir.rglob(f"{title}.{ext}"):
                            # Containment guard: never return a path outside MUSIC_DIR.
                            try:
                                p.resolve().relative_to(MUSIC_DIR.resolve())
                            except ValueError:
                                continue
                            return {"source": "local", "path": str(p)}
        if not safe_artist:
            break  # no point doing broad search again without artist
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
    import asyncio
    # Check cache first
    key = _cache_key(name, artist)
    cached = _url_cache.get(key)
    if cached and time.time() - cached[1] < _URL_TTL:
        return cached[0]

    # Try local downloaded files first (run in thread pool — rglob blocks on NAS)
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _resolve_local_file, name, artist)
    if result:
        _cache_put(key, result)
        return result

    # Try Navidrome
    result = await _resolve_navidrome(name, artist)
    if result:
        _cache_put(key, result)
        return result

    # Fall back to YouTube
    result = await _resolve_youtube(name, artist)
    if result:
        _cache_put(key, result)
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


async def cache_navidrome_stream(song_id: str, lossless: bool = False) -> str | None:
    """Download Navidrome stream to temp file and return path.
    Cached files enable Content-Length, Range requests, and correct duration."""
    import tempfile
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-nav-cache")
    os.makedirs(cache_dir, exist_ok=True)
    try:
        os.chmod(cache_dir, 0o700)  # keep cached audio private to the app user
    except OSError:
        pass
    if lossless:
        cache_path = os.path.join(cache_dir, f"{song_id}.flac")
        params = library._params(id=song_id)  # No format/bitrate = original
    else:
        cache_path = os.path.join(cache_dir, f"{song_id}.mp3")
        params = library._params(id=song_id, format="mp3", maxBitRate=320)
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path
    # Serialize per-target so a concurrent pre-warm + stream GET don't both
    # transcode. Re-check existence inside the lock (double-checked locking):
    # the second caller reuses the first build's result.
    lock_key = f"nav:{cache_path}"
    lock = _get_build_lock(lock_key)
    try:
        async with lock:
            if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
                return cache_path
            url = f"{library.NAVIDROME_URL}/rest/stream"
            try:
                async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
                    async with client.stream("GET", url, params=params) as resp:
                        resp.raise_for_status()
                        with open(cache_path + ".tmp", "wb") as f:
                            async for chunk in resp.aiter_bytes(8192):
                                f.write(chunk)
                os.rename(cache_path + ".tmp", cache_path)
                evict_cache_dir(cache_dir, NAV_CACHE_MAX_BYTES)
                return cache_path
            except Exception:
                # Cleanup partial file
                for p in (cache_path + ".tmp", cache_path):
                    if os.path.exists(p):
                        os.unlink(p)
                return None
    finally:
        _release_build_lock(lock_key)


# ── Raw-representation pins (local files) ──
# One stream URL must keep answering with the SAME file for as long as a playback
# of it can still be in flight. The local path would otherwise flip mid-track: a
# cold GET answers with the raw FLAC (e.g. 27 MB) while the background transcode
# builds a 320k MP3 (9 MB) that the SAME URL starts serving ~3s later. When the
# browser then comes back with `Range: bytes=21797613-` to finish the track, that
# offset does not exist in the now-current MP3 → 416, and no more audio data ever
# arrives. The FLAC's STREAMINFO already told the decoder the full duration, so
# the timeline keeps running to the end over silence — the track audibly cuts out
# somewhere in its last stretch. `_prewarmFirst()` (upnext.js) prewarms the track
# it is about to play, so this raced every cold local play, not just rare ones.
#
# Fix: once raw has been served for a path, keep serving raw until the pin lapses.
# Every raw response refreshes the pin, so a play in progress can never have the
# file swapped underneath it. The cached MP3 takes over on the next play that
# starts more than RAW_PIN_SEC after the last raw byte was served.
_raw_pins: dict[str, float] = {}
RAW_PIN_SEC = 15 * 60  # comfortably longer than the longest single track


def pin_raw_local(path: str) -> None:
    """Mark *path* as currently being served raw (refreshes an existing pin)."""
    now = time.time()
    _raw_pins[path] = now + RAW_PIN_SEC
    if len(_raw_pins) > 64:  # opportunistic prune — keeps the dict bounded
        for p, expiry in list(_raw_pins.items()):
            if expiry <= now:
                _raw_pins.pop(p, None)


def raw_pinned(path: str) -> bool:
    """True while *path* must keep being served raw (see pin_raw_local)."""
    expiry = _raw_pins.get(path)
    if expiry is None:
        return False
    if expiry <= time.time():
        _raw_pins.pop(path, None)
        return False
    return True


def local_transcode_cached_path(path: str) -> str | None:
    """Return the ms-local-cache path for *path* IFF it already exists and is
    non-empty. Never builds, never awaits — safe to call from HEAD or the GET
    fast path to decide whether to serve the cached MP3 or fall through to
    progressive streaming."""
    import tempfile, hashlib
    try:
        abspath = os.path.abspath(path)
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    key = hashlib.sha1(f"{abspath}{mtime}".encode()).hexdigest()
    cache_path = os.path.join(tempfile.gettempdir(), "ms-local-cache", f"{key}.mp3")
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path
    return None


async def cache_local_transcode(path: str) -> str | None:
    """Transcode a local non-MP3 file (e.g. FLAC) to a cached 320k MP3 and return
    its path. Mirrors cache_navidrome_stream: keyed by sha1(abspath + mtime) so a
    re-downloaded/re-tagged file re-transcodes, uses the per-target in-flight build
    lock + double-checked existence (so prefetch×3 + prewarm + the real GET collapse
    to a single ffmpeg run), writes atomically (.tmp then os.rename), and evicts the
    cache dir after the rename. Returns None on failure (caller falls back to raw)."""
    import tempfile, hashlib
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-local-cache")
    os.makedirs(cache_dir, exist_ok=True)
    try:
        os.chmod(cache_dir, 0o700)  # keep cached audio private to the app user
    except OSError:
        pass
    try:
        abspath = os.path.abspath(path)
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    key = hashlib.sha1(f"{abspath}{mtime}".encode()).hexdigest()
    cache_path = os.path.join(cache_dir, f"{key}.mp3")
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path
    # Serialize per-target so concurrent prefetch/prewarm/stream GET don't all
    # transcode. Re-check existence inside the lock (double-checked locking):
    # later callers reuse the first build's result.
    lock_key = f"local:{cache_path}"
    lock = _get_build_lock(lock_key)
    try:
        async with lock:
            if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
                return cache_path
            proc = None
            try:
                # Transcode the WHOLE file (not a stream fragment) so the output
                # MP3 has a valid header → correct duration on the client deck.
                proc = await asyncio.create_subprocess_exec(
                    "ffmpeg", "-i", path,
                    "-f", "mp3", "-ab", "320k", "-vn",
                    "-y", cache_path + ".tmp",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(proc.wait(), timeout=20)
                if proc.returncode == 0 and os.path.exists(cache_path + ".tmp"):
                    os.rename(cache_path + ".tmp", cache_path)
                    evict_cache_dir(cache_dir, LOCAL_CACHE_MAX_BYTES)
                    return cache_path
            except Exception:
                pass
            finally:
                # Kill the child if it is still running (timeout or other error).
                if proc is not None and proc.returncode is None:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    try:
                        await proc.wait()
                    except Exception:
                        pass
            for p in (cache_path + ".tmp", cache_path):
                if os.path.exists(p):
                    try:
                        os.unlink(p)
                    except Exception:
                        pass
            return None
    finally:
        _release_build_lock(lock_key)


async def stream_navidrome(song_id: str, lossless: bool = False):
    """Yield audio chunks from Navidrome Subsonic stream endpoint."""
    if lossless:
        params = library._params(id=song_id)  # No format/bitrate = original
    else:
        params = library._params(id=song_id, format="mp3", maxBitRate=320)
    url = f"{library.NAVIDROME_URL}/rest/stream"
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        async with client.stream("GET", url, params=params) as resp:
            resp.raise_for_status()
            async for chunk in resp.aiter_bytes(8192):
                yield chunk


async def stream_youtube(youtube_url: str, bitrate: str = "192k"):
    """Transcode YouTube audio to MP3 via ffmpeg and yield chunks."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-reconnect", "1", "-reconnect_streamed", "1",
        "-i", youtube_url,
        "-f", "mp3", "-ab", bitrate, "-vn",
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


async def cache_youtube_stream(youtube_url: str, name: str, artist: str, bitrate: str = "192k") -> str | None:
    """Download YouTube audio to temp file via ffmpeg. Returns file path."""
    import tempfile, hashlib
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-yt-cache")
    os.makedirs(cache_dir, exist_ok=True)
    try:
        os.chmod(cache_dir, 0o700)  # keep cached audio private to the app user
    except OSError:
        pass
    key = hashlib.md5(f"{artist}:{name}".lower().encode()).hexdigest()[:12]
    suffix = "hq" if bitrate != "192k" else ""
    cache_path = os.path.join(cache_dir, f"{key}{suffix}.mp3")
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path
    # Serialize per-target so a concurrent pre-warm + stream GET don't both
    # download/transcode. Re-check existence inside the lock (double-checked
    # locking): the second caller reuses the first build's result.
    lock_key = f"yt:{cache_path}"
    lock = _get_build_lock(lock_key)
    try:
        async with lock:
            if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
                return cache_path
            try:
                proc = await asyncio.create_subprocess_exec(
                    "ffmpeg", "-reconnect", "1", "-reconnect_streamed", "1",
                    "-i", youtube_url,
                    "-f", "mp3", "-ab", bitrate, "-vn",
                    "-y", cache_path + ".tmp",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(proc.wait(), timeout=120)
                if proc.returncode == 0 and os.path.exists(cache_path + ".tmp"):
                    os.rename(cache_path + ".tmp", cache_path)
                    evict_cache_dir(cache_dir, YT_CACHE_MAX_BYTES)
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
    finally:
        _release_build_lock(lock_key)


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
