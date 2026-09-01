"""Import a shared playlist/album link (Spotify, Deezer) into MusicSeeker.

Two entry points:

* `import_from_url` — one share link → the whole playlist/album.
* `import_from_text` — a pasted blob of per-track links (or `Artist - Title`
  lines) → tracks. This is the escape hatch for the >100 case described below.

Why the embed page: the app's Spotify API access is currently 403 on every
endpoint (the owner account lost Premium), which `spotify.api_available()`
latches. The public embed page (`open.spotify.com/embed/<kind>/<id>`) still
answers 200 unauthenticated and carries the whole entity in its
`__NEXT_DATA__` blob, so it is the fallback. Its one hard limitation is that
`trackList` is capped at 100 items and `?offset=`/`?limit=` are ignored
(verified) — hence the `truncated` flag and `import_from_text`.

Only the public embed surface and the official authenticated API are used.
Spotify's `get_access_token` / `api/token` web endpoints are deliberately NOT
used: they answer 403 "URL Blocked" and 400 "not permitted under the Spotify
Developer Terms" respectively.
"""

import asyncio
import json
import logging
import re

import httpx

from app.services import spotify, search_providers

logger = logging.getLogger(__name__)

EMBED_BASE = "https://open.spotify.com/embed"

# The embed page 200s with a browser UA; a bare httpx UA is not worth risking.
_EMBED_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    "Accept-Language": "en",
}
_EMBED_TIMEOUT = 10
# One entity fetch can afford 10s; the paste path fires one per track, so it gets a
# tighter budget (measured embed latency: median 0.23s, max 0.69s over 16 fetches).
_EMBED_TRACK_TIMEOUT = 4

# The embed payload never returns more than this, whatever the real length is. The
# entity carries no real total either (verified against a 100-item playlist: keys are
# name/title/subtitle/coverArt/duration/trackList/… and no *count/total/length field
# anywhere in __NEXT_DATA__), so "100 items" is the only truncation signal there is.
_EMBED_TRACK_CAP = 100

# Bounds for the paste path: one HTTP call per track, so cap width, depth AND the
# product of the two. Worst case (every request burning its full timeout) is
# ceil(200 / 10) * 4s = 80s, which fits under the 90s wall-clock deadline; past the
# deadline the caller gets the partial result it has collected so far.
_TRACK_CONCURRENCY = 10
_TEXT_MAX_ENTRIES = 200
_TEXT_DEADLINE = 90
# Official /v1/tracks takes up to 50 ids per call.
_API_TRACK_BATCH = 50

_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
_SPOTIFY_URI_RE = re.compile(r"spotify:(track|album|playlist):([a-zA-Z0-9]+)")
# spotify.parse_spotify_url() doesn't know about the /intl-xx/ locale segment that
# the mobile apps now put in share links, so match that shape here as a second pass.
_SPOTIFY_URL_RE = re.compile(
    r"open\.spotify\.com/(?:intl-[a-zA-Z-]+/)?(track|album|playlist)/([a-zA-Z0-9]+)")
_SPOTIFY_TRACK_RE = re.compile(
    r"(?:open\.spotify\.com/(?:intl-[a-zA-Z-]+/)?track/|spotify:track:)([a-zA-Z0-9]+)")
_DEEZER_TRACK_RE = re.compile(r"deezer\.com/(?:[a-z]{2}/)?track/(\d+)")
# Same story on Deezer: parse_deezer_url() doesn't allow the /en/ locale segment
# that www.deezer.com share links carry.
_DEEZER_URL_RE = re.compile(r"deezer\.com/(?:[a-z]{2}/)?(track|album|playlist)/(\d+)")
# `Artist - Title` for plain text lines: hyphen, en dash or em dash as separator.
_TEXT_SPLIT_RE = re.compile(r"\s+[-–—]\s+")
# Exporters number their lines ("1. Artist - Title", "12) Artist - Title").
_TEXT_NUMBERING_RE = re.compile(r"^\d{1,3}\s*[.)\]]\s+")
# A line meant to be a link. If it looks like one but matches no *track* pattern
# (artist/show/episode links, a bare domain, a truncated paste) it is a failure,
# never a track named after the URL.
_URLISH_RE = re.compile(r"^(?:https?://|spotify:)", re.I)
# At least one letter — kills "1.", "---", "===", "(2024)" and friends.
_HAS_LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)


