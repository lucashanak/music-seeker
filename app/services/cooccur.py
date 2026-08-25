"""Playlist co-occurrence: recall from how other people group tracks together.

Measured motivation. The existing recall arms (Last.fm similar tracks/tags,
Deezer artist radio, Navidrome getSimilarSongs2) produce a combined candidate
pool of ~80 tracks per request, of which ~3% are members of the curated playlist
the seeds came from. No re-ranking can fix that — the right answers are mostly
not in the pool. Mining public playlists for the same scene produced a pool of
~3300 tracks with 13-17% recall on the same ground truth, from just 27 playlists.

Why it works where genre similarity fails: this library's zouk playlists are
full of French pop, Romanian dance and mainstream R&B — tracks selected because
they work for zouk DANCING, not because they share a genre. Last.fm has no track
tags for them and their artist tags say "pop", so no content-similarity signal
can connect them. But the people who build public zouk playlists put the same
tracks together, and that co-occurrence is exactly the missing signal.

The queries must be anchored by the USER, not inferred: three local LLMs given a
playlist named "MyZouk" plus 20 of its tracks all produced generic mood queries
("chill indie pop", "french pop hits") that recalled 0.7-2.9%, versus 12.9% for
explicit zouk queries. The scene is not recoverable from the track metadata. So
`derive_queries` takes the anchors it is given and expands them through a known
scene map instead of guessing.
"""

import asyncio
import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path

from app.services import search_providers
from app.services import settings as app_settings
from app.services import tagvec

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
CACHE_FILE = DATA_DIR / "cooccur.json"

# Public playlists change slowly and Deezer rate-limits hard, so mined results
# are cached for a week rather than per-request.
QUERY_TTL = 7 * 24 * 3600
PLAYLIST_TTL = 14 * 24 * 3600

# Deezer's public API allows roughly 50 requests / 5s per IP and answers with
# "Quota limit exceeded" past that — hit during development, so concurrency is
# deliberately low and quota errors are retried rather than surfaced.
_sem = asyncio.Semaphore(3)
_QUOTA_RETRIES = 3
_QUOTA_BACKOFF = 3.0

# Playlist size filter. Under ~5 tracks there is no co-occurrence signal; over
# ~500 the playlist is a genre dump whose members co-occur with everything.
MIN_PLAYLIST_TRACKS = 5
MAX_PLAYLIST_TRACKS = 500

DEFAULT_PER_QUERY = 6
DEFAULT_MAX_PLAYLISTS = 30

# Words that appear in playlist names without naming a scene. Without this,
# "MyZouk (copy)" would emit `copy` as a mining query.
_NAME_STOP = {
    "my", "mine", "the", "and", "for", "playlist", "playlists", "list", "mix",
    "mixes", "copy", "new", "old", "best", "top", "fav", "favs", "favorites",
    "favourites", "music", "songs", "song", "tracks", "set", "sets", "vol",
    "part", "misc", "random", "stuff", "temp", "test", "radio", "queue",
}
_MIN_ANCHOR_LEN = 3


def _load_cache() -> dict:
    try:
        if CACHE_FILE.exists():
            data = json.loads(CACHE_FILE.read_text())
            if isinstance(data, dict):
                return data
    except Exception as e:
        logger.warning("cooccur: cache load failed, starting empty (%s)", e)
    return {}


_cache: dict = _load_cache()
_dirty = 0


