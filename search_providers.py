"""Unified music search with multiple providers: Deezer, YouTube Music, Spotify."""

import asyncio
import re
import logging
import httpx

logger = logging.getLogger(__name__)

DEEZER_BASE = "https://api.deezer.com"

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


# ── Unified search ──

async def search(query: str, search_type: str = "track", limit: int = 20, offset: int = 0,
                 provider: str = "deezer") -> list[dict]:
    """Search with the specified provider, falling back through the chain."""

    # Podcasts: only Spotify supports show/episode search
    if search_type in ("show", "episode"):
        import spotify
        return await spotify.search(query, search_type, limit, offset)

    if provider == "spotify":
        import spotify
        return await spotify.search(query, search_type, limit, offset)

    if provider == "deezer":
        try:
            results = await deezer_search(query, search_type, limit, offset)
            if results:
                return results
        except Exception as e:
            logger.warning(f"Deezer search failed: {e}")
        # Fallback to YouTube Music
        try:
            return await ytmusic_search(query, search_type, limit)
        except Exception as e:
            logger.warning(f"YouTube Music fallback failed: {e}")
        return []

    if provider == "ytmusic":
        try:
            results = await ytmusic_search(query, search_type, limit)
            if results:
                return results
        except Exception as e:
            logger.warning(f"YouTube Music search failed: {e}")
        # Fallback to Deezer
        try:
            return await deezer_search(query, search_type, limit, offset)
        except Exception as e:
            logger.warning(f"Deezer fallback failed: {e}")
        return []

    return []


async def resolve(name: str, artist: str, item_type: str = "track", provider: str = "deezer") -> dict | None:
    """Resolve a track/album by name+artist. Used by discover."""
    query = f"{artist} {name}" if artist else name
    results = await search(query, item_type, 1, provider=provider)
    return results[0] if results else None