class ImportNotFound(RuntimeError):
    """The upstream says this entity is not there (private, deleted, bad id)."""


class ImportUnavailable(RuntimeError):
    """Upstream unreachable or unreadable. `str(exc)` is safe to show a user."""


def _upstream_error(exc: Exception, what: str) -> RuntimeError:
    """Map a transport/parse failure to the typed error the route renders."""
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404:
        return ImportNotFound(
            "That playlist isn't public (or no longer exists), so it can't be imported.")
    if isinstance(exc, (ImportNotFound, ImportUnavailable)):
        return exc
    if isinstance(exc, RuntimeError):
        # The "format may have changed" cases: the message is already user-facing.
        return ImportUnavailable(str(exc))
    return ImportUnavailable(f"{what} couldn't be reached right now.")


def parse_import_url(url: str) -> tuple[str, str, str] | None:
    """`(source, kind, id)` for a Spotify/Deezer playlist or album link.

    Tolerates share junk (`?si=…&utm_source=whatsapp`), `spotify:playlist:<id>`
    URIs, `/intl-xx/` locale segments and surrounding whitespace. Returns None
    for anything that isn't a recognised playlist/album link.
    """
    if not url:
        return None
    text = url.strip()

    m = _SPOTIFY_URI_RE.search(text)
    if m and m.group(1) in ("playlist", "album"):
        return "spotify", m.group(1), m.group(2)

    parsed = spotify.parse_spotify_url(text)
    if parsed and parsed[0] in ("playlist", "album"):
        return "spotify", parsed[0], parsed[1]

    m = _SPOTIFY_URL_RE.search(text)
    if m and m.group(1) in ("playlist", "album"):
        return "spotify", m.group(1), m.group(2)

    dz = search_providers.parse_deezer_url(text)
    if dz and dz[0] in ("playlist", "album"):
        return "deezer", dz[0], dz[1]

    m = _DEEZER_URL_RE.search(text)
    if m and m.group(1) in ("playlist", "album"):
        return "deezer", m.group(1), m.group(2)

    return None


# ── Spotify public embed ────────────────────────────────────────────

def _clean(value) -> str:
    """Collapse whitespace. Embed subtitles join artists with a non-breaking
    space (`Vescan,\\u00a0Mahia Beldo`), which `\\s` matches, so this flattens it."""
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()


def _embed_image(entity: dict) -> str:
    """Cover art URL from an embed entity (playlists use coverArt, albums/tracks
    only carry visualIdentity)."""
    sources = ((entity.get("coverArt") or {}).get("sources") or [])
    for src in sources:
        if (src.get("width") or 0) >= 300 and src.get("url"):
            return src["url"]
    if sources and sources[0].get("url"):
        return sources[0]["url"]
    images = ((entity.get("visualIdentity") or {}).get("image") or [])
    for img in images:
        if (img.get("maxWidth") or 0) >= 300 and img.get("url"):
            return img["url"]
    if images and images[0].get("url"):
        return images[0]["url"]
    return ""


async def _fetch_embed_entity(client: httpx.AsyncClient, kind: str, spotify_id: str) -> dict:
    resp = await client.get(f"{EMBED_BASE}/{kind}/{spotify_id}")
    resp.raise_for_status()
    m = _NEXT_DATA_RE.search(resp.text)
    if not m:
        raise RuntimeError(f"Spotify embed page for {kind}/{spotify_id} carried no __NEXT_DATA__")
    payload = json.loads(m.group(1))
    entity = (((payload.get("props") or {}).get("pageProps") or {})
              .get("state") or {}).get("data", {}).get("entity")
    if not isinstance(entity, dict):
        # Verified: a private / deleted / bogus id answers 200 with __NEXT_DATA__
        # present but `state` empty ({}), never a 404. So THIS is the not-found
        # signal, and it must not be reported as a broken page format.
        raise ImportNotFound(
            f"That {kind} isn't public (or no longer exists), so it can't be imported.")
    return entity


def _embed_tracks(entity: dict, album_name: str = "", image: str = "") -> list[dict]:
    tracks = []
    for item in (entity.get("trackList") or []):
        if not isinstance(item, dict):
            continue
        name = _clean(item.get("title"))
        if not name:
            continue
        tracks.append({
            "name": name,
            "artist": _clean(item.get("subtitle")),
            "album": album_name,
            "duration_ms": item.get("duration") or 0,
            "image": image,
        })
    return tracks


