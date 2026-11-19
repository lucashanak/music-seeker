"""Unified music search with multiple providers: Deezer, YouTube Music, Spotify, Apple/iTunes."""

import asyncio
import re
import threading
import time
from collections import deque
import unicodedata
import logging
import defusedxml.ElementTree as ET
import httpx

logger = logging.getLogger(__name__)

DEEZER_BASE = "https://api.deezer.com"

# ── Deezer rate limit ────────────────────────────────────────────────
# Deezer's public API allows roughly 50 requests / 5s per IP and answers
# "Quota limit exceeded" past that. The failure is NOT confined to whoever
# overran it: every Deezer call in that window fails, including the ones that
# resolve cover art — which is how a background co-occurrence mining burst
# (a playlist search per query plus up to 30 playlist fetches) made images
# disappear across the whole app while the library's own covers kept working.
#
# A semaphore was not enough: it bounds concurrency, not rate, and three fast
# sequential calls still overrun the window. This is a token bucket in front of
# EVERY Deezer request, so background work queues behind the budget instead of
# spending someone else's share of it.
_DEEZER_WINDOW = 5.0
_DEEZER_MAX_PER_WINDOW = 35  # headroom under ~50 so a burst never reaches the cap
_deezer_calls: deque = deque()
_deezer_lock = asyncio.Lock()


async def _deezer_limit() -> None:
    """Block until this process may make another Deezer request."""
    async with _deezer_lock:
        while True:
            now = time.monotonic()
            while _deezer_calls and now - _deezer_calls[0] >= _DEEZER_WINDOW:
                _deezer_calls.popleft()
            if len(_deezer_calls) < _DEEZER_MAX_PER_WINDOW:
                _deezer_calls.append(now)
                return
            # Holding the lock across the wait is deliberate: it serialises
            # waiters so they resume in order instead of stampeding together.
            await asyncio.sleep(_DEEZER_WINDOW - (now - _deezer_calls[0]) + 0.05)

ITUNES_BASE = "https://itunes.apple.com"
# Which Apple storefront to search. The iTunes API answers for the United
# States whatever the caller's address is, while Deezer and YouTube Music both
# answer for the region they are called from — so left alone, iTunes is the one
# provider searching a different market than the user lives in. Measured
# (`scratchpad/autor3-5-c6/itunes-storefront.txt`): "olympic" on the US
# storefront returns none of the Czech band's work at all and the search is
# about the Games, while on CZ it is theirs fourteen rows of sixteen.
ITUNES_COUNTRY = "CZ"

# Bounds for paginated playlist fetches
_PLAYLIST_MAX_PAGES = 5
_PLAYLIST_MAX_TRACKS = 500

# Hard ceiling for the aggregate search so a stalled provider can't hang the request
_SEARCH_ALL_TIMEOUT = 12

# Lazy-init ytmusicapi (guarded: concurrent to_thread calls must not build several clients)
_ytmusic = None
_ytmusic_lock = threading.Lock()


def _get_ytmusic():
    global _ytmusic
    if _ytmusic is None:
        with _ytmusic_lock:
            if _ytmusic is None:
                from ytmusicapi import YTMusic
                _ytmusic = YTMusic()
    return _ytmusic


# ── Deezer ──

def _deezer_track(item: dict) -> dict:
    """Map one Deezer track object to the shape the app passes around.

    Shared by search and the artist top-tracks endpoint so the two can never
    hand the frontend subtly different track dicts.
    """
    return {
        "id": str(item["id"]),
        "name": item.get("title", ""),
        "artist": item.get("artist", {}).get("name", ""),
        "artist_id": str(item.get("artist", {}).get("id", "")),
        "album": item.get("album", {}).get("title", ""),
        "album_id": str(item.get("album", {}).get("id", "")),
        "year": "",
        "image": item.get("album", {}).get("cover_big", ""),
        "url": item.get("link", ""),
        "duration_ms": item.get("duration", 0) * 1000,
        "explicit": bool(item.get("explicit_lyrics")),
        "type": "track",
    }


def _deezer_album(item: dict, artist: dict | None = None) -> dict:
    """Map one Deezer album object to the shape the app passes around.

    `/artist/{id}/albums` omits the artist on every row (it is implied by the
    endpoint), so that caller passes the artist in rather than shipping albums
    with an empty byline.
    """
    own = item.get("artist", {})
    return {
        "id": str(item["id"]),
        "name": item.get("title", ""),
        "artist": own.get("name", "") or (artist or {}).get("name", ""),
        "artist_id": str(own.get("id", "") or (artist or {}).get("id", "")),
        "year": (item.get("release_date", "") or "")[:4],
        "image": item.get("cover_big", ""),
        "url": item.get("link", ""),
        "total_tracks": item.get("nb_tracks", 0),
        "fans": item.get("fans", 0),
        "record_type": item.get("record_type", ""),
        "explicit": bool(item.get("explicit_lyrics")),
        "type": "album",
    }


async def deezer_search(query: str, search_type: str = "track", limit: int = 20, offset: int = 0) -> list[dict]:
    type_map = {"track": "search", "album": "search/album", "artist": "search/artist", "playlist": "search/playlist"}
    endpoint = type_map.get(search_type)
    if not endpoint:
        return []

    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/{endpoint}", params={"q": query, "limit": limit, "index": offset})
        resp.raise_for_status()
        data = resp.json()

    if "error" in data:
        raise RuntimeError(f"Deezer error: {data['error'].get('message', '')}")

    results = []
    for item in data.get("data", []):
        if search_type == "track":
            results.append(_deezer_track(item))
        elif search_type == "album":
            results.append(_deezer_album(item))
        elif search_type == "artist":
            results.append({
                "id": str(item["id"]),
                "name": item.get("name", ""),
                "artist": item.get("name", ""),
                "image": item.get("picture_big", ""),
                "url": item.get("link", ""),
                # Deezer orders artist search by its own relevance, not by size:
                # "Adele" comes back behind "Adèle & Zalem" and the real Queen is
                # fifth. Fan count is how a caller tells them apart.
                "fans": item.get("nb_fan", 0),
                "type": "artist",
            })
        elif search_type == "playlist":
            results.append({
                "id": str(item["id"]),
                "name": item.get("title", ""),
                "artist": item.get("user", {}).get("name", ""),
                "image": item.get("picture_big", ""),
                "url": item.get("link", ""),
                "total_tracks": item.get("nb_tracks", 0),
                "type": "playlist",
            })
    return results


