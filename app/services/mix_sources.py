"""Finding DJ mixes across SoundCloud, YouTube, Mixcloud and hearthis.at.

The same set is often on several sites in very different quality (measured
2026-11-17 on zouk mixes): Mixcloud mostly AAC 64, SoundCloud AAC 160, YouTube
AAC 129, hearthis.at MP3 128-256. Search asks every site at once, says what
quality each result will download in, and folds the same set found on several
sites into one result (the best copy first, the others under `also`).

Nothing here downloads. A result is downloaded only through the ordinary mix job
(`POST /api/download` `type: "mix"` → `mixes.run_mix`).

YouTube is asked only with a flat search (one request, no per-video extraction)
and never while the player's rate-limit latch is set: YouTube has twice answered
our volume with HTTP 429, after which nothing un-downloaded plays.
"""

import asyncio
import json
import re
import time
import unicodedata
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit

import httpx

from app.services import mixes
from app.services.player import nfc

SOURCES = ("soundcloud", "youtube", "mixcloud", "hearthis")
SOURCE_TIMEOUT = 25          # each source on its own; the others still answer
SEARCH_CACHE_TTL = 600       # 10 min per (source, query)
SEARCH_CACHE_MAX = 200
SOUNDCLOUD_RESULTS = 10      # ~7 s measured for 10 with formats
YOUTUBE_RESULTS = 8          # flat: one request whatever the count
MIXCLOUD_RESULTS = 20
HEARTHIS_RESULTS = 20
UPLOADS_DEFAULT = 10

MIXCLOUD_GRAPHQL = "https://app.mixcloud.com/graphql"
HEARTHIS_API = "https://api-v2.hearthis.at"
_UA = "Mozilla/5.0 (X11; Linux x86_64) MusicSeeker"
_MIXCLOUD_HEADERS = {
    "Content-Type": "application/json",
    "Referer": "https://www.mixcloud.com/",
    "Origin": "https://www.mixcloud.com",
    "User-Agent": _UA,
}

YT_RATE_LIMITED = "YouTube is rate-limiting us"


class SourceError(Exception):
    """A user-facing reason one source gave no results."""


# ── HTTP ──

async def get_json(url: str, params: dict | None = None, timeout: float = SOURCE_TIMEOUT):
    async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": _UA},
                                 follow_redirects=True) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()


async def mixcloud_graphql(query: str, variables: dict | None = None,
                           timeout: float = SOURCE_TIMEOUT) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(MIXCLOUD_GRAPHQL, headers=_MIXCLOUD_HEADERS,
                                 json={"query": query, "variables": variables or {}})
        resp.raise_for_status()
        data = resp.json()
    if data.get("errors") and not data.get("data"):
        raise SourceError(str(data["errors"][0].get("message", "error"))[:200])
    return data.get("data") or {}


# ── Items ──

def _date_from_ts(ts) -> str:
    try:
        ts = float(ts)
        if ts <= 0:
            return ""
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


def _int(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError, OverflowError):
        return 0


def _dict(v) -> dict:
    return v if isinstance(v, dict) else {}


_MALFORMED = (TypeError, ValueError, AttributeError, OverflowError, KeyError)


def _parse_all(parse, rows, *args) -> list[dict]:
    """Every row `parse` can read; a malformed one is skipped, never a 500."""
    out = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        try:
            it = parse(row, *args)
        except _MALFORMED:
            it = None
        if it:
            out.append(it)
    return out


def make_item(source: str, url: str, title: str, uploader: str, uploader_id: str,
              uploader_url: str, thumbnail: str, duration, quality: dict, date: str = "") -> dict:
    return {
        "source": source,
        "source_label": mixes.SOURCE_LABEL[source],
        "url": url,
        "title": nfc(str(title or "").strip()) or "Untitled mix",
        "uploader": nfc(str(uploader or "").strip()) or "Unknown DJ",
        "uploader_id": str(uploader_id or ""),
        "uploader_url": uploader_url or "",
        "thumbnail": thumbnail or "",
        "duration": _int(duration),
        "date": date,
        **quality,
        "also": [],
    }


def _canon(url: str, source: str) -> str | None:
    p = mixes.parse_mix_url(url or "")
    return p[1] if p and p[0] == source else None


# SoundCloud — yt-dlp's own extractor, which lists every format with its rate.