async def _spotify_embed_import(kind: str, spotify_id: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=_EMBED_TIMEOUT, headers=_EMBED_HEADERS,
                                     follow_redirects=True) as client:
            entity = await _fetch_embed_entity(client, kind, spotify_id)
    except Exception as e:
        # 404 (private/deleted), 429, timeouts, connect errors and the two
        # "no __NEXT_DATA__ / no entity" RuntimeErrors all become typed errors so
        # the route can answer 404/502 instead of leaking a 500 traceback.
        raise _upstream_error(e, "Spotify's public page") from e

    name = _clean(entity.get("name")) or _clean(entity.get("title"))
    image = _embed_image(entity)
    # An album embed's entity name IS the album title; a playlist has no per-track album.
    tracks = _embed_tracks(entity, album_name=name if kind == "album" else "",
                           image=image if kind == "album" else "")
    raw = entity.get("trackList") or []
    if raw and not tracks:
        # Never hand back a successful-looking empty playlist: that is the silent-empty
        # bug class ("shows 0 tracks" painted as success) this feature must not repeat.
        raise ImportUnavailable(
            f"Spotify's public {kind} page returned no readable tracks "
            "(its format may have changed)")
    return {
        "name": name,
        "image": image,
        "tracks": tracks,
        # Count the RAW items, not the parsed ones: parsed-count made an exactly-100
        # playlist nag falsely, and hid the nag when a 300-track page had parse gaps.
        "truncated": len(raw) >= _EMBED_TRACK_CAP,
        "via": "embed",
    }


# ── Official API paths ──────────────────────────────────────────────

def _normalize(track: dict, fallback_album: str = "", fallback_image: str = "") -> dict:
    return {
        "name": _clean(track.get("name")),
        "artist": _clean(track.get("artist")),
        "album": _clean(track.get("album")) or fallback_album,
        "duration_ms": track.get("duration_ms") or 0,
        "image": track.get("image") or fallback_image,
    }


async def _spotify_api_import(kind: str, spotify_id: str, creds: dict | None) -> dict:
    if kind == "playlist":
        data = await spotify.get_playlist_tracks(spotify_id, creds=creds)
        image = data.get("image", "")
        tracks = [_normalize(t, fallback_image=image) for t in data.get("tracks", [])]
        name = data.get("name", "")
    else:
        raw = await spotify.get_album_tracks(spotify_id)
        tracks = [_normalize(t) for t in raw]
        # get_album_tracks() stamps every track with the album name/cover.
        name = tracks[0]["album"] if tracks else ""
        image = tracks[0]["image"] if tracks else ""
    return {"name": name, "image": image, "tracks": tracks, "truncated": False, "via": "api"}


async def _deezer_import(kind: str, deezer_id: str) -> dict:
    if kind == "playlist":
        data = await search_providers.deezer_get_playlist_tracks(deezer_id)
        name, image = data.get("name", ""), data.get("image", "")
        raw = data.get("tracks", [])
    else:
        raw = await search_providers.deezer_get_album_tracks(deezer_id)
        name = raw[0].get("album", "") if raw else ""
        image = raw[0].get("image", "") if raw else ""
    tracks = [_normalize(t, fallback_image=image) for t in raw]
    return {
        "name": name,
        "image": image,
        "tracks": tracks,
        # deezer_get_playlist_tracks() pages properly but stops at its own ceiling.
        "truncated": len(tracks) >= search_providers._PLAYLIST_MAX_TRACKS,
        "via": "api",
    }


async def import_from_url(url: str, creds: dict | None = None) -> dict:
    """Resolve a share link to `{source, kind, id, name, image, tracks, total,
    truncated, via}`. Raises ValueError when the link isn't recognised."""
    parsed = parse_import_url(url)
    if not parsed:
        raise ValueError("Not a recognised Spotify or Deezer playlist/album link")
    source, kind, item_id = parsed

    if source == "deezer":
        try:
            result = await _deezer_import(kind, item_id)
        except (httpx.HTTPError, RuntimeError) as e:
            raise _upstream_error(e, "Deezer") from e
    else:
        result = None
        if spotify.api_available():
            try:
                result = await _spotify_api_import(kind, item_id, creds)
            except Exception as e:
                # SpotifyUnavailable (403 latch), HTTP errors, and the plain
                # RuntimeError get_user_token() raises with no refresh token all
                # mean the same thing here: try the public embed instead of 500ing.
                logger.warning("Spotify API import failed for %s/%s (%s) — using public embed",
                               kind, item_id, e)
        # An empty-but-successful API answer counts as a failure here: it happens for
        # playlists of local files / podcast episodes (get_playlist_tracks skips
        # anything without an id), and the embed page often does have those tracks.
        if result is None or not result.get("tracks"):
            result = await _spotify_embed_import(kind, item_id)

    return {
        "source": source,
        "kind": kind,
        "id": item_id,
        "name": result["name"],
        "image": result["image"],
        "tracks": result["tracks"],
        "total": len(result["tracks"]),
        "truncated": result["truncated"],
        "via": result["via"],
    }