def _flush() -> None:
    """Atomic write, same reasoning as tagvec/users.json: this file represents
    hours of rate-limited mining, so a torn write must not destroy it."""
    global _dirty
    if not _dirty:
        return
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(_cache, separators=(",", ":"))
        fd, tmp = tempfile.mkstemp(dir=str(DATA_DIR), prefix=".cooccur.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, CACHE_FILE)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        _dirty = 0
    except Exception as e:
        logger.warning("cooccur: cache flush failed (%s)", e)


def _fresh(entry: dict | None, ttl: float) -> bool:
    return bool(entry) and (time.time() - (entry.get("ts") or 0)) < ttl


async def _deezer(fn, *args):
    """Call Deezer with the shared semaphore and quota-aware retries."""
    for attempt in range(_QUOTA_RETRIES):
        try:
            async with _sem:
                return await fn(*args)
        except Exception as e:
            if "Quota" in str(e) and attempt < _QUOTA_RETRIES - 1:
                await asyncio.sleep(_QUOTA_BACKOFF)
                continue
            raise


def derive_queries(anchors: list[str], limit: int = 8) -> list[str]:
    """Turn user-supplied scene anchors into playlist-search queries.

    Anchors are things the user has already said: a playlist name, the
    `discovery_genres` setting, a seed track's tags. Each is tokenized (so
    "MyZouk" and "Calm Brazilian Zouk" both yield `zouk`) and then expanded
    through tagvec's scene map, which is where "zouk" becomes the concrete
    "brazilian zouk / soulzouk / kizomba / tarraxinha" family that measured
    13-17% recall. Deduplicated, order preserved for deterministic mining.
    """
    seen: set[str] = set()
    out: list[str] = []

    def add(q: str) -> None:
        q = q.strip().lower()
        if len(q) >= _MIN_ANCHOR_LEN and q not in seen:
            seen.add(q)
            out.append(q)

    tokens: list[str] = []
    for anchor in anchors:
        raw = (anchor or "").strip().lower()
        if not raw:
            continue
        add(raw)
        # Split on non-word chars AND camelCase ("MyZouk" -> my, zouk).
        for part in re.split(r"[^\w]+", re.sub(r"(?<=[a-z])(?=[A-Z])", " ", anchor or "")):
            part = part.strip().lower()
            if len(part) >= _MIN_ANCHOR_LEN and part not in _NAME_STOP and not part.isdigit():
                tokens.append(part)
                add(part)

    # Scene expansion: any anchor or token that is a known member of a scene
    # pulls in that scene's whole vocabulary.
    for term in list(seen):
        for concept in tagvec._TAG_CONCEPTS.get(term, ()):
            for member in tagvec._CONCEPTS.get(concept, ()):
                add(member)

    return out[:limit]


async def _search_playlists(query: str, per_query: int) -> list[dict]:
    key = f"q:{query}:{per_query}"
    entry = _cache.get(key)
    if _fresh(entry, QUERY_TTL):
        return entry["playlists"]
    global _dirty
    try:
        res = await _deezer(search_providers.deezer_search, query, "playlist", per_query)
    except Exception as e:
        logger.info("cooccur: playlist search failed for %r (%s)", query, e)
        return []
    playlists = [
        {"id": r["id"], "name": r.get("name") or "", "n": r.get("total_tracks") or 0}
        for r in res
        if r.get("id")
        and MIN_PLAYLIST_TRACKS <= (r.get("total_tracks") or 0) <= MAX_PLAYLIST_TRACKS
    ]
    _cache[key] = {"ts": time.time(), "playlists": playlists}
    _dirty += 1
    return playlists


async def _playlist_tracks(pid: str) -> list[dict]:
    key = f"p:{pid}"
    entry = _cache.get(key)
    if _fresh(entry, PLAYLIST_TTL):
        return entry["tracks"]
    global _dirty
    try:
        data = await _deezer(search_providers.deezer_get_playlist_tracks, pid)
    except Exception as e:
        logger.info("cooccur: playlist %s fetch failed (%s)", pid, e)
        return []
    # Only the fields scoring and playback need — the cache holds thousands of
    # these and Deezer's payload carries much more.
    tracks = [
        {"name": t.get("name") or "", "artist": t.get("artist") or "",
         "album": t.get("album") or "", "image": t.get("image") or "",
         "type": "track"}
        for t in (data.get("tracks") or [])
        if t.get("name")
    ]
    _cache[key] = {"ts": time.time(), "tracks": tracks}
    _dirty += 1
    return tracks


def _cached_query(query: str, per_query: int) -> list[dict] | None:
    entry = _cache.get(f"q:{query}:{per_query}")
    return entry["playlists"] if _fresh(entry, QUERY_TTL) else None


def _cached_tracks(pid: str) -> list[dict] | None:
    entry = _cache.get(f"p:{pid}")
    return entry["tracks"] if _fresh(entry, PLAYLIST_TTL) else None


def is_warm(anchors: list[str], per_query: int = DEFAULT_PER_QUERY) -> bool:
    """True when every query for these anchors is already cached."""
    queries = derive_queries(anchors)
    return bool(queries) and all(_cached_query(q, per_query) is not None for q in queries)


# Strong references to in-flight warm tasks — asyncio only holds weak ones.
_warm_tasks: set = set()


def warm_in_background(anchors: list[str], per_query: int = DEFAULT_PER_QUERY,
                       max_playlists: int = DEFAULT_MAX_PLAYLISTS) -> None:
    """Mine for these anchors off the request path.

    Mining a cold anchor costs up to ~9s of extra request time (measured: 26.3s
    worst case against 17.5s without the arm), and it only has to happen once
    per anchor per week. Recommendations are re-requested constantly — endless
    radio tops up every few tracks — so warming in the background gives the
    benefit within a minute of first use while costing the first request nothing.
    Capped at one in-flight task so a burst can't queue thousands of calls.
    """
    if not anchors or _warm_tasks or is_warm(anchors, per_query):
        return
    task = asyncio.create_task(mine(anchors, per_query, max_playlists))
    _warm_tasks.add(task)
    task.add_done_callback(_warm_tasks.discard)


async def mine(anchors: list[str], per_query: int = DEFAULT_PER_QUERY,
               max_playlists: int = DEFAULT_MAX_PLAYLISTS,
               limit: int = 400, allow_network: bool = True) -> list[dict]:
    """Mine public playlists for the anchored scene.

    Returns track dicts carrying `co_count` — the number of mined playlists the
    track appeared in, which is the co-occurrence strength the caller scores on.
    Ordered by co_count so a caller that truncates keeps the strongest evidence.
    Returns [] rather than raising when Deezer is unavailable.

    With allow_network=False, answers from cache only — used on the request path
    so a cold anchor costs nothing and returns partial (or no) results rather
    than blocking. `warm_in_background` fills the cache for the next request.
    """
    queries = derive_queries(anchors)
    if not queries:
        return []

    playlists: dict[str, dict] = {}
    for q in queries:
        found = (_cached_query(q, per_query) if not allow_network
                 else await _search_playlists(q, per_query))
        for pl in (found or []):
            playlists.setdefault(pl["id"], pl)

    counts: dict[tuple[str, str], int] = {}
    tracks: dict[tuple[str, str], dict] = {}
    mined = 0
    for pid in list(playlists)[:max_playlists]:
        got = (_cached_tracks(pid) if not allow_network
               else await _playlist_tracks(pid))
        if not got:
            continue
        mined += 1
        # Count each track once per playlist even if the playlist lists it twice.
        for key in {(t["name"].strip().lower(), (t["artist"] or "").strip().lower())
                    for t in got}:
            counts[key] = counts.get(key, 0) + 1
        for t in got:
            key = (t["name"].strip().lower(), (t["artist"] or "").strip().lower())
            tracks.setdefault(key, t)

    _flush()
    logger.info("cooccur: %d queries -> %d playlists (%d mined) -> %d tracks",
                len(queries), len(playlists), mined, len(counts))

    ranked = sorted(counts.items(), key=lambda kv: -kv[1])[:limit]
    return [{**tracks[k], "co_count": c} for k, c in ranked]


def stats() -> dict:
    queries = sum(1 for k in _cache if k.startswith("q:"))
    pls = sum(1 for k in _cache if k.startswith("p:"))
    cached_tracks = sum(len(v.get("tracks") or [])
                        for k, v in _cache.items() if k.startswith("p:"))
    return {"queries": queries, "playlists": pls, "tracks_cached": cached_tracks}


def configured_genres() -> list[str]:
    """Scene anchors from settings — the user's own statement of what they listen
    to, which is the one signal that measured better than inference."""
    raw = app_settings._settings.get("discovery_genres") or ""
    return [g.strip() for g in re.split(r"[,;]", raw) if g.strip()]
