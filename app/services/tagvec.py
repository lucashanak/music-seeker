"""Track-level tag vectors: the similarity substrate for recommendations.

The original scoring in radio.py compared a candidate against the playlist
profile using ARTIST-level Last.fm tags and an integer set-overlap count. That
loses two things that matter:

  * An artist's tag set is identical for their slow ballad and their club remix,
    so a profile built from "calm zouk" scores that artist's uptempo tracks just
    as highly. Track-level tags separate them.
  * An integer overlap treats every shared tag as equally informative, so
    sharing "pop" counts the same as sharing "tarraxinha". IDF weighting makes
    the rare, defining tags dominate the generic ones.

The persistent cache is the other half of the point. Last.fm charges one HTTP
call per track for track tags, so without persistence the reco path re-pays
~150 calls (~7.5s) on every single request. Cached to /app/data/tag_vectors.json
it is paid once per track, ever.

Keys come from the caller as radio.py's `_norm_key` tuple — this module never
normalizes names itself, so the two can't drift apart. Raw name/artist are
passed alongside for the API query, which needs the unnormalized strings.
"""

import asyncio
import json
import logging
import math
import os
import re
import tempfile
import time
from pathlib import Path

from app.services import lastfm

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
CACHE_FILE = DATA_DIR / "tag_vectors.json"

# Tags that describe the listener's relationship to the music rather than the
# music itself. They are among the most common tags on Last.fm, so leaving them
# in would let IDF-irrelevant noise dominate the sparse vectors.
NOISE_TAGS = {
    "seen live", "favorites", "favourites", "favorite", "favourite",
    "favorite songs", "favourite songs", "my favorites", "my favourites",
    "loved", "love", "best", "awesome", "beautiful", "cool", "good",
    "amazing", "great", "spotify", "albums i own", "vinyl", "radio",
    "under 2000 listeners", "check out", "todo", "playlist",
}

# A track with no track-level tags falls back to its artist's tags. That is a
# real signal but a weaker one (it cannot distinguish tracks by the same
# artist), so it is discounted rather than trusted equally. Coverage of the
# two sources is reported by `stats()` so the fallback rate stays visible.
ARTIST_SRC_DISCOUNT = 0.6

# Last.fm `count` is 0-100 relative popularity within the track. The floor keeps
# a listed-but-unpopular tag from collapsing to zero weight, since being listed
# at all is informative. Rank decay is deliberately mild — `count` already
# encodes rank, and a steep decay (1/(1+rank)) leaves the vector so dominated by
# tag #1 that cosine degenerates into "do these two share their top tag".
_COUNT_FLOOR = 0.15
_RANK_DECAY = 0.25

_TAGS_PER_TRACK = 10

# ── Vocabulary fragmentation ────────────────────────────────────────
# Last.fm tags are free text, so one genre arrives as many unrelated strings:
# "brazilian zouk", "zouk", "cabo love", "zouk love", "kizomba", "tarraxinha".
# Under exact-match cosine those are orthogonal dimensions, which made two
# obviously-similar zouk tracks score BELOW a random pop track that happened to
# share the literal tag "pop". Two mechanisms fix that:
#
#   1. Token expansion (generic, needs no config): every multi-word tag also
#      contributes its individual words as lower-weighted dimensions, so
#      "brazilian zouk" and "zouk love" meet on `zouk`.
#   2. A concept map for families that share no word at all — "kizomba" and
#      "tarraxinha" are zouk-family but spell nothing alike.
TOKEN_WEIGHT = 0.45
CONCEPT_WEIGHT = 0.8
_MIN_TOKEN_LEN = 3

# Words that carry no genre information on their own. Without this, "zouk love"
# and "love songs" would meet on `love`, and every "* music" tag on `music`.
_TOKEN_STOP = {
    "the", "and", "with", "for", "from", "you", "your", "his", "her", "its",
    "music", "musica", "song", "songs", "track", "tracks", "album", "albums",
    "love", "loved", "best", "good", "great", "cool", "nice", "top", "new",
    "old", "all", "very", "more", "most", "not", "own", "out", "one", "two",
    "style", "styles", "sound", "sounds", "stuff", "things", "kind", "type",
    "male", "female", "vocalists", "vocalist", "vocal", "singer", "band",
    "artist", "artists", "genre", "genres", "era", "years", "year", "time",
    "made", "like", "listen", "listened", "heard", "hear", "want", "need",
}