# ── Pasted-text path (the >100 escape hatch) ────────────────────────

def _parse_text_entry(line: str) -> dict | None:
    """Parse a non-link line as `Artist - Title`.

    One convention, deliberately: `Artist - Title` (hyphen, en dash or em dash),
    because that is what nearly every playlist exporter emits, optionally with a
    `1.` / `2)` numbering prefix. A line WITHOUT that separator is not a track — it
    is a pasted heading, a separator rule or a stray word — so it returns None and
    is counted as failed rather than inventing a track from noise.
    """
    text = _TEXT_NUMBERING_RE.sub("", _clean(line))
    if not text or not _HAS_LETTER_RE.search(text):
        return None
    parts = _TEXT_SPLIT_RE.split(text, maxsplit=1)
    if len(parts) != 2:
        return None
    artist, name = parts[0].strip(), parts[1].strip()
    if not artist or not name or not _HAS_LETTER_RE.search(name):
        return None
    return {"name": name, "artist": artist, "album": "", "duration_ms": 0, "image": ""}


def _extract_entries(text: str) -> list[tuple[str, str]]:
    """Line-ordered `(kind, value)` entries: ('spotify', id), ('deezer', id),
    ('text', line) or ('invalid', line). Multiple links on one line all count.

    'invalid' is a line that is a link but not a *track* link (artist, show,
    episode, a bare domain, a truncated paste). It is reported as failed — turning
    it into a text entry produced a "track" literally named after the URL, which
    the player then handed to a YouTube search.
    """
    entries: list[tuple[str, str]] = []
    for line in (text or "").splitlines():
        if len(entries) >= _TEXT_MAX_ENTRIES:
            break
        links = [("spotify", i) for i in _SPOTIFY_TRACK_RE.findall(line)]
        links += [("deezer", i) for i in _DEEZER_TRACK_RE.findall(line)]
        if links:
            entries.extend(links[:_TEXT_MAX_ENTRIES - len(entries)])
            continue
        cleaned = _clean(line)
        if not cleaned:
            continue
        entries.append(("invalid" if _URLISH_RE.match(cleaned) else "text", line))
    return entries


async def _resolve_spotify_ids_api(ids: list[str], creds: dict | None,
                                   out: dict[str, dict]) -> None:
    """Batch resolve via the official /v1/tracks into `out`. Raises on failure so the
    caller falls back to embeds; whatever it already wrote stays usable."""
    for start in range(0, len(ids), _API_TRACK_BATCH):
        batch = ids[start:start + _API_TRACK_BATCH]
        data = await spotify.spotify_get("tracks", {"ids": ",".join(batch)}, creds=creds)
        for t in (data.get("tracks") or []):
            if not t or not t.get("id"):
                continue
            album = t.get("album") or {}
            out[t["id"]] = {
                "name": _clean(t.get("name")),
                "artist": _clean(", ".join(a["name"] for a in t.get("artists", []))),
                "album": _clean(album.get("name")),
                "duration_ms": t.get("duration_ms") or 0,
                "image": spotify._best_image(album.get("images", [])),
            }


async def _resolve_spotify_ids_embed(ids: list[str], out: dict[str, dict]) -> None:
    """One embed page per track into `out`, bounded concurrency, failures skipped.
    Cancellable at any point: everything resolved so far is already in `out`."""
    sem = asyncio.Semaphore(_TRACK_CONCURRENCY)

    async with httpx.AsyncClient(timeout=_EMBED_TRACK_TIMEOUT, headers=_EMBED_HEADERS,
                                 follow_redirects=True) as client:
        async def one(track_id: str) -> None:
            async with sem:
                try:
                    entity = await _fetch_embed_entity(client, "track", track_id)
                except Exception as e:
                    logger.warning("Spotify track embed failed for %s: %s", track_id, e)
                    return
            name = _clean(entity.get("name")) or _clean(entity.get("title"))
            if not name:
                return
            out[track_id] = {
                "name": name,
                "artist": _clean(", ".join(
                    a.get("name", "") for a in (entity.get("artists") or []) if a.get("name"))),
                # A track embed carries no album name.
                "album": "",
                "duration_ms": entity.get("duration") or 0,
                "image": _embed_image(entity),
            }

        await asyncio.gather(*(one(i) for i in ids))