async def deezer_artist_top(artist_id: str, limit: int = 100) -> list[dict]:
    """An artist's own tracks in Deezer's popularity order.

    Includes the ones where they are a guest ("Feel This Moment (feat. Christina
    Aguilera)"), which is what a listener means by an artist's popular songs and
    what Spotify's artist page shows too.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/artist/{artist_id}/top", params={"limit": limit})
        resp.raise_for_status()
        data = resp.json()
    return [_deezer_track(item) for item in data.get("data", [])]


async def deezer_artist_albums_ranked(artist_id: str, artist: dict | None = None) -> list[dict]:
    """An artist's own albums, most popular first.

    Deezer has no top-albums endpoint, and its per-album `fans` counter is too
    thin to stand in for one on a big back catalogue: Queen's "A Night At The
    Opera" reports 2,256 fans where Nirvana's "Nevermind" reports 381,717, so
    sorting Queen by fans alone opens with a 2020 live record. The artist's top
    TRACKS are the better signal — the album a hit sits on is the album people
    play — so albums are ordered by where they first appear among those tracks,
    and the rest of the catalogue falls in behind them by fans. The top tracks
    are already cached, so this costs one request.
    """
    top = await _deezer_artist_top_cached(artist_id)
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/artist/{artist_id}/albums", params={"limit": 100})
        resp.raise_for_status()
        data = resp.json()
    albums = [_deezer_album(item, artist) for item in data.get("data", [])]
    return _rank_albums(albums, top)


def _rank_albums(albums: list[dict], top: list[dict]) -> list[dict]:
    """Order albums by where the artist's hits sit, then by fans."""
    first_hit: dict[str, int] = {}
    for position, track in enumerate(top):
        first_hit.setdefault(track.get("album_id", ""), position)
    return sorted(albums, key=lambda a: (first_hit.get(a["id"], len(top) + 1), -a.get("fans", 0)))


async def deezer_get_track(track_id: str) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/track/{track_id}")
        resp.raise_for_status()
        item = resp.json()
    return {
        "name": item.get("title", ""),
        "artist": item.get("artist", {}).get("name", ""),
        "album": item.get("album", {}).get("title", ""),
        "image": item.get("album", {}).get("cover_big", ""),
    }