# Canonical concept -> member tags. Tags matching a member (exact, or as a word
# inside a longer tag) also load the `concept:*` dimension, so family members
# that share no spelling still meet. Seeded from this library's dominant genre
# cluster; extend as other clusters show up in stats()["top_tags"].
_CONCEPTS: dict[str, tuple[str, ...]] = {
    "zouk_family": (
        "zouk", "brazilian zouk", "soulzouk", "neozouk", "zoukable",
        "cabo love", "cabo zouk", "zouk love", "ghetto zouk", "kizomba",
        "tarraxinha", "tarraxo", "semba", "coladeira",
    ),
    "calm": (
        "chillout", "chill", "downtempo", "mellow", "acoustic", "ballad",
        "slow", "slow jam", "lyrical", "relaxing", "smooth", "soft",
        "sensual", "romantic", "quiet", "laid back", "ambient",
    ),
    "energetic": (
        "dance", "edm", "club", "electro", "house", "techno", "party",
        "uptempo", "hard", "banger", "peak time", "driving", "energetic",
    ),
    "soul_family": (
        "soul", "neo soul", "rnb", "r&b", "rhythm and blues", "funk",
        "motown", "gospel", "blues",
    ),
}

# tag -> tuple of concepts, built once from _CONCEPTS.
_TAG_CONCEPTS: dict[str, tuple[str, ...]] = {}
for _concept, _members in _CONCEPTS.items():
    for _m in _members:
        _TAG_CONCEPTS[_m] = _TAG_CONCEPTS.get(_m, ()) + (_concept,)

# Concurrency against Last.fm, mirroring radio.py's `_lastfm_sem`.
_sem = asyncio.Semaphore(5)

# key -> {"t": [[tag, count], ...], "src": "track"|"artist"|"none", "ts": float}
_cache: dict[str, dict] = {}
_loaded = False
_dirty = 0

# IDF is derived from the whole cache, so it is recomputed lazily rather than on
# every insert: `_idf_at` records the cache size it was last built for.
_idf: dict[str, float] = {}
_idf_at = -1

# Per-key in-flight locks so two concurrent requests wanting the same uncached
# track make one Last.fm call, not two.
_locks: dict[str, asyncio.Lock] = {}


def cache_key(norm_key: tuple[str, str]) -> str:
    """Flatten radio.py's (norm_name, norm_artist) tuple into a JSON-safe key."""
    return f"{norm_key[0]}\x1f{norm_key[1]}"


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load() -> None:
    global _cache, _loaded
    if _loaded:
        return
    _loaded = True
    try:
        if CACHE_FILE.exists():
            data = json.loads(CACHE_FILE.read_text())
            if isinstance(data, dict):
                _cache = data
    except Exception as e:
        # A corrupt cache must not take reco down: it is derived data and
        # refills itself from Last.fm.
        logger.warning("tagvec: cache load failed, starting empty (%s)", e)
        _cache = {}


def flush() -> None:
    """Persist the cache atomically.

    Written the same way as users.json rather than with write_text(): this file
    grows to one entry per track the app has ever seen, and a torn write would
    throw all of it away and re-trigger thousands of Last.fm calls.
    """
    global _dirty
    if not _dirty:
        return
    _load()
    try:
        _ensure_data_dir()
        payload = json.dumps(_cache, separators=(",", ":"))
        fd, tmp = tempfile.mkstemp(dir=str(DATA_DIR), prefix=".tag_vectors.", suffix=".tmp")
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
        logger.warning("tagvec: cache flush failed (%s)", e)