def parse_soundcloud_entry(e: dict) -> dict | None:
    url = _canon(str(e.get("webpage_url") or e.get("url") or ""), "soundcloud")
    if not url:
        return None
    # A Go+ track offers a listener only a 30 s "_preview" (measured: 9 of 10
    # results for a pop query); quality_from_formats ignores those formats, so a
    # result with nothing else is not a mix we can get.
    q = mixes.quality_from_formats(e.get("formats") or [])
    if q is None:
        return None
    # The permalink, not the numeric id: it is what /<permalink>/tracks takes.
    up_url = str(e.get("uploader_url") or "")
    segs = [s for s in urlsplit(up_url).path.split("/") if s]
    permalink = segs[0] if segs else urlsplit(url).path.split("/")[1]
    return make_item("soundcloud", url, e.get("title"), e.get("uploader"), permalink,
                     f"https://soundcloud.com/{permalink}", mixes._pick_thumbnail(e),
                     e.get("duration"), q, _date_from_ts(e.get("timestamp")))


def parse_soundcloud_playlist(d: dict) -> list[dict]:
    return _parse_all(parse_soundcloud_entry, _dict(d).get("entries"))


# Every yt-dlp process this module starts takes a slot: a burst of searches,
# uploads and Check-now presses must not become a burst of processes (nor of
# requests to SoundCloud and YouTube). Two pools: a follow check (a SoundCloud
# DJ takes ~50 s) must never starve the searches people are waiting on. A
# process's timeout starts only once it has its slot; the wait for one is
# bounded on its own.
_search_slots = asyncio.Semaphore(2)
_uploads_slots = asyncio.Semaphore(2)
SLOT_WAIT = 60


def _pool(kind: str) -> asyncio.Semaphore:
    return _search_slots if kind == "search" else _uploads_slots


class _Slot:
    def __init__(self, kind: str):
        self.sem = _pool(kind)

    async def __aenter__(self):
        try:
            await asyncio.wait_for(self.sem.acquire(), SLOT_WAIT)
        except asyncio.TimeoutError:
            raise SourceError("busy — try again in a minute")

    async def __aexit__(self, *exc):
        self.sem.release()


async def _ytdlp_json(args: list[str], timeout: float = SOURCE_TIMEOUT,
                      kind: str = "search") -> tuple[dict, str]:
    async with _Slot(kind):
        rc, out, err = await mixes._run_capture(["yt-dlp", "--no-warnings", *args], timeout)
    if rc is None:
        raise SourceError(err or "timed out")
    try:
        return json.loads(out), err
    except ValueError:
        raise SourceError(mixes._last_error(err))


async def search_soundcloud(q: str) -> list[dict]:
    d, _ = await _ytdlp_json(["-J", f"scsearch{SOUNDCLOUD_RESULTS}:{q}"])
    return parse_soundcloud_playlist(d)


# YouTube — flat only: one request, nominal quality.

_YT_CHANNEL_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")


