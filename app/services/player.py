"""Audio streaming and queue persistence for the in-browser player."""
import asyncio
import glob
import json
import logging
import os
import re
import tempfile
import threading
import time
import unicodedata
from pathlib import Path

import httpx

from app.services import library, ytpick

logger = logging.getLogger("musicseeker.player")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
PLAYER_DIR = DATA_DIR / "player"
MUSIC_DIR = Path(os.environ.get("MUSIC_DIR", "/music"))

# In-memory cache for resolved YouTube stream URLs (4h TTL)
_url_cache: dict[str, tuple[dict, float]] = {}
_URL_TTL = 4 * 3600  # 4 hours
_URL_CACHE_MAX = 500  # bound memory — keys derive from user-supplied track/artist names

# ── Keeping YouTube willing to answer ────────────────────────────────────────
# Resolving one track that is not in the library costs a YouTube search plus up to five
# audio-URL extractions. Nothing used to remember a failure, so playing an album nobody
# owns ran that dance for every track, and the player's own retry and auto-advance ran
# it again. YouTube answers that volume with 429 and "Sign in to confirm you're not a
# bot", and from then on EVERY track that is not downloaded fails until the address
# cools down — measured on 2026-11-02, when a whole album resolved to 404 while the
# same queries worked again twenty minutes later.
#
# So: a track that just failed is not retried for a while, and an answer that says we
# are being rate-limited stops the YouTube arm outright until the cool-down passes.
# Both only ever skip the YouTube fallback — a local file or a Navidrome song is found
# before either is consulted, so a download landing mid-cool-down plays at once.
YT_FAIL_TTL = 300.0        # how long one track's failure is remembered
YT_FAIL_MAX = 500          # bound: keys come from user-supplied names
YT_COOLDOWN = 300.0        # how long we stay off YouTube after a rate-limit answer
_yt_failed: dict[str, float] = {}
_yt_blocked_until = 0.0

# What YouTube says when it has had enough of us.
_RATE_LIMITED = ("http error 429", "too many requests", "sign in to confirm")


def youtube_rate_limited() -> bool:
    return time.monotonic() < _yt_blocked_until


def note_youtube_rate_limit(detail: str = "") -> None:
    global _yt_blocked_until
    first = not youtube_rate_limited()
    _yt_blocked_until = time.monotonic() + YT_COOLDOWN
    if first:
        logger.warning("YouTube is rate-limiting us; pausing the fallback for %ds. %s",
                       int(YT_COOLDOWN), detail[:200])


def _note_ytdlp_stderr(what: str, err: str) -> None:
    """Surface what yt-dlp actually said. It used to go to /dev/null, so a dead
    YouTube fallback showed up only as a bare 404 with no reason anywhere."""
    if not err:
        return
    low = err.lower()
    if any(m in low for m in _RATE_LIMITED):
        note_youtube_rate_limit(err.strip().splitlines()[-1] if err.strip() else "")
    else:
        logger.info("yt-dlp %s: %s", what, err.strip().splitlines()[-1][:200] if err.strip() else "")


def _yt_recently_failed(key: str) -> bool:
    exp = _yt_failed.get(key)
    if exp is None:
        return False
    if exp <= time.monotonic():
        _yt_failed.pop(key, None)
        return False
    return True


def _note_yt_failure(key: str) -> None:
    now = time.monotonic()
    if len(_yt_failed) >= YT_FAIL_MAX:
        for k in [k for k, exp in _yt_failed.items() if exp <= now]:
            del _yt_failed[k]
        while _yt_failed and len(_yt_failed) >= YT_FAIL_MAX:
            _yt_failed.pop(next(iter(_yt_failed)))
    _yt_failed[key] = now + YT_FAIL_TTL

# On-disk temp cache size caps (bytes). Files are evicted oldest-first by mtime
# once a cache dir exceeds its cap, except files touched within EVICT_RECENCY_SEC.
NAV_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024   # ms-nav-cache (transcoded MP3 / FLAC)
YT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024    # ms-yt-cache (YouTube audio)
BPM_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024   # ms-bpm-cache (FLAC for BPM analysis)
LOCAL_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024  # ms-local-cache (transcoded local FLAC→MP3)
EVICT_RECENCY_SEC = 5 * 60  # never delete a file modified/accessed in the last 5 min