async def deezer_get_album_tracks(album_id: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/album/{album_id}")
        resp.raise_for_status()
        data = resp.json()

    album_name = data.get("title", "")
    album_image = data.get("cover_big", "")
    tracks = []
    for item in data.get("tracks", {}).get("data", []):
        tracks.append({
            "name": item.get("title", ""),
            "artist": item.get("artist", {}).get("name", ""),
            "album": album_name,
            "image": album_image,
            "url": item.get("link", ""),
            "duration_ms": (item.get("duration") or 0) * 1000,
            "track_number": item.get("track_position") or (len(tracks) + 1),
            "explicit": bool(item.get("explicit_lyrics")),
        })
    return tracks


async def deezer_get_playlist_tracks(playlist_id: str) -> dict:
    """Get playlist info + tracks. Deezer pages `tracks.data` (~100/page) via `tracks.next`."""
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/playlist/{playlist_id}")
        resp.raise_for_status()
        data = resp.json()

        if "error" in data:
            raise RuntimeError(f"Deezer error: {data['error'].get('message', '')}")

        playlist_name = data.get("title", "")
        playlist_image = data.get("picture_big", "")
        page = data.get("tracks") or {}
        tracks = []
        for _ in range(_PLAYLIST_MAX_PAGES):
            for item in page.get("data", []):
                if len(tracks) >= _PLAYLIST_MAX_TRACKS:
                    break
                album = item.get("album") or {}
                tracks.append({
                    "name": item.get("title", ""),
                    "artist": (item.get("artist") or {}).get("name", ""),
                    "album": album.get("title", ""),
                    "image": album.get("cover_big", "") or playlist_image,
                    "url": item.get("link", ""),
                    "duration_ms": (item.get("duration") or 0) * 1000,
                    "track_number": item.get("track_position") or (len(tracks) + 1),
                    "explicit": bool(item.get("explicit_lyrics")),
                })
            next_url = page.get("next")
            if not next_url or len(tracks) >= _PLAYLIST_MAX_TRACKS:
                break
            await _deezer_limit()
            resp = await client.get(next_url)
            resp.raise_for_status()
            page = resp.json()
    return {"tracks": tracks, "name": playlist_name, "image": playlist_image}


async def deezer_get_artist_albums(artist_id: str) -> dict:
    """Artist info plus their whole catalogue, most popular release first.

    The page used to list albums the way Deezer returns them, which is newest
    first — so an artist opened on a 2023 remix EP instead of the record they
    are known for. Same ranking as the Albums search tab (see _rank_albums).
    """
    async with httpx.AsyncClient(timeout=10) as client:
        # Get artist info
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/artist/{artist_id}")
        resp.raise_for_status()
        artist = resp.json()
        # Get albums with pagination (Deezer returns max 100 per page)
        raw = []
        url = f"{DEEZER_BASE}/artist/{artist_id}/albums"
        params = {"limit": 100}
        while url:
            await _deezer_limit()
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            raw.extend(data.get("data", []))
            url = data.get("next")
            params = {}  # next URL includes all params
    albums = [_deezer_album(item, artist) for item in raw]
    albums = _rank_albums(albums, await _deezer_artist_top_cached(str(artist_id)))
    return {
        "name": artist.get("name", ""),
        "image": artist.get("picture_big", ""),
        "albums": albums,
    }


_GENRE_CACHE_TTL = 86400          # the genre list is effectively static
_GENRE_CHART_TTL = 1800
_genre_list_cache: dict = {}
_genre_chart_cache: dict = {}


async def deezer_genres() -> list[dict]:
    """Deezer's genre list, for the browse tiles on an empty search box.

    Genre 0 ("All") is dropped — it is Deezer's catch-all, not a genre anyone
    would pick off a wall of tiles.
    """
    cached, hit = _cache_get(_genre_list_cache, "genres", _GENRE_CACHE_TTL)
    if hit:
        return cached
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        # Deezer localises genre names by the CALLER's IP, and the app runs on a
        # Czech host: without this header half the wall came back "Taneční
        # hudba", "Alternativní hudba", "Pro děti" next to Pop, Rock and Jazz.
        resp = await client.get(f"{DEEZER_BASE}/genre", headers={"Accept-Language": "en"})
        resp.raise_for_status()
        data = resp.json()
    genres = [
        {"id": str(g["id"]), "name": g.get("name", ""), "image": g.get("picture_medium", "")}
        for g in data.get("data", []) if str(g.get("id")) != "0" and g.get("name")
    ]
    _cache_put(_genre_list_cache, "genres", genres, 64)
    return genres


async def deezer_genre_chart(genre_id: str, limit: int = 20) -> dict:
    """What is big in a genre right now: tracks, albums, artists, playlists."""
    key = f"{genre_id}:{limit}"
    cached, hit = _cache_get(_genre_chart_cache, key, _GENRE_CHART_TTL)
    if hit:
        return cached
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/chart/{genre_id}", params={"limit": limit})
        resp.raise_for_status()
        data = resp.json()
    if "error" in data:
        raise RuntimeError(f"Deezer error: {data['error'].get('message', '')}")

    def _rows(key_name: str) -> list[dict]:
        return (data.get(key_name) or {}).get("data", []) or []

    chart = {
        "tracks": [_deezer_track(t) for t in _rows("tracks")],
        "albums": [_deezer_album(a) for a in _rows("albums")],
        "artists": _chart_artists(_rows("tracks")),
        "playlists": [{
            "id": str(p["id"]), "name": p.get("title", ""),
            "artist": (p.get("user") or {}).get("name", ""),
            "image": p.get("picture_big", ""), "url": p.get("link", ""),
            "total_tracks": p.get("nb_tracks", 0), "type": "playlist",
        } for p in _rows("playlists")],
    }
    _cache_put(_genre_chart_cache, key, chart, 64)
    return chart


def _chart_artists(track_rows: list[dict]) -> list[dict]:
    """The artists behind a genre chart's tracks, in the chart's own order.

    Deezer scopes `/chart/{genre}` properly for tracks and albums but hands back
    its own REGIONAL top for `artists`: measured on Pop, Rock, Rap, Jazz and
    Metal, all ten names were identical to `/chart/0` every time, so "Rock"
    listed Taylor Swift, Yzomandias and a German audiobook channel. The track
    rows are the only genre-true source of artists the endpoint offers.

    Mapped from the RAW rows rather than from `_deezer_track`, because that
    mapper keeps the album cover as `image` — a derived artist card built from
    it would wear a record sleeve instead of a portrait.
    """
    artists, seen = [], set()
    for row in track_rows:
        a = row.get("artist") or {}
        artist_id = str(a.get("id", ""))
        if not artist_id or artist_id in seen:
            continue
        seen.add(artist_id)
        artists.append({
            "id": artist_id, "name": a.get("name", ""), "artist": a.get("name", ""),
            "image": a.get("picture_big", ""), "url": a.get("link", ""),
            "type": "artist",
        })
    return artists


async def deezer_artist_radio(artist_id: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/artist/{artist_id}/radio")
        resp.raise_for_status()
        data = resp.json()
    return [
        {
            "id": str(item["id"]),
            "name": item.get("title", ""),
            "artist": item.get("artist", {}).get("name", ""),
            "album": item.get("album", {}).get("title", ""),
            "image": item.get("album", {}).get("cover_big", ""),
            "url": item.get("link", ""),
            "type": "track",
        }
        for item in data.get("data", [])
    ]


async def deezer_related_artists(artist_id: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/artist/{artist_id}/related")
        resp.raise_for_status()
        data = resp.json()
    return [
        {
            "id": str(item["id"]),
            "name": item.get("name", ""),
            "artist": item.get("name", ""),
            "image": item.get("picture_big", ""),
            "type": "artist",
        }
        for item in data.get("data", [])
    ]


async def deezer_artist_latest_album(artist_id: str) -> dict | None:
    async with httpx.AsyncClient(timeout=10) as client:
        await _deezer_limit()
        resp = await client.get(f"{DEEZER_BASE}/artist/{artist_id}/albums", params={"limit": 1, "order": "date"})
        resp.raise_for_status()
        data = resp.json()
    albums = data.get("data", [])
    if not albums:
        return None
    a = albums[0]
    return {
        "id": str(a["id"]),
        "name": a.get("title", ""),
        "release_date": a.get("release_date", ""),
    }


def parse_deezer_url(url: str) -> tuple[str, str] | None:
    m = re.search(r"deezer\.com/(track|album|playlist|artist)/(\d+)", url)
    if m:
        return m.group(1), m.group(2)
    return None


# ── YouTube Music ──

def _ytmusic_search_sync(query: str, search_type: str, limit: int) -> list[dict]:
    yt = _get_ytmusic()
    filter_map = {"track": "songs", "album": "albums", "artist": "artists", "playlist": "playlists"}
    yt_filter = filter_map.get(search_type)
    if not yt_filter:
        return []

    raw = yt.search(query, filter=yt_filter, limit=limit)
    results = []
    for item in raw:
        if search_type == "track":
            results.append({
                "id": item.get("videoId", ""),
                "name": item.get("title", ""),
                "artist": ", ".join(a.get("name", "") for a in item.get("artists", [])),
                "album": (item.get("album") or {}).get("name", ""),
                "year": "",
                "image": (item.get("thumbnails") or [{}])[-1].get("url", ""),
                "url": f"https://music.youtube.com/watch?v={item.get('videoId', '')}",
                "duration_ms": (item.get("duration_seconds") or 0) * 1000,
                "type": "track",
            })
        elif search_type == "album":
            results.append({
                "id": item.get("browseId", ""),
                "name": item.get("title", ""),
                "artist": ", ".join(a.get("name", "") for a in item.get("artists", [])),
                "year": item.get("year", ""),
                "image": (item.get("thumbnails") or [{}])[-1].get("url", ""),
                "url": "",
                "total_tracks": 0,
                "type": "album",
            })
        elif search_type == "artist":
            results.append({
                "id": item.get("browseId", ""),
                "name": item.get("artist", ""),
                "artist": item.get("artist", ""),
                "image": (item.get("thumbnails") or [{}])[-1].get("url", ""),
                "url": "",
                "type": "artist",
            })
        elif search_type == "playlist":
            results.append({
                "id": item.get("browseId", ""),
                "name": item.get("title", ""),
                "artist": item.get("author", ""),
                "image": (item.get("thumbnails") or [{}])[-1].get("url", ""),
                "url": "",
                "total_tracks": 0,
                "type": "playlist",
            })
    return results


async def ytmusic_search(query: str, search_type: str = "track", limit: int = 20) -> list[dict]:
    return await asyncio.to_thread(_ytmusic_search_sync, query, search_type, limit)


def _ytmusic_playlist_tracks_sync(playlist_id: str) -> dict:
    """Best-effort playlist fetch. ytmusicapi shapes vary, so read everything defensively."""
    try:
        yt = _get_ytmusic()
        data = yt.get_playlist(playlist_id, limit=_PLAYLIST_MAX_TRACKS) or {}
    except Exception as e:
        # Do NOT swallow into an empty result: a caller rendering "0 tracks" for a
        # playlist that actually has tracks is the exact bug this endpoint fixes.
        logger.warning(f"ytmusic playlist {playlist_id} failed: {e}")
        raise RuntimeError(f"YouTube Music playlist fetch failed: {e}") from e

    playlist_name = data.get("title", "") or ""
    playlist_image = ((data.get("thumbnails") or [{}])[-1] or {}).get("url", "")
    tracks = []
    for item in (data.get("tracks") or []):
        if not isinstance(item, dict):
            continue
        album = item.get("album") or {}
        if not isinstance(album, dict):
            album = {}
        video_id = item.get("videoId", "") or ""
        tracks.append({
            "name": item.get("title", "") or "",
            "artist": ", ".join((a or {}).get("name", "") for a in (item.get("artists") or [])),
            "album": album.get("name", "") or "",
            "image": ((item.get("thumbnails") or [{}])[-1] or {}).get("url", "") or playlist_image,
            "url": f"https://music.youtube.com/watch?v={video_id}" if video_id else "",
            "duration_ms": (item.get("duration_seconds") or 0) * 1000,
            "track_number": len(tracks) + 1,
        })
    return {"tracks": tracks, "name": playlist_name, "image": playlist_image}


async def ytmusic_get_playlist_tracks(playlist_id: str) -> dict:
    return await asyncio.to_thread(_ytmusic_playlist_tracks_sync, playlist_id)


# ── iTunes / Apple Music ──

def _itunes_artwork(url: str, size: int = 600) -> str:
    """Scale iTunes artwork URL to desired size."""
    if not url:
        return ""
    return re.sub(r'/\d+x\d+bb\.', f'/{size}x{size}bb.', url)


async def itunes_search(query: str, search_type: str = "track", limit: int = 20) -> list[dict]:
    entity_map = {
        "track": "song", "album": "album", "artist": "musicArtist",
        "show": "podcast", "episode": "podcastEpisode",
    }
    entity = entity_map.get(search_type)
    if not entity:
        return []

    media = "podcast" if search_type in ("show", "episode") else "music"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{ITUNES_BASE}/search", params={
            "term": query, "media": media, "entity": entity, "limit": limit,
            "country": ITUNES_COUNTRY,
        })
        resp.raise_for_status()
        data = resp.json()

    results = []
    for item in data.get("results", []):
        if search_type == "track":
            results.append({
                "id": str(item.get("trackId", "")),
                "name": item.get("trackName", ""),
                "artist": item.get("artistName", ""),
                "album": item.get("collectionName", ""),
                "year": (item.get("releaseDate", "") or "")[:4],
                "image": _itunes_artwork(item.get("artworkUrl100", "")),
                "url": item.get("trackViewUrl", ""),
                "duration_ms": item.get("trackTimeMillis", 0),
                "explicit": item.get("trackExplicitness") == "explicit",
                "type": "track",
            })
        elif search_type == "album":
            results.append({
                "id": str(item.get("collectionId", "")),
                "name": item.get("collectionName", ""),
                "artist": item.get("artistName", ""),
                "year": (item.get("releaseDate", "") or "")[:4],
                "image": _itunes_artwork(item.get("artworkUrl100", "")),
                "url": item.get("collectionViewUrl", ""),
                "total_tracks": item.get("trackCount", 0),
                "explicit": item.get("collectionExplicitness") == "explicit",
                "type": "album",
            })
        elif search_type == "artist":
            results.append({
                "id": str(item.get("artistId", "")),
                "name": item.get("artistName", ""),
                "artist": item.get("artistName", ""),
                "image": "",
                "url": item.get("artistLinkUrl", ""),
                "type": "artist",
            })
        elif search_type == "show":
            results.append({
                "id": str(item.get("collectionId", "")),
                "name": item.get("collectionName", ""),
                "artist": item.get("artistName", ""),
                "image": _itunes_artwork(item.get("artworkUrl100", "")),
                "url": item.get("collectionViewUrl", ""),
                "total_tracks": item.get("trackCount", 0),
                "type": "show",
                "description": (item.get("description", "") or "")[:200],
                "feed_url": item.get("feedUrl", ""),
            })
        elif search_type == "episode":
            results.append({
                "id": str(item.get("trackId", "")),
                "name": item.get("trackName", ""),
                "artist": item.get("collectionName", ""),
                "image": _itunes_artwork(item.get("artworkUrl100", "")),
                "url": item.get("trackViewUrl", ""),
                "duration_ms": item.get("trackTimeMillis", 0),
                "release_date": (item.get("releaseDate", "") or "")[:10],
                "type": "episode",
                "show_id": str(item.get("collectionId", "")),
                "description": (item.get("description", "") or "")[:200],
            })
    return results


async def itunes_get_artist_albums(artist_id: str) -> dict:
    """Get all albums for an iTunes artist."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{ITUNES_BASE}/lookup", params={
            "id": artist_id, "entity": "album", "limit": 200,
        })
        resp.raise_for_status()
        data = resp.json()

    artist_name = ""
    artist_image = ""
    albums = []
    for item in data.get("results", []):
        if item.get("wrapperType") == "artist":
            artist_name = item.get("artistName", "")
            continue
        if item.get("wrapperType") != "collection":
            continue
        albums.append({
            "id": str(item.get("collectionId", "")),
            "name": item.get("collectionName", ""),
            "artist": item.get("artistName", artist_name),
            "image": _itunes_artwork(item.get("artworkUrl100", "")),
            "url": item.get("collectionViewUrl", ""),
            "total_tracks": item.get("trackCount", 0),
            "release_date": (item.get("releaseDate", "") or "")[:10],
            "type": "album",
        })
    return {
        "name": artist_name,
        "image": _itunes_artwork(albums[0].get("image", "")) if albums else "",
        "albums": albums,
    }


async def itunes_get_album_tracks(album_id: str) -> list[dict]:
    """Get all tracks for an iTunes album."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{ITUNES_BASE}/lookup", params={
            "id": album_id, "entity": "song", "limit": 200,
        })
        resp.raise_for_status()
        data = resp.json()

    album_name = ""
    album_image = ""
    tracks = []
    for item in data.get("results", []):
        if item.get("wrapperType") == "collection":
            album_name = item.get("collectionName", "")
            album_image = _itunes_artwork(item.get("artworkUrl100", ""))
            continue
        if item.get("wrapperType") != "track":
            continue
        tracks.append({
            "name": item.get("trackName", ""),
            "artist": item.get("artistName", ""),
            "album": album_name,
            "image": album_image,
            "url": item.get("trackViewUrl", ""),
            "duration_ms": item.get("trackTimeMillis") or 0,
            "track_number": item.get("trackNumber") or (len(tracks) + 1),
        })
    return tracks