def parse_youtube_entry(e: dict, channel: dict | None = None) -> dict | None:
    vid = str(e.get("id") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
        return None
    if e.get("live_status") in ("is_live", "is_upcoming"):
        return None
    ch = _dict(channel)
    cid = e.get("channel_id") or ch.get("channel_id") or ""
    if not _YT_CHANNEL_RE.match(str(cid)):
        cid = ""
    return make_item(
        "youtube", f"https://www.youtube.com/watch?v={vid}", e.get("title"),
        e.get("channel") or e.get("uploader") or ch.get("channel") or ch.get("uploader"),
        cid, f"https://www.youtube.com/channel/{cid}" if cid else "",
        f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg", e.get("duration"),
        mixes.youtube_quality(), _date_from_ts(e.get("timestamp")),
    )


def _youtube_guard() -> None:
    if mixes._youtube_refused():
        raise SourceError(YT_RATE_LIMITED)


async def _youtube_flat(args: list[str], what: str, kind: str = "search") -> dict:
    _youtube_guard()
    async with _Slot(kind):
        _youtube_guard()   # it may have been set while we waited
        rc, out, err = await mixes._run_capture(
            ["yt-dlp", "--no-warnings", "--flat-playlist", "-J", *args], SOURCE_TIMEOUT)
    mixes._note_youtube_stderr(what, err)
    _youtube_guard()   # this very answer may have been the 429
    if rc is None:
        raise SourceError(err or "timed out")
    try:
        return json.loads(out)
    except ValueError:
        raise SourceError(mixes._last_error(err))


async def search_youtube(q: str) -> list[dict]:
    d = await _youtube_flat([f"ytsearch{YOUTUBE_RESULTS}:{q}"], f"mix search {q[:60]}")
    return _parse_all(parse_youtube_entry, _dict(d).get("entries"))


# Mixcloud — GraphQL; the search answer states SQ/HQ for every mix.

_MC_NODE = "name slug audioQuality audioLength publishDate picture { urlRoot }"


def _mc_picture(pic) -> str:
    root = str(_dict(pic).get("urlRoot") or "")
    return f"https://thumbnailer.mixcloud.com/unsafe/300x300/{root}" if root else ""


def parse_mixcloud_node(node: dict, owner: dict | None = None) -> dict | None:
    owner = _dict(node.get("owner")) or _dict(owner)
    user, slug = str(owner.get("username") or ""), str(node.get("slug") or "")
    if not user or not slug:
        return None
    url = f"https://www.mixcloud.com/{quote(user, safe='')}/{quote(slug, safe='')}/"
    return make_item("mixcloud", url, node.get("name"), owner.get("displayName") or user, user,
                     f"https://www.mixcloud.com/{quote(user, safe='')}/",
                     _mc_picture(node.get("picture")) or _mc_picture(owner.get("picture")),
                     node.get("audioLength"), mixes.mixcloud_quality(node.get("audioQuality")),
                     str(node.get("publishDate") or "")[:10])


def parse_mixcloud_search(data: dict) -> list[dict]:
    sq = _dict(_dict(_dict(_dict(data).get("viewer")).get("search")).get("searchQuery"))
    edges = _dict(sq.get("cloudcasts")).get("edges")
    return _parse_all(lambda e: parse_mixcloud_node(_dict(e.get("node"))), edges)


async def search_mixcloud(q: str) -> list[dict]:
    query = ("query($term: String!) { viewer { search { searchQuery(term: $term) {"
             f" cloudcasts(first: {MIXCLOUD_RESULTS}) {{ edges {{ node {{ {_MC_NODE}"
             " owner { username displayName picture { urlRoot } } } } } } } } }")
    return parse_mixcloud_search(await mixcloud_graphql(query, {"term": q}))


async def mixcloud_audio_quality(url: str) -> str:
    """'HQ' / 'SQ' for one Mixcloud mix URL, '' when Mixcloud does not say."""
    segs = [s for s in urlsplit(url).path.split("/") if s]
    if len(segs) != 2:
        return ""
    from urllib.parse import unquote
    query = ("query($u: String!, $s: String!) { cloudcastLookup(lookup: {username: $u, slug: $s})"
             " { audioQuality } }")
    data = await mixcloud_graphql(query, {"u": unquote(segs[0]), "s": unquote(segs[1])}, timeout=15)
    return str(_dict(_dict(data).get("cloudcastLookup")).get("audioQuality") or "")


# hearthis.at — a public API without a key.

def parse_hearthis_track(t: dict) -> dict | None:
    url = _canon(str(t.get("permalink_url") or ""), "hearthis")
    if not url or str(t.get("private") or "0") == "1":
        return None
    user = _dict(t.get("user"))
    permalink = str(user.get("permalink") or "")
    if not mixes.hearthis_segment_ok(permalink):
        permalink = urlsplit(url).path.split("/")[1]
    return make_item("hearthis", url, t.get("title"), user.get("username") or permalink,
                     permalink, str(user.get("permalink_url") or ""),
                     str(t.get("artwork_url") or user.get("avatar_url") or ""), t.get("duration"),
                     mixes.hearthis_quality(t.get("downloadable"), str(t.get("download_filename") or "")),
                     _date_from_ts(t.get("release_timestamp")))


def parse_hearthis_list(data) -> list[dict]:
    return _parse_all(parse_hearthis_track, data)


async def search_hearthis(q: str) -> list[dict]:
    data = await get_json(f"{HEARTHIS_API}/search",
                          {"t": q, "type": "tracks", "count": HEARTHIS_RESULTS})
    return parse_hearthis_list(data)


SEARCHERS = {
    "soundcloud": search_soundcloud,
    "youtube": search_youtube,
    "mixcloud": search_mixcloud,
    "hearthis": search_hearthis,
}


# ── Folding the same set together ──

def norm_title(title: str) -> set[str]:
    """Lower case, no diacritics, no punctuation, as a set of words."""
    s = unicodedata.normalize("NFKD", title or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^\w\s]|_", " ", s)
    return {w for w in s.split() if w}


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def same_set(a: dict, b: dict) -> bool:
    """Same recording on two sites: titles share ≥ 60 % of their words, the
    lengths agree within 2 %, and the numbers in the titles are the same ones
    ("Vol. 2" is not "Vol. 3", even at the same length)."""
    da, db = a.get("duration") or 0, b.get("duration") or 0
    if da <= 0 or db <= 0:
        return False
    if abs(da - db) > 0.02 * max(da, db):
        return False
    ta, tb = norm_title(a.get("title", "")), norm_title(b.get("title", ""))
    if {w for w in ta if w.isdigit()} != {w for w in tb if w.isdigit()}:
        return False
    return jaccard(ta, tb) >= 0.6


def _better(a: dict, b: dict) -> bool:
    """Is `a` the copy to show over `b`? Higher kbps; on a tie a measured figure
    beats a typical one."""
    return (a.get("kbps", 0), a.get("quality_known", False)) > (b.get("kbps", 0), b.get("quality_known", False))


def _also_entry(it: dict) -> dict:
    """A copy on another site, with everything a result row needs: the page shows
    it in place of the best copy when the best copy's site is switched off."""
    return {k: v for k, v in it.items() if k not in ("also", "relevance")}


def dedupe(items: list[dict]) -> list[dict]:
    """One result per set found on several sites. Keeps the relevance position
    of the group's first member; the best-quality copy becomes the result, the rest go in `also`."""
    groups: list[list[dict]] = []
    for it in items:
        for g in groups:
            # Across sites only: two uploads on one site are two uploads.
            if all(m["source"] != it["source"] for m in g) and any(same_set(it, m) for m in g):
                g.append(it)
                break
        else:
            groups.append([it])
    out = []
    for g in groups:
        best = g[0]
        for m in g[1:]:
            if _better(m, best):
                best = m
        merged = dict(best)
        merged["also"] = [_also_entry(m) for m in g if m is not best]
        out.append(merged)
    return out


def interleave(per_source: dict[str, list[dict]], order=SOURCES) -> list[dict]:
    """Round-robin across sources, keeping each source's own ranking."""
    lists = [list(per_source.get(s) or []) for s in order]
    out, i = [], 0
    while any(i < len(lst) for lst in lists):
        for lst in lists:
            if i < len(lst):
                out.append(lst[i])
        i += 1
    return out


def quality_band(kbps: int) -> int:
    if kbps >= 192:
        return 0
    if kbps >= 160:
        return 1
    if kbps >= 128:
        return 2
    return 3


def sort_by_quality(items: list[dict]) -> list[dict]:
    """Bands ≥192, ≥160, ≥128, <128; relevance kept inside a band (stable sort)."""
    return sorted(items, key=lambda it: quality_band(it.get("kbps", 0)))


# ── Search ──

_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}