def touch_cache_file(path: str) -> None:
    """Record that a cache file was just chosen to be served.

    The eviction guard above trusts max(mtime, atime), but a `relatime` mount does not
    move atime on a read — so a file a deck is playing right now looked untouched and
    could be evicted, and the deck's next Range request then met a different
    representation (local) or a rebuild/404 (Navidrome/YouTube). Bump atime only and
    leave mtime as it is."""
    try:
        os.utime(path, (time.time(), os.stat(path).st_mtime))
    except OSError:
        pass


# Cache files a response is sending RIGHT NOW (path -> number of responses). A touch
# when a request starts protects a file for EVICT_RECENCY_SEC only, and a receiver
# playing a two-hour mix reads one GET for two hours: the file was unlinked under it,
# the open response survived, but the next seek (or resume after a pause) found no
# file and waited for a full re-download. Eviction now skips what is still being sent,
# and the end of a response counts as a touch, so a short pause keeps it too.
_serving: dict[str, int] = {}


def _serve_key(path: str) -> str:
    return os.path.normpath(os.path.abspath(path))


def serving_begin(path: str) -> None:
    k = _serve_key(path)
    _serving[k] = _serving.get(k, 0) + 1


def serving_end(path: str) -> None:
    k = _serve_key(path)
    n = _serving.get(k, 0) - 1
    if n > 0:
        _serving[k] = n
    else:
        _serving.pop(k, None)
    touch_cache_file(path)


def being_served(path: str) -> bool:
    return _serve_key(path) in _serving


def is_audio_response(resp) -> bool:
    """True when an upstream answer really carries audio. Subsonic reports errors as
    HTTP 200 with a JSON/XML body, which `raise_for_status()` lets through; writing
    that ~200-byte body into a cache would serve it as audio/mpeg until evicted."""
    ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    # video/* and application/ogg are how some servers label m4a/ogg audio; the thing
    # to keep out is a text body (json/xml/html), not an unusual container.
    return (ctype.startswith(("audio/", "video/"))
            or ctype in ("application/octet-stream", "application/ogg"))


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
            if being_served(fpath):
                continue  # a response is still sending it (a long mix on a receiver)
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


def nfc(text: str) -> str:
    """One spelling for one title.

    The same track reaches us in two different Unicode spellings depending on where
    its metadata came from: "Divoká" arrives both precomposed and as "Divoka" plus a
    combining acute — measured in one album's worth of requests on 2026-11-05, where
    both forms appear side by side. Those are different bytes, so without folding them
    together they are two cache keys, two YouTube lookups and two downloads of the same
    song, and a file on disk (every one of the 3700 in the library is precomposed) does
    not match the decomposed spelling at all.
    """
    return unicodedata.normalize("NFC", text or "")


def _cache_key(name: str, artist: str) -> str:
    return f"{nfc(artist).lower().strip()}:{nfc(name).lower().strip()}"


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
                    # A title like "Live [2024]" is a character class to rglob and
                    # would never match its own file; only the literal part is escaped.
                    pattern_title = glob.escape(title)
                    for ext in ("flac", "mp3", "opus", "m4a"):
                        for p in search_dir.rglob(f"{pattern_title}.{ext}"):
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
    # Fold the spelling once, here, so the cache key, the filename glob, the Navidrome
    # search and the YouTube query all agree on what this track is called.
    name, artist = nfc(name), nfc(artist)
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

    # Fall back to YouTube — unless asking again is known to be pointless right now.
    if youtube_rate_limited() or _yt_recently_failed(key):
        return None
    result = await _resolve_youtube(name, artist)
    if result:
        _cache_put(key, result)
        return result

    _note_yt_failure(key)
    return None


async def _resolve_navidrome(name: str, artist: str) -> dict | None:
    """Check if track exists in Navidrome and return stream info."""
    try:
        song = await library.find_song(name, artist)
        if not song or not song.get("id"):
            return None
        result = {"source": "navidrome", "song_id": song["id"]}
        raw_ext = nav_raw_ext(song)
        if raw_ext:
            result["raw_ext"] = raw_ext
        ext = nav_ext(song)
        if ext:
            result["ext"] = ext      # the original's own format — what a lossless stream sends
        return result
    except Exception:
        return None