def _clean_tags(raw: list[dict]) -> list[list]:
    out: list[list] = []
    for t in raw:
        name = (t.get("name") or "").lower().strip()
        if not name or name in NOISE_TAGS:
            continue
        out.append([name, int(t.get("count") or 0)])
        if len(out) >= _TAGS_PER_TRACK:
            break
    return out


async def _fetch_one(key: str, name: str, artist: str) -> None:
    """Fill one cache entry: track tags, falling back to artist tags."""
    global _dirty
    lock = _locks.setdefault(key, asyncio.Lock())
    try:
        async with lock:
            if key in _cache:
                return
            tags: list[list] = []
            src = "none"
            try:
                # Ask for more tags than we keep so dropping NOISE_TAGS thins the
                # vector instead of starving it.
                async with _sem:
                    tags = _clean_tags(await lastfm.get_track_top_tags(
                        name, artist, limit=_TAGS_PER_TRACK + 5))
                if tags:
                    src = "track"
                elif artist:
                    async with _sem:
                        tags = _clean_tags(await lastfm.get_artist_top_tags(
                            artist, limit=_TAGS_PER_TRACK + 5))
                    if tags:
                        src = "artist"
            except Exception as e:
                logger.debug("tagvec: fetch failed for %s - %s (%s)", artist, name, e)
                return
            # A "none" result is cached too: an untagged track is a fact about
            # Last.fm's data, and re-asking on every request is the exact cost
            # this cache exists to avoid.
            _cache[key] = {"t": tags, "src": src, "ts": time.time()}
            _dirty += 1
    finally:
        # Unconditional, including the early-return paths: leaking one lock per
        # miss is how _profile_locks in radio.py grew unboundedly. Another
        # coroutine already awaiting this lock holds its own reference and
        # re-checks the cache, so dropping it here is safe.
        _locks.pop(key, None)


async def prefetch(items: list[tuple[tuple[str, str], str, str]]) -> dict:
    """Ensure every (norm_key, raw_name, raw_artist) has a cache entry.

    Returns coverage stats for the requested set. No-ops without a Last.fm key,
    in which case `vector()` returns empty vectors and every score term that
    depends on them contributes zero — reco degrades to its other signals
    rather than failing.
    """
    _load()
    if not lastfm.LASTFM_API_KEY:
        return {"requested": len(items), "fetched": 0, "cached": 0, "no_key": True}

    todo = []
    seen: set[str] = set()
    for nk, name, artist in items:
        key = cache_key(nk)
        if key in seen:
            continue
        seen.add(key)
        if key not in _cache and (name or artist):
            todo.append((key, name, artist))

    if todo:
        await asyncio.gather(*[_fetch_one(k, n, a) for k, n, a in todo],
                             return_exceptions=True)
        flush()

    return {
        "requested": len(seen),
        "fetched": len(todo),
        "cached": len(seen) - len(todo),
        "track_src": sum(1 for k in seen if _cache.get(k, {}).get("src") == "track"),
        "artist_src": sum(1 for k in seen if _cache.get(k, {}).get("src") == "artist"),
        "untagged": sum(1 for k in seen if _cache.get(k, {}).get("src") in (None, "none")),
    }


def _expand(tag: str) -> list[tuple[str, float]]:
    """The dimensions one tag loads: itself, its words, and its concepts.

    Returned weights are multipliers on the tag's own weight, so a word or
    concept dimension always counts for less than the literal tag.
    """
    dims: list[tuple[str, float]] = [(tag, 1.0)]
    words = [w for w in re.split(r"[^\w]+", tag)
             if len(w) >= _MIN_TOKEN_LEN and w not in _TOKEN_STOP]
    for w in words:
        if w != tag:  # a single-word tag is already its own dimension
            dims.append((w, TOKEN_WEIGHT))
    concepts = set(_TAG_CONCEPTS.get(tag, ()))
    for w in words:
        concepts.update(_TAG_CONCEPTS.get(w, ()))
    for c in sorted(concepts):
        dims.append((f"concept:{c}", CONCEPT_WEIGHT))
    return dims