def _cache_get(source: str, q: str) -> list[dict] | None:
    hit = _cache.get((source, q))
    if hit and time.monotonic() - hit[0] < SEARCH_CACHE_TTL:
        return hit[1]
    return None


def _cache_put(source: str, q: str, items: list[dict]) -> None:
    if len(_cache) >= SEARCH_CACHE_MAX:
        oldest = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest, None)
    _cache[(source, q)] = (time.monotonic(), items)


def parse_sources(raw: str | None) -> list[str]:
    if not raw:
        return list(SOURCES)
    want = {s.strip().lower() for s in raw.split(",")}
    return [s for s in SOURCES if s in want]


async def _one_source(source: str, q: str) -> list[dict]:
    cached = _cache_get(source, q)
    if cached is not None:
        return cached
    # No outer deadline: each request has its own timeout, which for yt-dlp
    # starts once it has a slot — waiting behind other searches is not a failure.
    items = await SEARCHERS[source](q)
    _cache_put(source, q, items)
    return items


def _err_text(e: Exception) -> str:
    if isinstance(e, asyncio.TimeoutError):
        return "timed out"
    if isinstance(e, httpx.HTTPStatusError):
        return f"HTTP {e.response.status_code}"
    return (str(e) or type(e).__name__)[:200]


async def search(q: str, sources: list[str]) -> dict:
    """All results of every asked source, folded and quality-sorted, plus
    `errors: {source: reason}` for the ones that failed. Filtering is the
    client's (a toggle has to be instant)."""
    q = nfc(" ".join(str(q or "").split()))[:200]
    results = await asyncio.gather(*(_one_source(s, q) for s in sources), return_exceptions=True)
    per_source, errors = {}, {}
    for s, r in zip(sources, results):
        if isinstance(r, BaseException):
            errors[s] = _err_text(r)
        else:
            per_source[s] = r
    merged = dedupe(interleave(per_source))
    for i, it in enumerate(merged):
        it["relevance"] = i
    return {"query": q, "sources": sources, "results": sort_by_quality(merged),
            "errors": errors, "counts": {s: len(v) for s, v in per_source.items()}}