# Bounds on YouTube resolution. The deadline covers the whole attempt — search
# plus every candidate extraction — because the caller is a browser waiting to
# start playback: a lookup that takes longer than this has already failed as far
# as the listener is concerned, whatever it eventually returns.
YT_SEARCH_TIMEOUT = 15      # the one flat search request
YT_EXTRACT_TIMEOUT = 20     # a single candidate's audio URL
YT_RESOLVE_DEADLINE = 45    # everything, end to end


async def _ytdlp_url(target: str, timeout: float) -> str | None:
    """Direct audio URL for one video (or search expression), or None.

    `-i` keeps yt-dlp going past entries it cannot extract. Skipping sets a
    non-zero exit status, so the exit code must NOT be the success test: what
    matters is whether a URL was printed.
    """
    proc = await asyncio.create_subprocess_exec(
        "yt-dlp", "-f", "bestaudio", "--print", "url", "-i",
        "--no-playlist", target,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return None
    for line in (stdout or b"").decode(errors="replace").splitlines():
        url = line.strip()
        if url.startswith("http"):
            return url
    return None


async def _resolve_youtube(name: str, artist: str) -> dict | None:
    """Get a direct audio URL from YouTube via yt-dlp.

    One cheap flat search lists the top few matches, `ytpick` puts the ones that
    look like live/karaoke/cover variants last, and we extract them in that order
    until one plays. Taking *only* YouTube's first hit used to make tracks both
    unplayable and undownloadable whenever that upload was blocked — e.g.
    "Christina Aguilera - Loyal Brave True", where results 1, 2 and 5 answer
    "This video is not available", 3 resolves, and 4 is a live recording.

    Everything is bounded by `YT_RESOLVE_DEADLINE`, so a track nothing can
    resolve fails in a knowable time instead of walking the whole result list.
    """
    query = f"{artist} {name}" if artist else name
    deadline = time.monotonic() + YT_RESOLVE_DEADLINE
    try:
        candidates = await ytpick.search(
            query, limit=5, timeout=min(YT_SEARCH_TIMEOUT, YT_RESOLVE_DEADLINE),
            on_stderr=lambda err: _note_ytdlp_stderr(f"search {query[:60]}", err),
        )
        for cand in ytpick.rank(candidates, query):
            left = deadline - time.monotonic()
            if left <= 1:
                break
            url = await _ytdlp_url(cand["url"], min(YT_EXTRACT_TIMEOUT, left))
            if url:
                return {"source": "youtube", "url": url}
        if not candidates:
            # The search itself failed (yt-dlp change, network hiccup). Fall back
            # to letting yt-dlp search and extract in one go — no title ranking,
            # but better than reporting the track unplayable.
            left = deadline - time.monotonic()
            if left > 1:
                url = await _ytdlp_url(f"ytsearch5:{query}", left)
                if url:
                    return {"source": "youtube", "url": url}
        return None
    except Exception:
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


# A Navidrome song that is already compact and plays in every browser is fetched AS IT
# IS (`format=raw`), not as a 320k MP3. The transcode made such a file bigger, and for a
# long one it never finished in time: a 2 h 24 min AAC set (172 MB as MP3) took minutes
# to transcode, the client gave up after 45 s and the track "would not play" — measured
# on production 2026-11-17. A raw copy of the same file arrives in a second or two.
# ALAC hides in .m4a too and no browser but Safari decodes it; its bitrate gives it away.
_NAV_RAW_EXT = {"mp3", "m4a", "aac"}


def nav_raw_ext(song: dict) -> str | None:
    """Suffix under which this Subsonic song can be served untouched, or None."""
    ext = str(song.get("suffix") or "").lower()
    if ext not in _NAV_RAW_EXT:
        return None
    try:
        if int(song.get("bitRate") or 0) > 400:      # lossless in a lossy-looking container
            return None
    except (TypeError, ValueError):
        return None
    return ext


def nav_ext(song: dict) -> str | None:
    """The song's own file suffix (lower case), or None. It ends up in a cache file
    name, so anything but a short alphanumeric suffix is ignored."""
    ext = str(song.get("suffix") or "").lower()
    return ext if re.fullmatch(r"[a-z0-9]{1,5}", ext) else None


# A lossless request (the DLNA cast) gets the song's ORIGINAL bytes. Only a FLAC may be
# stored and served as <id>.flac: an m4a/mp3/opus original used to land there and went
# out as audio/flac — in the HTTP answer and in the DIDL — which a renderer may refuse.
# These originals are fetched with format=raw into <id>.raw.<ext> (the same file the
# deck's raw path uses for mp3/m4a/aac: the same bytes) and served with their own type.
# Anything else (flac, unknown, no suffix) keeps the old <id>.flac.
_NAV_LOSSLESS_RAW_EXT = {"mp3", "m4a", "mp4", "aac", "opus", "ogg", "oga", "wav", "aif", "aiff"}

_EXT_MIME = {"flac": "audio/flac", "opus": "audio/ogg", "ogg": "audio/ogg", "oga": "audio/ogg",
             "m4a": "audio/mp4", "mp4": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav",
             "aif": "audio/aiff", "aiff": "audio/aiff"}


def mime_for_path(path: str) -> str:
    """Content-Type the stream endpoint answers for a file, by its extension."""
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return _EXT_MIME.get(ext, "audio/mpeg")


def nav_cache_target(song_id: str, lossless: bool = False, raw_ext: str | None = None,
                     ext: str | None = None) -> tuple[str, dict]:
    """(cache file, Subsonic stream params) for this song — ONE place, so the builder,
    the "is it finished" check and the router's progressive follower agree.

    Whichever representation is ALREADY on disk wins, raw first: the BPM analysis
    builds the MP3 for the same song id on its own schedule, and a stream URL must not
    change which bytes it serves because a second file happened to appear.

    `ext` is the song's own suffix (resolve_stream's `ext`); only a lossless request
    reads it. A lossless target depends on nothing on disk, so it never changes."""
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-nav-cache")
    if lossless:
        orig = ext or raw_ext
        if orig in _NAV_LOSSLESS_RAW_EXT:
            return (os.path.join(cache_dir, f"{song_id}.raw.{orig}"),
                    library._params(id=song_id, format="raw"))
        return os.path.join(cache_dir, f"{song_id}.flac"), library._params(id=song_id)
    mp3 = os.path.join(cache_dir, f"{song_id}.mp3")
    if raw_ext in _NAV_RAW_EXT:
        raw = os.path.join(cache_dir, f"{song_id}.raw.{raw_ext}")
        have_raw = os.path.exists(raw) and os.path.getsize(raw) > 0
        have_mp3 = os.path.exists(mp3) and os.path.getsize(mp3) > 0
        if have_raw or not have_mp3:
            return raw, library._params(id=song_id, format="raw")
    return mp3, library._params(id=song_id, format="mp3", maxBitRate=320)


def navidrome_cache_path(song_id: str, lossless: bool = False, raw_ext: str | None = None,
                         ext: str | None = None) -> str | None:
    """The finished Navidrome cache file for this song, or None. Never builds."""
    p, _ = nav_cache_target(song_id, lossless, raw_ext, ext)
    return p if os.path.exists(p) and os.path.getsize(p) > 0 else None


def navidrome_stream_mime(res: dict, lossless: bool = False) -> str:
    """The Content-Type GET /api/player/stream answers for this Navidrome resolution
    (a resolve_stream result with source "navidrome"). For the DIDL of a cast, so the
    renderer is told the type it will really get. Never builds or fetches anything."""
    path, _ = nav_cache_target(res["song_id"], lossless, res.get("raw_ext"), res.get("ext"))
    return mime_for_path(path)


def _fresh_tmp(tmp_path: str) -> None:
    """A build always starts on a NEW inode. A .tmp left by a killed process would
    otherwise be truncated and rewritten in place, and a follower already reading it
    (follow_build) would splice the old bytes onto the new file."""
    try:
        os.unlink(tmp_path)
    except OSError:
        pass


def cached_resolution(name: str, artist: str) -> dict | None:
    """What this track is ALREADY resolved to, or None. Never resolves — a caller that
    only wants to know about a finished file must not be able to start a lookup."""
    hit = _url_cache.get(_cache_key(nfc(name), nfc(artist)))
    return hit[0] if hit else None


def youtube_refusing(name: str, artist: str) -> bool:
    """YouTube is parked, or this very track just failed there."""
    return youtube_rate_limited() or _yt_recently_failed(_cache_key(nfc(name), nfc(artist)))


_duration_memo: dict[tuple, float] = {}


def audio_duration(path: str) -> float | None:
    """Length in seconds of a finished audio file, read from the file itself."""
    try:
        st = os.stat(path)
        key = (path, st.st_size, st.st_mtime_ns)
        if key in _duration_memo:
            return _duration_memo[key]
        import mutagen
        f = mutagen.File(path)
        dur = float(f.info.length) if f is not None and f.info and f.info.length else None
        if dur and dur > 0:
            if len(_duration_memo) > 2000:
                _duration_memo.clear()
            _duration_memo[key] = dur
            return dur
    except Exception:
        pass
    return None


async def follow_build(task: "asyncio.Task", cache_path: str):
    """Serve a cache file WHILE it is being built: the bytes written so far, then each
    new one as it lands, until the build task finishes.

    A track that is not on disk (Navidrome-only, YouTube) used to send nothing until
    its whole file had been fetched and transcoded — 5 to 30 s of silence with a deck
    that looked frozen, which the stall watchdog then skipped. The build writes to
    `<cache>.tmp` and renames it when done; a rename keeps the inode, so one open file
    descriptor follows the file across it.

    The build runs as its own task and outlives this response: a listener who skips
    away still leaves a finished cache file behind for the next play. If the build
    FAILS, this raises — the connection is cut rather than closed cleanly, so the
    client sees an error and not a track that just happens to be short."""
    tmp = cache_path + ".tmp"
    f = None
    serving_begin(cache_path)       # a deck can follow a long build for its whole length
    try:
        while f is None:
            for p in (tmp, cache_path):
                try:
                    f = open(p, "rb")
                    break
                except OSError:
                    continue
            if f is None:
                if task.done():
                    raise RuntimeError("stream build produced no file")
                await asyncio.sleep(0.1)
        while True:
            chunk = f.read(65536)
            if chunk:
                yield chunk
                continue
            if task.done():
                chunk = f.read(65536)   # whatever landed between the read and the check
                if chunk:
                    yield chunk
                    continue
                if task.cancelled() or task.exception() or not task.result():
                    raise RuntimeError("stream build failed")
                # The file we followed must BE the file that was finished. When the
                # build we latched onto failed and a second one (waiting on the same
                # lock) then succeeded, our descriptor is the first one's unlinked
                # .tmp: we would end cleanly, half-way through the song.
                try:
                    same = os.fstat(f.fileno()).st_ino == os.stat(task.result()).st_ino
                except OSError:
                    same = False
                if not same:
                    raise RuntimeError("followed a build that was replaced")
                return
            await asyncio.sleep(0.15)
    finally:
        if f is not None:
            f.close()
        serving_end(cache_path)


async def cache_navidrome_stream(song_id: str, lossless: bool = False, raw_ext: str | None = None,
                                 ext: str | None = None) -> str | None:
    """Download Navidrome stream to temp file and return path.
    Cached files enable Content-Length, Range requests, and correct duration."""
    import tempfile
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-nav-cache")
    os.makedirs(cache_dir, exist_ok=True)
    try:
        os.chmod(cache_dir, 0o700)  # keep cached audio private to the app user
    except OSError:
        pass
    cache_path, params = nav_cache_target(song_id, lossless, raw_ext, ext)
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
                        if not is_audio_response(resp):
                            logger.warning("Navidrome answered song %s with %r, not audio — not caching",
                                           song_id, resp.headers.get("content-type"))
                            return None
                        _fresh_tmp(cache_path + ".tmp")
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


def local_transcode_cache_path(path: str) -> str | None:
    """Where the transcoded MP3 for *path* lives (it may not exist). The ONE place the
    key is derived — sha1(abspath + mtime) — so the cache code and the tag-write
    carry-over below cannot drift apart. None when the source cannot be stat'ed."""
    import hashlib
    try:
        abspath = os.path.abspath(path)
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    key = hashlib.sha1(f"{abspath}{mtime}".encode()).hexdigest()
    return os.path.join(tempfile.gettempdir(), "ms-local-cache", f"{key}.mp3")


# Local files that are ALREADY compact and that every browser plays are served as they
# are. The 320k MP3 transcode exists to shrink a 28 MB FLAC into a 9 MB prefetch blob;
# applied to an .m4a it made the file BIGGER, and for an hour-long mix it could not
# even finish — every play and every prewarm burned its whole ffmpeg timeout and then
# served the raw file anyway.
_SERVE_RAW_EXT = {"mp3", "m4a", "aac", "mp4"}


_alac_memo: dict[tuple, bool] = {}


def _is_alac(path: str) -> bool:
    """An .m4a can hold ALAC (lossless) instead of AAC. Chrome and Firefox cannot decode
    it, and it is as bulky as FLAC — it wants the transcode like any lossless file."""
    try:
        st = os.stat(path)
        key = (path, st.st_size, st.st_mtime_ns)
        if key not in _alac_memo:
            from mutagen.mp4 import MP4
            if len(_alac_memo) > 2000:
                _alac_memo.clear()
            _alac_memo[key] = (MP4(path).info.codec or "").lower().startswith("alac")
        return _alac_memo[key]
    except Exception:
        return False


def wants_local_transcode(path: str) -> bool:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if ext not in _SERVE_RAW_EXT:
        return True
    return ext in ("m4a", "mp4") and _is_alac(path)


def local_transcode_timeout(path: str) -> float:
    """20 s was enough for a 4-minute FLAC on an idle box and for nothing longer: a
    killed encode leaves no cache, so the next play is cold again — forever. Scale
    with the input instead (≈0.75 s per MB, measured headroom ×2), capped."""
    try:
        mb = os.path.getsize(path) / 1e6
    except OSError:
        mb = 0
    return min(300.0, 20.0 + 0.75 * mb)


def carry_local_transcode(old_cache_path: str | None, path: str) -> None:
    """Re-key a cached transcode after *path* was rewritten in place (new mtime).

    A tag write does not change the audio, but the mtime in the key makes the old MP3
    unfindable: the next Range request on the SAME stream URL then got raw FLAC bytes
    while the browser was mid-way through decoding the MP3. Call with the path taken
    BEFORE the rewrite. Never raises."""
    try:
        if not old_cache_path or not os.path.exists(old_cache_path):
            return
        new_cache_path = local_transcode_cache_path(path)
        if new_cache_path and new_cache_path != old_cache_path:
            os.replace(old_cache_path, new_cache_path)
            touch_cache_file(new_cache_path)  # in use right now — not the next file to evict
    except Exception:
        pass


def local_transcode_cached_path(path: str) -> str | None:
    """Return the ms-local-cache path for *path* IFF it already exists and is
    non-empty. Never builds, never awaits — safe to call from HEAD or the GET
    fast path to decide whether to serve the cached MP3 or fall through to
    progressive streaming."""
    cache_path = local_transcode_cache_path(path)
    if cache_path and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path
    return None


async def cache_local_transcode(path: str) -> str | None:
    """Transcode a local non-MP3 file (e.g. FLAC) to a cached 320k MP3 and return
    its path. Mirrors cache_navidrome_stream: keyed by sha1(abspath + mtime) so a
    re-downloaded/re-tagged file re-transcodes, uses the per-target in-flight build
    lock + double-checked existence (so prefetch×3 + prewarm + the real GET collapse
    to a single ffmpeg run), writes atomically (.tmp then os.rename), and evicts the
    cache dir after the rename. Returns None on failure (caller falls back to raw)."""
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-local-cache")
    os.makedirs(cache_dir, exist_ok=True)
    try:
        os.chmod(cache_dir, 0o700)  # keep cached audio private to the app user
    except OSError:
        pass
    cache_path = local_transcode_cache_path(path)
    if cache_path is None:
        return None
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
                await asyncio.wait_for(proc.wait(), timeout=local_transcode_timeout(path))
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


def _yt_cache_path(name: str, artist: str, bitrate: str) -> str:
    """Where this track's downloaded YouTube audio lives. Depends only on the track,
    never on the video we resolved it to — which is what lets us find it again when
    resolution is not available."""
    import tempfile, hashlib
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-yt-cache")
    key = hashlib.md5(f"{nfc(artist)}:{nfc(name)}".lower().encode()).hexdigest()[:12]
    suffix = "hq" if bitrate != "192k" else ""
    return os.path.join(cache_dir, f"{key}{suffix}.mp3")


def youtube_cache_path(name: str, artist: str, bitrate: str = "192k") -> str | None:
    """A playable file for this track that we already downloaded, or None.

    Resolution fails for reasons that have nothing to do with the track — YouTube
    throttling us is the measured one. Having told the user a track is unavailable
    while its audio sits in our own cache is a worse answer than the slightly wrong
    bitrate, so the other bitrate counts as a hit too.
    """
    for rate in (bitrate, "320k" if bitrate == "192k" else "192k"):
        path = _yt_cache_path(name, artist, rate)
        try:
            if os.path.exists(path) and os.path.getsize(path) > 0:
                return path
        except OSError:
            continue
    return None


_FF_DURATION = re.compile(r"Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)")
_FF_TIME = re.compile(r"time=\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)")


def _hms(m) -> float:
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def ffmpeg_cut_short(stderr_text: str) -> tuple[float, float] | None:
    """(declared, encoded) seconds when ffmpeg encoded materially LESS than the input
    said it held, else None. ffmpeg treats a read error on a network input as end of
    file and exits 0, so a download YouTube dropped half-way looked like a success —
    and was cached as the whole track, with a header for the short length: the deck
    then faded out at the truncation point on every play until the file was evicted.
    Both numbers come from ffmpeg's own log: the input's `Duration:` and the last
    `time=` it reported. Unknown either way → None (no verdict, keep the file)."""
    d = _FF_DURATION.search(stderr_text or "")
    times = _FF_TIME.findall(stderr_text or "")
    if not d or not times:
        return None
    declared = _hms(d)
    h, m, s = times[-1]
    encoded = int(h) * 3600 + int(m) * 60 + float(s)
    if declared <= 0:
        return None
    if encoded < declared - 3 and encoded < declared * 0.98:
        return declared, encoded
    return None


async def cache_youtube_stream(youtube_url: str, name: str, artist: str, bitrate: str = "192k") -> str | None:
    """Download YouTube audio to temp file via ffmpeg. Returns file path."""
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-yt-cache")
    os.makedirs(cache_dir, exist_ok=True)
    try:
        os.chmod(cache_dir, 0o700)  # keep cached audio private to the app user
    except OSError:
        pass
    cache_path = _yt_cache_path(name, artist, bitrate)
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
            proc = None
            try:
                _fresh_tmp(cache_path + ".tmp")
                proc = await asyncio.create_subprocess_exec(
                    "ffmpeg", "-reconnect", "1", "-reconnect_streamed", "1",
                    "-i", youtube_url,
                    "-f", "mp3", "-ab", bitrate, "-vn",
                    "-y", cache_path + ".tmp",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                # communicate(), not wait(): the log is read as it is written, so a
                # chatty ffmpeg can never block on a full pipe.
                _, err_b = await asyncio.wait_for(proc.communicate(), timeout=120)
                err = (err_b or b"").decode("utf-8", "replace").replace("\r", "\n")
                cut = ffmpeg_cut_short(err) if proc.returncode == 0 else None
                if proc.returncode == 0 and not cut and os.path.exists(cache_path + ".tmp"):
                    os.rename(cache_path + ".tmp", cache_path)
                    evict_cache_dir(cache_dir, YT_CACHE_MAX_BYTES)
                    return cache_path
                if cut:
                    logger.warning("YouTube download of %r cut short: %.0fs of %.0fs — not caching",
                                   f"{artist} - {name}"[:80], cut[1], cut[0])
                # What ffmpeg said goes where yt-dlp's stderr goes: a 429/403 here is the
                # same refusal and has to park the YouTube arm the same way.
                tail = "\n".join(l for l in err.splitlines() if l.strip() and "time=" not in l)[-600:]
                _note_ytdlp_stderr(f"download {artist} - {name}"[:80], tail)
                # ffmpeg gave up on the URL (403, expired, refused): the resolution is
                # dead — forget it and leave the track alone for a while. Decided HERE
                # because only this function can tell a refusal from a TIMEOUT: a long
                # or throttled download is slow, not dead, and marking it failed would
                # 404 the track for the next five minutes.
                forget_dead_youtube(name, artist)
            except Exception:
                pass
            finally:
                # After a timeout the first ffmpeg would keep downloading into a file
                # we are about to unlink while the router starts a second one for the
                # live stream — double the YouTube traffic right when we are closest to
                # the rate limit. Kill it (the same finally cache_local_transcode has).
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


def invalidate_cache(name: str, artist: str):
    """Remove a cached URL (e.g. on stream error for re-resolution)."""
    key = _cache_key(nfc(name), nfc(artist))  # resolve_stream stores under the folded spelling
    _url_cache.pop(key, None)


def forget_dead_youtube(name: str, artist: str) -> None:
    """A resolved YouTube URL whose download failed: drop it, AND leave the track
    alone for YT_FAIL_TTL. Dropping it alone would send the very next request for
    this track straight back to YouTube (one search plus up to five extractions) —
    and a download that fails is most often YouTube refusing us already. Asking
    harder at that moment is how the address got parked twice in November 2026."""
    invalidate_cache(name, artist)
    _note_yt_failure(_cache_key(nfc(name), nfc(artist)))


# ── Queue Persistence ──

def _ensure_player_dir():
    PLAYER_DIR.mkdir(parents=True, exist_ok=True)


def _queue_path(username: str, device_id: str = "default") -> Path:
    """Get queue file path. Falls back to legacy path for migration."""
    if device_id and device_id != "default":
        return PLAYER_DIR / f"{username}_{device_id}.json"
    return PLAYER_DIR / f"{username}.json"


class QueueUnreadable(Exception):
    """The device's queue file exists but cannot be read (mid-write, damaged)."""


# One writer at a time for the queue files of this process: the client's PUT and the
# cast follower's pointer update (update_queue) must not interleave their writes.
_queue_lock = threading.Lock()


def load_queue(username: str, device_id: str = "default", strict: bool = False) -> dict:
    """The saved queue. `strict`: a device file that exists but cannot be read raises
    QueueUnreadable instead of falling back to the legacy (pre-device) file — that
    file may be another device's, and the cast follower must not advance by it."""
    _ensure_player_dir()
    # Try device-specific file first
    path = _queue_path(username, device_id)
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError) as e:
            if strict:
                raise QueueUnreadable(str(path)) from e
    # Fallback to legacy file (migration)
    if device_id and device_id != "default":
        legacy = PLAYER_DIR / f"{username}.json"
        if legacy.exists():
            try:
                return json.loads(legacy.read_text())
            except (json.JSONDecodeError, OSError):
                pass
    return {"queue": [], "current_index": -1, "position_seconds": 0.0, "volume": 1.0}


def _write_queue_file(path: Path, data: dict) -> None:
    """Atomic: a reader sees the old file or the new one, never half of one."""
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(data, indent=2))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def save_queue(username: str, data: dict, device_id: str = "default"):
    _ensure_player_dir()
    path = _queue_path(username, device_id)
    with _queue_lock:
        _write_queue_file(path, data)


def update_queue(username: str, device_id: str, mutate, strict: bool = True) -> bool:
    """Read the device's queue, let `mutate(data)` change it in place, write it back —
    all under the queue lock, so a client save cannot land between the read and the
    write and be lost. `mutate` returns False to leave the file alone. With `strict`
    an unreadable device file raises QueueUnreadable like load_queue(strict=True).

    Blocking (file I/O and a threading lock): call it from a worker thread."""
    _ensure_player_dir()
    with _queue_lock:
        data = load_queue(username, device_id, strict=strict)
        if mutate(data) is False:
            return False
        _write_queue_file(_queue_path(username, device_id), data)
        return True


def clear_queue(username: str, device_id: str = "default"):
    path = _queue_path(username, device_id)
    if path.exists():
        path.unlink()
