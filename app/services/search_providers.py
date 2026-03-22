"""Unified music search with multiple providers: Deezer, YouTube Music, Spotify, Apple/iTunes."""

import asyncio
import re
import logging
import defusedxml.ElementTree as ET
import httpx

logger = logging.getLogger(__name__)

DEEZER_BASE = "https://api.deezer.com"
ITUNES_BASE = "https://itunes.apple.com"

# Lazy-init ytmusicapi
_ytmusic = None


def _get_ytmusic():
    global _ytmusic
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
        })
    return tracks


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

_SEARCH_FUNCS = {
    "deezer": deezer_search,
    "ytmusic": ytmusic_search,
    "apple": itunes_search,
}

# Default fallback when user doesn't pick one
_DEFAULT_FALLBACK = {
    "deezer": "ytmusic",
    "ytmusic": "deezer",
    "apple": "deezer",
    "spotify": "",
    "itunes": "spotify",
}


async def _try_provider(name: str, query: str, search_type: str, limit: int, offset: int) -> list[dict] | None:
    """Try a single provider, return results or None."""
    if name == "spotify":
        from app.services import spotify
        return await spotify.search(query, search_type, limit, offset)
    if name == "itunes":
        return await itunes_search(query, search_type, limit)
    func = _SEARCH_FUNCS.get(name)
    if not func:
        return None
    return await func(query, search_type, limit, offset) if name != "apple" else await func(query, search_type, limit)


async def search(query: str, search_type: str = "track", limit: int = 20, offset: int = 0,
                 provider: str = "deezer", fallback: str = "") -> list[dict]:
    """Search with the specified provider, falling back if needed."""

    if fallback == "none":
        fallback = ""
    elif not fallback:
        fallback = _DEFAULT_FALLBACK.get(provider, "")

    # Primary
    try:
        results = await _try_provider(provider, query, search_type, limit, offset)
        if results:
            return results
    except Exception as e:
        logger.warning(f"{provider} search failed: {e}")

    # Fallback
    if fallback and fallback != provider:
        try:
            results = await _try_provider(fallback, query, search_type, limit, offset)
            if results:
                return results
        except Exception as e:
            logger.warning(f"{fallback} fallback failed: {e}")

    return []


async def resolve(name: str, artist: str, item_type: str = "track", provider: str = "deezer", fallback: str = "") -> dict | None:
    """Resolve a track/album by name+artist. Used by discover."""
    query = f"{artist} {name}" if artist else name
    results = await search(query, item_type, 1, provider=provider, fallback=fallback)
    return results[0] if results else None


def _normalize(name: str) -> str:
    """Normalize artist/album name for comparison."""
    return re.sub(r'\s+', ' ', name.strip().lower())


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
    if provider in ("apple", "itunes"):
        return await itunes_get_artist_albums(artist_id)
    return await deezer_get_artist_albums(artist_id)


async def get_album_tracks(album_id: str, provider: str = "deezer") -> list[dict]:
    """Get album tracks using the appropriate provider."""
    if provider in ("apple", "itunes"):
        return await itunes_get_album_tracks(album_id)
    return await deezer_get_album_tracks(album_id)


async def artist_latest_album(artist_id: str, provider: str = "deezer") -> dict | None:
    """Get latest album from an artist using the appropriate provider."""
    if provider in ("apple", "itunes"):
        return await itunes_artist_latest_album(artist_id)
    return await deezer_artist_latest_album(artist_id)