# ── A DJ's latest uploads ──

_SOUNDCLOUD_USER_RE = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


def valid_user_id(source: str, user_id: str) -> bool:
    """`uploader_id` must be usable to list the DJ's uploads on its site."""
    uid = str(user_id or "")
    if source == "youtube":
        return bool(_YT_CHANNEL_RE.match(uid))
    if source == "soundcloud":
        return bool(_SOUNDCLOUD_USER_RE.match(uid)) and uid.lower() not in mixes._SOUNDCLOUD_RESERVED
    if source == "hearthis":
        return mixes.hearthis_segment_ok(uid) and uid.lower() not in mixes._HEARTHIS_RESERVED
    if source == "mixcloud":
        return (0 < len(uid) <= 100 and not re.search(r"[\s/?#\\]", uid)
                and uid.lower() not in mixes._MIXCLOUD_RESERVED)
    return False


async def uploads_mixcloud(user_id: str, limit: int) -> list[dict]:
    query = ("query($u: String!) { userLookup(lookup: {username: $u}) { username displayName"
             f" picture {{ urlRoot }} uploads(first: {int(limit)}) {{ edges {{ node {{ {_MC_NODE} }} }} }} }} }}")
    data = await mixcloud_graphql(query, {"u": user_id})
    user = _dict(data.get("userLookup"))
    if not user:
        raise SourceError("Mixcloud: no such user")
    owner = {"username": user.get("username") or user_id, "displayName": user.get("displayName"),
             "picture": user.get("picture")}
    edges = _dict(user.get("uploads")).get("edges")
    return _parse_all(lambda e: parse_mixcloud_node(_dict(e.get("node")), owner), edges)


async def uploads_soundcloud(user_id: str, limit: int) -> list[dict]:
    # Full extraction (formats per track): measured 3.8 s for 5 tracks.
    d, _ = await _ytdlp_json(["-J", "--playlist-end", str(int(limit)),
                              f"https://soundcloud.com/{user_id}/tracks"], timeout=SOURCE_TIMEOUT * 2,
                             kind="uploads")
    return parse_soundcloud_playlist(d)


async def uploads_hearthis(user_id: str, limit: int) -> list[dict]:
    data = await get_json(f"{HEARTHIS_API}/{user_id}/",
                          {"type": "tracks", "page": 1, "count": int(limit)})
    return parse_hearthis_list(data)


def parse_youtube_channel(d: dict) -> list[dict]:
    d = _dict(d)
    ch = {k: d.get(k) for k in ("channel", "channel_id", "uploader")}
    return _parse_all(parse_youtube_entry, d.get("entries"), ch)


async def uploads_youtube(user_id: str, limit: int) -> list[dict]:
    d = await _youtube_flat(["--playlist-end", str(int(limit)),
                             f"https://www.youtube.com/channel/{user_id}/videos"],
                            f"mix uploads {user_id}", kind="uploads")
    return parse_youtube_channel(d)


UPLOADERS = {
    "mixcloud": uploads_mixcloud,
    "soundcloud": uploads_soundcloud,
    "hearthis": uploads_hearthis,
    "youtube": uploads_youtube,
}


async def uploads(source: str, user_id: str, limit: int = UPLOADS_DEFAULT) -> list[dict]:
    """The DJ's latest uploads, newest first, in the search-result shape."""
    if source not in UPLOADERS or not valid_user_id(source, user_id):
        raise SourceError("Not a DJ this source can list")
    limit = max(1, min(int(limit or UPLOADS_DEFAULT), 30))
    return await UPLOADERS[source](user_id, limit)
