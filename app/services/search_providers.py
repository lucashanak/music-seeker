"""Unified music search with multiple providers: Deezer, YouTube Music, Spotify, Apple/iTunes."""

import asyncio
import re
import threading
import unicodedata
import logging
import defusedxml.ElementTree as ET
import httpx

logger = logging.getLogger(__name__)

DEEZER_BASE = "https://api.deezer.com"
ITUNES_BASE = "https://itunes.apple.com"

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

async def deezer_search(query: str, search_type: str = "track", limit: int = 20, offset: int = 0) -> list[dict]:
    type_map = {"track": "search", "album": "search/album", "artist": "search/artist", "playlist": "search/playlist"}
    endpoint = type_map.get(search_type)
    if not endpoint:
        return []

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{DEEZER_BASE}/{endpoint}", params={"q": query, "limit": limit, "index": offset})
        resp.raise_for_status()
        data = resp.json()

    if "error" in data:
        raise RuntimeError(f"Deezer error: {data['error'].get('message', '')}")

    results = []
    for item in data.get("data", []):
        if search_type == "track":
            results.append({
                "id": str(item["id"]),
                "name": item.get("title", ""),
                "artist": item.get("artist", {}).get("name", ""),
                "album": item.get("album", {}).get("title", ""),
                "year": "",
                "image": item.get("album", {}).get("cover_big", ""),
                "url": item.get("link", ""),
                "duration_ms": item.get("duration", 0) * 1000,
                "type": "track",
            })
        elif search_type == "album":
            results.append({
                "id": str(item["id"]),
                "name": item.get("title", ""),
                "artist": item.get("artist", {}).get("name", ""),
                "year": "",
                "image": item.get("cover_big", ""),
                "url": item.get("link", ""),
                "total_tracks": item.get("nb_tracks", 0),
                "type": "album",
            })
        elif search_type == "artist":
            results.append({
                "id": str(item["id"]),
                "name": item.get("name", ""),
                "artist": item.get("name", ""),
                "image": item.get("picture_big", ""),
                "url": item.get("link", ""),
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


async def deezer_get_track(track_id: str) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
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
        })
    return tracks


async def deezer_get_playlist_tracks(playlist_id: str) -> dict:
    """Get playlist info + tracks. Deezer pages `tracks.data` (~100/page) via `tracks.next`."""
    async with httpx.AsyncClient(timeout=10) as client:
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
                })
            next_url = page.get("next")
            if not next_url or len(tracks) >= _PLAYLIST_MAX_TRACKS:
                break
            resp = await client.get(next_url)
            resp.raise_for_status()
            page = resp.json()
    return {"tracks": tracks, "name": playlist_name, "image": playlist_image}


async def deezer_get_artist_albums(artist_id: str) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        # Get artist info
        resp = await client.get(f"{DEEZER_BASE}/artist/{artist_id}")
        resp.raise_for_status()
        artist = resp.json()
        # Get albums with pagination (Deezer returns max 100 per page)
        albums = []
        url = f"{DEEZER_BASE}/artist/{artist_id}/albums"
        params = {"limit": 100}
        while url:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("data", []):
                albums.append({
                    "id": str(item["id"]),
                    "name": item.get("title", ""),
                    "artist": artist.get("name", ""),
                    "image": item.get("cover_big", ""),
                    "url": item.get("link", ""),
                    "total_tracks": item.get("nb_tracks", 0),
                    "release_date": item.get("release_date", ""),
                    "type": "album",
                })
            url = data.get("next")
            params = {}  # next URL includes all params
    return {
        "name": artist.get("name", ""),
        "image": artist.get("picture_big", ""),
        "albums": albums,
    }


async def deezer_artist_radio(artist_id: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
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


async def search(query: str, search_type: str = "track", limit: int = 20, offset: int = 0,
                 provider: str = "deezer", fallback: str = "", raise_on_error: bool = False) -> list[dict]:
    """Search with the specified provider, falling back if needed.

    With raise_on_error=True, a ProviderError is raised when every attempted leg
    errored out, so callers can tell an outage from a legitimately empty result.
    """
    provider = _canonical_provider(provider)

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
    """Pick the single best 'top result' across all result types (Spotify-style)."""
    norm = _normalize(query)
    # (1) exact artist name match
    for a in artists:
        if _normalize(a.get("name", "")) == norm:
            return a
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
        *(search(query, t, limit_per_type, provider=provider, fallback=fallback, raise_on_error=True)
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