def _build_idf() -> None:
    """Document frequency over the whole cache, so 'pop' is cheap and
    'tarraxinha' is expensive. Rebuilt when the cache has grown.

    Counted over EXPANDED dimensions: word and concept dimensions need their own
    document frequency, or `_idf_for` would treat every one of them as unseen
    and hand it the maximum weight.
    """
    global _idf, _idf_at
    n = len(_cache)
    df: dict[str, int] = {}
    for entry in _cache.values():
        dims: set[str] = set()
        for tag, _c in entry.get("t") or []:
            dims.update(d for d, _w in _expand(tag))
        for d in dims:
            df[d] = df.get(d, 0) + 1
    _idf = {d: math.log(1.0 + n / (1.0 + c)) for d, c in df.items()}
    _idf_at = n


def _idf_for(tag: str) -> float:
    # An unseen tag gets the weight of a maximally rare one rather than 0 —
    # a tag absent from the corpus is informative, not meaningless.
    return _idf.get(tag, math.log(1.0 + max(len(_cache), 1)))


def vector(norm_key: tuple[str, str]) -> dict[str, float]:
    """IDF-weighted, L2-normalized sparse tag vector. Empty when unknown."""
    _load()
    entry = _cache.get(cache_key(norm_key))
    if not entry:
        return {}
    tags = entry.get("t") or []
    if not tags:
        return {}
    # Rebuild IDF when the cache has grown by >5%: exact freshness is not worth
    # a full pass on every scored candidate.
    if _idf_at < 0 or len(_cache) > _idf_at * 1.05:
        _build_idf()
    discount = ARTIST_SRC_DISCOUNT if entry.get("src") == "artist" else 1.0
    vec: dict[str, float] = {}
    for rank, (tag, count) in enumerate(tags):
        base = (count / 100.0 + _COUNT_FLOOR) / (1.0 + rank * _RANK_DECAY) * discount
        for dim, mult in _expand(tag):
            w = base * mult * _idf_for(dim)
            if w > 0:
                vec[dim] = vec.get(dim, 0.0) + w
    norm = math.sqrt(sum(v * v for v in vec.values()))
    if norm <= 0:
        return {}
    return {t: v / norm for t, v in vec.items()}


def cosine(a: dict[str, float], b: dict[str, float]) -> float:
    """Cosine similarity of two L2-normalized sparse vectors (plain dot product).

    Iterates the smaller vector so scoring cost tracks the candidate, not the
    centroid, which can be much wider.
    """
    if not a or not b:
        return 0.0
    if len(b) < len(a):
        a, b = b, a
    return sum(w * b.get(t, 0.0) for t, w in a.items())


def blend(vectors: list[dict[str, float]],
          weights: list[float] | None = None) -> dict[str, float]:
    """Weighted sum of sparse vectors, L2-normalized. Empty when all are empty."""
    acc: dict[str, float] = {}
    for i, v in enumerate(vectors):
        if not v:
            continue
        w = weights[i] if weights and i < len(weights) else 1.0
        if w <= 0:
            continue
        for t, val in v.items():
            acc[t] = acc.get(t, 0.0) + val * w
    norm = math.sqrt(sum(v * v for v in acc.values()))
    if norm <= 0:
        return {}
    return {t: v / norm for t, v in acc.items()}


def centroid(norm_keys: list[tuple[str, str]],
             weights: list[float] | None = None) -> dict[str, float]:
    """Weighted mean of member vectors, L2-normalized. Empty when none known."""
    return blend([vector(nk) for nk in norm_keys], weights)


def top_tags(vec: dict[str, float], limit: int = 8) -> list[tuple[str, float]]:
    """Highest-weighted tags of a vector — for profile display and debugging."""
    return sorted(vec.items(), key=lambda kv: -kv[1])[:limit]


def stats() -> dict:
    """Cache-wide coverage, for the eval harness and diagnostics."""
    _load()
    by_src: dict[str, int] = {}
    for entry in _cache.values():
        by_src[entry.get("src") or "none"] = by_src.get(entry.get("src") or "none", 0) + 1
    return {"entries": len(_cache), "by_src": by_src, "distinct_tags": len(_idf) or None,
            "dirty": _dirty}