async def _resolve_deezer_ids(ids: list[str], out: dict[str, dict]) -> None:
    sem = asyncio.Semaphore(_TRACK_CONCURRENCY)

    async def one(track_id: str) -> None:
        async with sem:
            try:
                track = await search_providers.deezer_get_track(track_id)
            except Exception as e:
                logger.warning("Deezer track lookup failed for %s: %s", track_id, e)
                return
        if _clean(track.get("name")):
            out[track_id] = _normalize(track)

    await asyncio.gather(*(one(i) for i in ids))


async def import_from_text(text: str, creds: dict | None = None) -> dict:
    """Resolve pasted per-track links (and `Artist - Title` lines) to
    `{tracks, requested, resolved, failed, capped, timed_out, via}`.

    Deduplicated by normalised `name|artist`, original order preserved. Bounded by
    `_TEXT_MAX_ENTRIES` (depth, reported as `capped`), `_TRACK_CONCURRENCY` (width)
    and `_TEXT_DEADLINE` (wall clock, reported as `timed_out`): past the deadline the
    partial result is returned instead of the request hanging or failing outright.
    """
    entries = _extract_entries(text)
    spotify_ids = [v for k, v in entries if k == "spotify"]
    deezer_ids = [v for k, v in entries if k == "deezer"]

    spotify_map: dict[str, dict] = {}
    deezer_map: dict[str, dict] = {}
    sources: set[str] = set()
    timed_out = False

    async def resolve_all() -> None:
        if spotify_ids:
            unique_ids = list(dict.fromkeys(spotify_ids))
            if spotify.api_available():
                try:
                    await _resolve_spotify_ids_api(unique_ids, creds, spotify_map)
                    sources.add("api")
                except Exception as e:
                    logger.warning("Spotify API track batch failed (%s) — using public embeds", e)
                    spotify_map.clear()
            if not spotify_map:
                # Tag before awaiting: the deadline can cancel this mid-pass and the
                # partial result still came from the embed path.
                sources.discard("api")
                sources.add("embed")
                await _resolve_spotify_ids_embed(unique_ids, spotify_map)
        if deezer_ids:
            await _resolve_deezer_ids(list(dict.fromkeys(deezer_ids)), deezer_map)

    try:
        await asyncio.wait_for(resolve_all(), timeout=_TEXT_DEADLINE)
    except (asyncio.TimeoutError, TimeoutError):
        # Keep whatever the resolvers already wrote; the unresolved rest is `failed`.
        timed_out = True
        logger.warning("Text import hit the %ss deadline with %d/%d entries resolved",
                       _TEXT_DEADLINE, len(spotify_map) + len(deezer_map), len(entries))
    if deezer_map:
        sources.add("api")

    tracks: list[dict] = []
    seen: set[str] = set()
    failed = 0
    for kind, value in entries:
        if kind == "spotify":
            track = spotify_map.get(value)
        elif kind == "deezer":
            track = deezer_map.get(value)
        elif kind == "text":
            track = _parse_text_entry(value)
            if track:
                sources.add("text")
        else:
            # 'invalid': a link we could not read as a track. Counted, never invented.
            track = None
        if not track:
            failed += 1
            continue
        key = f"{track['name'].casefold()}|{track['artist'].casefold()}"
        if key in seen:
            continue
        seen.add(key)
        tracks.append(track)

    if not sources:
        via = "text"
    elif len(sources) == 1:
        via = next(iter(sources))
    else:
        via = "mixed"

    return {
        "tracks": tracks,
        "requested": len(entries),
        "resolved": len(entries) - failed,
        "failed": failed,
        # The paste itself was longer than we will resolve — say so rather than
        # quietly returning the first _TEXT_MAX_ENTRIES lines as the whole answer.
        "capped": len(entries) >= _TEXT_MAX_ENTRIES,
        "timed_out": timed_out,
        "via": via,
    }