async def itunes_artist_latest_album(artist_id: str) -> dict | None:
    """Get the latest album from an iTunes artist."""
    data = await itunes_get_artist_albums(artist_id)
    albums = data.get("albums", [])
    if not albums:
        return None
    # Sort by release_date descending, pick newest
    albums.sort(key=lambda a: a.get("release_date", ""), reverse=True)
    a = albums[0]
    return {
        "id": a["id"],
        "name": a["name"],
        "release_date": a.get("release_date", ""),
    }


async def itunes_get_show_episodes(show_id: str) -> dict:
    """Get show info and episode list via iTunes lookup + RSS feed."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{ITUNES_BASE}/lookup", params={"id": show_id, "entity": "podcast"})
        resp.raise_for_status()
        data = resp.json()

    results = data.get("results", [])
    if not results:
        raise RuntimeError(f"Show {show_id} not found")

    show = results[0]
    show_name = show.get("collectionName", "")
    show_image = _itunes_artwork(show.get("artworkUrl100", ""))
    publisher = show.get("artistName", "")
    feed_url = show.get("feedUrl", "")

    if not feed_url:
        return {"name": show_name, "image": show_image, "publisher": publisher, "episodes": [], "feed_url": ""}

    episodes = await parse_podcast_rss(feed_url, show_name, show_image)

    return {
        "name": show_name,
        "image": show_image,
        "publisher": publisher,
        "episodes": episodes,
        "feed_url": feed_url,
    }


async def parse_podcast_rss(feed_url: str, show_name: str = "", show_image: str = "") -> list[dict]:
    """Parse podcast RSS feed and return episodes in our format."""
    headers = {"User-Agent": "MusicSeeker/1.0 (Podcast RSS Reader)"}
    async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=headers) as client:
        resp = await client.get(feed_url)
        resp.raise_for_status()

    # RSS feeds often contain HTML entities that XML parser can't handle
    text = resp.text
    # Replace common undefined HTML entities
    text = re.sub(r'&(?!amp;|lt;|gt;|apos;|quot;|#\d+;|#x[0-9a-fA-F]+;)(\w+);', r'&amp;\1;', text)

    root = ET.fromstring(text)
    channel = root.find("channel")
    if channel is None:
        return []

    itunes_ns = "http://www.itunes.com/dtds/podcast-1.0.dtd"

    if not show_name:
        show_name = channel.findtext("title") or ""
    if not show_image:
        ch_img = channel.find(f"{{{itunes_ns}}}image")
        if ch_img is not None and ch_img.get("href"):
            show_image = ch_img.get("href")

    episodes = []
    for item in channel.findall("item"):
        title = (item.findtext("title") or "").strip()
        if not title:
            continue

        ep_image = show_image
        itunes_img = item.find(f"{{{itunes_ns}}}image")
        if itunes_img is not None and itunes_img.get("href"):
            ep_image = itunes_img.get("href")

        duration_text = item.findtext(f"{{{itunes_ns}}}duration") or ""
        duration_ms = _parse_duration(duration_text)

        enclosure = item.find("enclosure")
        url = enclosure.get("url", "") if enclosure is not None else ""
        if not url:
            url = item.findtext("link") or ""

        pub_date = item.findtext("pubDate") or ""
        description = item.findtext("description") or item.findtext(f"{{{itunes_ns}}}summary") or ""

        episodes.append({
            "id": title,
            "name": title,
            "artist": show_name,
            "album": show_name,
            "image": ep_image,
            "url": url,
            "duration_ms": duration_ms,
            "release_date": pub_date,
            "type": "episode",
            "description": description[:200],
        })

    return episodes


def _parse_duration(text: str) -> int:
    """Parse iTunes duration (seconds or HH:MM:SS) to milliseconds."""
    if not text:
        return 0
    text = text.strip()
    if text.isdigit():
        return int(text) * 1000
    parts = text.split(":")
    try:
        if len(parts) == 3:
            return (int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])) * 1000
        elif len(parts) == 2:
            return (int(parts[0]) * 60 + int(parts[1])) * 1000
    except ValueError:
        pass
    return 0


# ── Unified search ──

async def _spotify_search(query: str, search_type: str, limit: int, offset: int) -> list[dict]:
    from app.services import spotify
    return await spotify.search(query, search_type, limit, offset)


# Canonical provider keys. "apple" (the settings/UI value) is an alias of "itunes".
_PROVIDER_ALIASES = {"apple": "itunes"}

_SEARCH_FUNCS = {
    "deezer": deezer_search,
    "ytmusic": ytmusic_search,
    "itunes": itunes_search,
    "spotify": _spotify_search,
}

# Providers whose search function accepts an `offset` argument
_OFFSET_CAPABLE = {"deezer", "spotify"}

# Default fallback when user doesn't pick one
_DEFAULT_FALLBACK = {
    "deezer": "ytmusic",
    "ytmusic": "deezer",
    "itunes": "deezer",
    "spotify": "",
}


def _canonical_provider(name: str) -> str:
    """Map provider aliases (e.g. the UI's "apple") to the canonical key."""
    name = (name or "").strip().lower()
    return _PROVIDER_ALIASES.get(name, name)


class ProviderError(RuntimeError):
    """Every provider leg failed with an error (distinct from 'no results')."""


async def _try_provider(name: str, query: str, search_type: str, limit: int, offset: int) -> list[dict] | None:
    """Try a single provider, return results (provider-stamped) or None."""
    name = _canonical_provider(name)
    func = _SEARCH_FUNCS.get(name)
    if not func:
        return None
    if name in _OFFSET_CAPABLE:
        results = await func(query, search_type, limit, offset)
    else:
        results = await func(query, search_type, limit)
    for item in results or []:
        item["provider"] = name
    return results


# ── Popularity ordering for artist-name queries ───────────────────────
# Deezer's text search is relevance-ranked, and for a bare artist name that is
# not the same as "their best songs": searching "Christina Aguilera" opened with
# Maroon 5's "Moves Like Jagger" and "Nirvana" put a Kerchak song titled
# "Nirvana" above "Lithium". When the query really is an artist's name, their own
# most-played tracks are what was meant, so those go first and the ordinary
# relevance results follow behind them.
_ARTIST_CACHE_TTL = 1800          # 30 min — popularity moves slowly
_ARTIST_CACHE_MAX = 256
_artist_by_name_cache: dict[str, tuple[dict | None, float]] = {}
_artist_top_cache: dict[str, tuple[list[dict], float]] = {}
_artist_albums_cache: dict[str, tuple[list[dict], float]] = {}

# How much of the ordinary result page must already belong to the artist before
# we accept the query as their name. Song titles that are also artist names
# score 0-1 of 10 ("Creep", "Hurt", "Yesterday", "Bohemian Rhapsody" all have a
# namesake band), while real artist queries score 7-10, so the gap is wide and
# the threshold is not delicate.
_ARTIST_DOMINANCE_MIN = 3
_ARTIST_DOMINANCE_SAMPLE = 10


# What a joined credit is actually joined with. Measured over 839 credits from
# the live Deezer, iTunes and YouTube Music pages of eighteen queries
# (`scratchpad/autor3-5-c6/sonda-credity.txt`): a comma and " & " are the only
# two that ever appear. " feat. ", " ft. ", " x ", " with ", " and " and " vs "
# appear zero times, because all three providers keep the guest inside the
# TITLE ("Dresscode (feat. Yzomandias)") and out of the credit — so splitting on
# them would only be a guess that can cut a name in half.
_CREDIT_JOINERS = re.compile(r",|\s&\s")


def _credit_names(credit: str) -> list[str]:
    """Every artist a joined credit may stand for: each part of it, and the whole.

    The whole has to stay in, because both joiners are also part of some names
    ("Earth, Wind & Fire", "Crosby, Stills & Nash"); splitting alone would turn
    those into performers who do not exist and lose the one who does.
    """
    return [_normalize(credit)] + [_normalize(p) for p in _CREDIT_JOINERS.split(credit)]


def _artist_owns(artist: dict, rows: list[dict]) -> int:
    """How many of these rows are credited to this artist.

    Matching falls back to the name because only Deezer stamps `artist_id` on a
    row; iTunes and YouTube Music publish the credit as text only. Both of them
    join several performers into one string — "Queen, David Bowie" on YouTube
    Music, "Żabson & Yzomandias" on iTunes — so the credit is read as a list as
    well as whole.
    """
    name = _normalize(artist.get("name", ""))
    artist_id = str(artist.get("id", ""))
    hits = 0
    for row in rows:
        row_id = str(row.get("artist_id", ""))
        credit = str(row.get("artist", ""))
        if artist_id and row_id and row_id == artist_id:
            hits += 1
        elif name and name in _credit_names(credit):
            hits += 1
    return hits


def _artist_owns_enough(artist: dict, rows: list[dict]) -> bool:
    """Is this page already mostly the artist's own work?

    The question an exact name match cannot answer on its own: somebody on
    Deezer is named after almost every famous song, so "Creep" matches a band
    as well as the Radiohead track.
    """
    return _artist_owns(artist, rows) >= min(_ARTIST_DOMINANCE_MIN, len(rows))


def _cache_get(store: dict, key: str, ttl: float):
    """(value, True) on a live hit, (None, False) otherwise."""
    hit = store.get(key)
    if hit and time.time() - hit[1] < ttl:
        return hit[0], True
    return None, False


def _cache_put(store: dict, key: str, value, max_entries: int) -> None:
    store.pop(key, None)
    if len(store) >= max_entries:
        store.pop(next(iter(store)), None)  # dicts keep insertion order: oldest first
    store[key] = (value, time.time())


async def _deezer_artist_by_name(query: str) -> dict | None:
    """The artist whose name IS this query, or None.

    Two traps here. Deezer's artist search is not ordered by how big the artist
    is — "Adele" comes back behind "Adèle & Zalem" and the real Queen is the
    fifth of five — so neither "first result" nor a short list is safe: take
    every exact name match from a wide page and keep the one with the most fans.
    The match must be exact, because a near match is how a song title ("Hurt")
    quietly turns into a 93-fan band of the same name.
    """
    norm = _normalize(query)
    if not norm:
        return None
    cached, found = _cache_get(_artist_by_name_cache, norm, _ARTIST_CACHE_TTL)
    if found:
        return cached
    artists = await deezer_search(query, "artist", 15, 0)
    exact = [a for a in artists if _normalize(a.get("name", "")) == norm]
    best = max(exact, key=lambda a: a.get("fans", 0)) if exact else None
    _cache_put(_artist_by_name_cache, norm, best, _ARTIST_CACHE_MAX)
    return best


async def _deezer_artist_top_cached(artist_id: str) -> list[dict]:
    cached, found = _cache_get(_artist_top_cache, artist_id, _ARTIST_CACHE_TTL)
    if found:
        return cached
    tracks = await deezer_artist_top(artist_id)
    _cache_put(_artist_top_cache, artist_id, tracks, _ARTIST_CACHE_MAX)
    return tracks


async def _deezer_artist_albums_cached(artist_id: str, artist: dict | None = None) -> list[dict]:
    cached, found = _cache_get(_artist_albums_cache, artist_id, _ARTIST_CACHE_TTL)
    if found:
        return cached
    albums = await deezer_artist_albums_ranked(artist_id, artist)
    _cache_put(_artist_albums_cache, artist_id, albums, _ARTIST_CACHE_MAX)
    return albums


async def _deezer_artists_by_size(query: str, limit: int, offset: int) -> list[dict] | None:
    """Pull the artists actually CALLED this to the front, biggest first.

    Deezer's artist search is relevance-ordered and relevance does not know who
    anyone is: "Nirvana" returns the 1960s UK band of 259 fans ahead of the one
    with ten million. Only exact name matches are promoted, so a query that is
    not somebody's name keeps Deezer's own order and nothing is dropped.
    """
    window = min(100, max(offset + limit, 10))
    plain = await deezer_search(query, "artist", window, 0)
    if not plain:
        return None
    target = _normalize(query)
    named = [a for a in plain if _normalize(a.get("name", "")) == target]
    if not named or (named[0] is plain[0] and len(named) == 1):
        return None  # already on top, or nobody goes by this name
    named.sort(key=lambda a: -a.get("fans", 0))
    rest = [a for a in plain if _normalize(a.get("name", "")) != target]
    return (named + rest)[offset:offset + limit]


async def _deezer_popular_first(query: str, search_type: str, limit: int, offset: int) -> list[dict] | None:
    """One page of "their popular work first", or None if this isn't an artist.

    None means "not an artist query, use the ordinary search"; an empty list
    means "it is, and this page is past the end" — the caller must tell those
    apart or pagination runs on into duplicates of the head.

    Paging stays honest by rebuilding the same merged list on every request and
    slicing it, rather than stitching two independently paginated sources
    together at an offset neither of them knows about. That costs one search
    window per page (capped at Deezer's 100) and keeps the artist lookup and the
    top tracks on the cache.
    """
    # The window is also the dominance sample, so never fetch fewer than the
    # sample size: the All tab asks for 5 tracks a type, and judging an artist on
    # 5 rows let two guest appearances outvote them.
    if search_type == "artist":
        return await _deezer_artists_by_size(query, limit, offset)
    if search_type not in ("track", "album"):
        return None
    window = min(100, max(offset + limit, _ARTIST_DOMINANCE_SAMPLE))
    plain, artist = await asyncio.gather(
        deezer_search(query, search_type, window, 0),
        _deezer_artist_by_name(query),
    )
    if not plain or not artist:
        return None

    # The name matching above is exact but still blind: "Creep" is a real band
    # as well as the Radiohead song. Asking whether the ordinary results are
    # already mostly this artist is what tells the two apart.
    if not _artist_owns_enough(artist, plain[:_ARTIST_DOMINANCE_SAMPLE]):
        return None

    head = (await _deezer_artist_top_cached(artist["id"]) if search_type == "track"
            else await _deezer_artist_albums_cached(artist["id"], artist))
    if not head:
        return None
    seen = {t["id"] for t in head}
    merged = head + [t for t in plain if t["id"] not in seen]
    return merged[offset:offset + limit]


async def search(query: str, search_type: str = "track", limit: int = 20, offset: int = 0,
                 provider: str = "deezer", fallback: str = "", raise_on_error: bool = False,
                 popular_first: bool = False) -> list[dict]:
    """Search with the specified provider, falling back if needed.

    With raise_on_error=True, a ProviderError is raised when every attempted leg
    errored out, so callers can tell an outage from a legitimately empty result.

    popular_first asks for an artist-name query to lead with that artist's most
    popular tracks or albums. It is opt-in because it is only right for a search
    box: a caller resolving one known track wants relevance, not a popularity
    list. Only Deezer implements it; other providers expose no equivalent
    endpoint and are served unchanged.
    """
    provider = _canonical_provider(provider)

    if popular_first and search_type in ("track", "album", "artist") and provider == "deezer":
        try:
            ranked = await _deezer_popular_first(query, search_type, limit, offset)
            if ranked is not None:
                for item in ranked:
                    item["provider"] = "deezer"
                return ranked
        except Exception as e:
            # Never let the nicety break the search it was decorating.
            logger.warning(f"popularity ordering failed, using plain search: {e}")

    if fallback == "none":
        fallback = ""
    elif not fallback:
        fallback = _DEFAULT_FALLBACK.get(provider, "")
    fallback = _canonical_provider(fallback)

    attempted = 0
    failed = []

    # Primary
    attempted += 1
    try:
        results = await _try_provider(provider, query, search_type, limit, offset)
        if results:
            return results
    except Exception as e:
        logger.warning(f"{provider} search failed: {e}")
        failed.append(f"{provider}: {e}")

    # Fallback
    if fallback and fallback != provider:
        attempted += 1
        try:
            results = await _try_provider(fallback, query, search_type, limit, offset)
            if results:
                return results
        except Exception as e:
            logger.warning(f"{fallback} fallback failed: {e}")
            failed.append(f"{fallback}: {e}")

    if raise_on_error and len(failed) == attempted:
        raise ProviderError("; ".join(failed))

    return []


async def resolve(name: str, artist: str, item_type: str = "track", provider: str = "deezer", fallback: str = "") -> dict | None:
    """Resolve a track/album by name+artist. Used by discover."""
    query = f"{artist} {name}" if artist else name
    results = await search(query, item_type, 1, provider=provider, fallback=fallback)
    return results[0] if results else None


def _normalize(name: str) -> str:
    """Normalize artist/album name for comparison: lowercase, fold diacritics, collapse whitespace.

    Only combining marks are dropped (José->jose, Černý->cerny); non-Latin scripts survive
    verbatim, so mixed-script names ("水星記 (Live)" vs "ヨルシカ (Live)") stay distinct instead
    of both collapsing to "(live)" and comparing equal.
    """
    s = name.strip().lower()
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    return re.sub(r'\s+', ' ', s).strip()


def _pick_top_result(query: str, tracks: list[dict], artists: list[dict],
                     albums: list[dict], playlists: list[dict]) -> dict | None:
    """Pick the single best 'top result' across all result types (Spotify-style).

    An exact name match is not enough on its own — somebody is named after
    almost every famous song — but how big the namesake is cannot decide it
    either. Measured on Deezer: the artists Lukáš actually searches for sit at
    Portishead 584 k, Khruangbin 99 k and every Czech act far below that
    (Chinaski 17 728, Olympic 5 071, Kryptor 148), so any absolute fan count
    that clears "Creep" (4 020) takes the artist card away from them as well.
    Two of the providers do not publish a fan count at all.

    What separates the two cases is how much of the page the artist already
    owns: measured over the tracks and albums of sixteen artist queries and ten
    song titles, the artist queries score 3-16 of 16 and the song titles 0-1.
    Only the head of each list is read, because `limit_per_type` goes up to 20
    and the deep rows are relevance sweepings: asking for 20 a type put five
    rows of the 8 076-fan band "Hurt" on the page and handed them the card.
    """
    norm = _normalize(query)
    head = tracks[:_ARTIST_DOMINANCE_SAMPLE] + albums[:_ARTIST_DOMINANCE_SAMPLE]
    # Deezer's relevance order is not size order, so take the biggest namesake
    # rather than the first one listed. Where no provider publishes `fans` this
    # falls back to the first exact match, which is what it always was.
    named = max((a for a in artists if _normalize(a.get("name", "")) == norm),
                key=lambda a: a.get("fans", 0), default=None)
    # (1) exact artist name match, when the page is already mostly their work
    if named is not None and _artist_owns_enough(named, head):
        return named
    # (2) exact track/album name match (prefer track)
    for t in tracks:
        if _normalize(t.get("name", "")) == norm:
            return t
    for al in albums:
        if _normalize(al.get("name", "")) == norm:
            return al
    # (3)-(6) first available, tracks first
    if tracks:
        return tracks[0]
    # A small namesake is still better than an artist nobody asked for.
    if named is not None:
        return named
    if artists:
        return artists[0]
    if albums:
        return albums[0]
    if playlists:
        return playlists[0]
    # (7)
    return None


async def search_all(query: str, provider: str = "deezer", fallback: str = "",
                     limit_per_type: int = 8) -> dict:
    """Run track/artist/album/playlist searches concurrently and aggregate (Spotify-style)."""
    types = ("track", "artist", "album", "playlist")
    gathered = asyncio.gather(
        *(search(query, t, limit_per_type, provider=provider, fallback=fallback,
                 raise_on_error=True, popular_first=(t in ("track", "album", "artist")))
          for t in types),
        return_exceptions=True,
    )
    try:
        results = await asyncio.wait_for(gathered, timeout=_SEARCH_ALL_TIMEOUT)
    except (asyncio.TimeoutError, TimeoutError):
        logger.warning(f"search_all timed out after {_SEARCH_ALL_TIMEOUT}s (provider={provider})")
        results = [None] * len(types)

    buckets = {}
    errors = {}
    for search_type, r in zip(types, results):
        if isinstance(r, list):
            buckets[search_type] = r
        else:
            buckets[search_type] = []
            errors[search_type] = "timeout" if r is None else "provider_unavailable"

    tracks, artists, albums, playlists = (buckets[t] for t in types)
    top = _pick_top_result(query, tracks, artists, albums, playlists)
    response = {
        "query": query,
        "top": top,
        "tracks": tracks,
        "artists": artists,
        "albums": albums,
        "playlists": playlists,
    }
    if errors:
        response["errors"] = errors
    return response


async def find_artist_by_name(name: str, provider: str = "deezer") -> dict | None:
    """Search for an artist by name and return best exact/near-exact match.
    Returns dict with id, name, image or None if no good match."""
    results = await search(name, "artist", limit=5, provider=provider, fallback="")
    if not results:
        return None
    norm = _normalize(name)
    # Exact match first
    for r in results:
        if _normalize(r["name"]) == norm:
            return r
    # First result as fallback (top search result is usually correct)
    top = results[0]
    if norm in _normalize(top["name"]) or _normalize(top["name"]) in norm:
        return top
    return None


# ── Provider-aware artist/album functions ──

async def get_artist_albums(artist_id: str, provider: str = "deezer") -> dict:
    """Get artist albums using the appropriate provider."""
    if _canonical_provider(provider) == "itunes":
        return await itunes_get_artist_albums(artist_id)
    return await deezer_get_artist_albums(artist_id)


async def get_artist_top(artist_id: str, provider: str = "deezer", limit: int = 20) -> list[dict]:
    """An artist's most popular tracks. Only Deezer publishes such a list;
    the other providers have no equivalent, so their artist page just has none.
    """
    if _canonical_provider(provider) != "deezer":
        return []
    return (await _deezer_artist_top_cached(str(artist_id)))[:limit]


async def get_album_tracks(album_id: str, provider: str = "deezer") -> list[dict]:
    """Get album tracks using the appropriate provider."""
    if _canonical_provider(provider) == "itunes":
        return await itunes_get_album_tracks(album_id)
    return await deezer_get_album_tracks(album_id)


async def get_playlist_tracks(playlist_id: str, provider: str = "deezer", creds: dict | None = None) -> dict:
    """Get playlist tracks using the appropriate provider.

    Returns {"tracks": [...], "name": str, "image": str}. iTunes has no playlist
    entity, so it yields an empty result instead of hitting the wrong API.

    `creds` are the CALLER's Spotify credentials; they must be threaded through so
    this route reads the same account as /api/spotify/playlist/{id}/tracks rather
    than always falling back to the server-configured one.
    """
    provider = _canonical_provider(provider)
    if provider == "itunes":
        return {"tracks": [], "name": "", "image": ""}
    if provider == "spotify":
        from app.services import spotify
        data = await spotify.get_playlist_tracks(playlist_id, creds=creds)
        tracks = []
        for t in data.get("tracks", []):
            tracks.append({
                "name": t.get("name", ""),
                "artist": t.get("artist", ""),
                "album": t.get("album", ""),
                "image": t.get("image", "") or data.get("image", ""),
                "url": t.get("url", ""),
                "duration_ms": t.get("duration_ms", 0),
                "track_number": len(tracks) + 1,
            })
        return {"tracks": tracks, "name": data.get("name", ""), "image": data.get("image", "")}
    if provider == "ytmusic":
        return await ytmusic_get_playlist_tracks(playlist_id)
    return await deezer_get_playlist_tracks(playlist_id)


async def artist_latest_album(artist_id: str, provider: str = "deezer") -> dict | None:
    """Get latest album from an artist using the appropriate provider."""
    if _canonical_provider(provider) == "itunes":
        return await itunes_artist_latest_album(artist_id)
    return await deezer_artist_latest_album(artist_id)


# ── Cover art for rows that came without any ─────────────────────────
# Last.fm no longer serves real images for tracks and artists: every one is the
# grey-star placeholder, which `lastfm._pick_image` drops. So a Discover page of
# tracks or artists arrived with no art at all (GitHub #9; measured 2026-11-19 on
# "zouk": 0 of 20 tracks, 0 of 20 artists, 16 of 20 albums). The detail view never
# had the problem because it resolves through Deezer — this does the same, per row.
#
# A wrong cover is worse than none, so a hit counts only when Deezer credits it to
# the same artist. Misses are remembered too, or every scroll would ask again.
_ART_CACHE_TTL = 6 * 3600
_ART_CACHE_MAX = 2000
_ART_CONCURRENCY = 6
_ART_BUDGET_S = 4.0
_art_cache: dict[str, tuple[str, float]] = {}


def _same_artist(wanted: str, credit: str) -> bool:
    want = _normalize(wanted)
    return bool(want) and want in _credit_names(credit)


def _bare_title(title: str) -> str:
    """The title without a trailing version note: "(Live)", "[Remastered]", "- Live 1991"."""
    t = _normalize(title)
    t = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]\s*$", "", t)
    t = re.sub(r"\s+-\s+.*$", "", t)
    return t.strip()


def _closest_title(name: str, rows: list[dict]) -> str:
    """The image of the row that is this title, or this title in another version.

    "Same artist" alone is not enough: an artist's other album has a cover too,
    and it would be a confident wrong answer. So the exact title first, then the
    same bare title ("Siwo" for "Siwo (Live)", either way round), else nothing.
    """
    want = _normalize(name)
    for r in rows:
        if _normalize(r.get("name", "")) == want:
            return r["image"]
    bare = _bare_title(name)
    if bare:
        for r in rows:
            if _bare_title(r.get("name", "")) == bare:
                return r["image"]
    return ""


async def _art_for(item: dict) -> str:
    kind = item.get("type", "track")
    name = (item.get("name") or "").strip()
    artist = (item.get("artist") or "").strip()
    if not name:
        return ""
    key = f"{kind}|{_normalize(artist)}|{_normalize(name)}"
    cached, found = _cache_get(_art_cache, key, _ART_CACHE_TTL)
    if found:
        return cached
    image = ""
    try:
        if kind == "artist":
            hit = await _deezer_artist_by_name(name)
            image = (hit or {}).get("image", "")
        elif kind in ("track", "album") and artist:
            # A plain query: Deezer's advanced form (artist:"…" track:"…") answered
            # nothing at all for tracks when measured. The exact title wins over a
            # remix of it; any row of the same artist is better than no cover.
            rows = [r for r in await deezer_search(f"{artist} {name}", kind, 10, 0)
                    if r.get("image") and _same_artist(artist, r.get("artist", ""))]
            image = _closest_title(name, rows)
    except Exception as e:  # a Deezer hiccup must not cost the page its rows
        logger.debug("cover lookup failed for %s: %s", key, e)
        return ""  # not cached: the next page view may get through
    _cache_put(_art_cache, key, image, _ART_CACHE_MAX)
    return image


async def fill_missing_art(items: list[dict]) -> None:
    """Give every row without an image the Deezer cover of the same thing, in place.

    Bounded twice: at most `_ART_CONCURRENCY` lookups at a time (all of them also
    queue behind the shared Deezer token bucket) and `_ART_BUDGET_S` in total.
    Rows still unresolved by then go out without art rather than holding the
    page; their lookups finish in the background only to fill the cache, so the
    next view of the page has them. If the request itself is cancelled (the
    client went away), the lookups are cancelled with it.
    """
    todo = [it for it in items if not it.get("image")]
    if not todo:
        return
    sem = asyncio.Semaphore(_ART_CONCURRENCY)
    answered = False

    async def one(it: dict) -> None:
        async with sem:
            img = await _art_for(it)
        if img and not answered and not it.get("image"):
            it["image"] = img

    tasks = [asyncio.ensure_future(one(it)) for it in todo]
    try:
        await asyncio.wait(tasks, timeout=_ART_BUDGET_S)
    except BaseException:
        for t in tasks:
            t.cancel()
        raise
    answered = True   # the rows are the response's now; late lookups only cache
