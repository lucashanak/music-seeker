import os
import time
import httpx

LASTFM_API_KEY = os.environ.get("LASTFM_API_KEY", "")
LASTFM_URL = "http://ws.audioscrobbler.com/2.0/"

# In-memory cache: key -> (timestamp, data)
_cache: dict[str, tuple[float, object]] = {}
_CACHE_TTL = 600  # 10 minutes


def _cache_key(method: str, params: dict | None) -> str:
    parts = [method]
    if params:
        parts.extend(f"{k}={v}" for k, v in sorted(params.items()))
    return "|".join(parts)


async def _get(method: str, params: dict | None = None) -> dict:
    key = _cache_key(method, params)
    now = time.time()
    cached = _cache.get(key)
    if cached and now - cached[0] < _CACHE_TTL:
        return cached[1]
    p = {"method": method, "api_key": LASTFM_API_KEY, "format": "json"}
    if params:
        p.update(params)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(LASTFM_URL, params=p)
        resp.raise_for_status()
        data = resp.json()
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(f"Last.fm error {data.get('error')}: {data.get('message', '')}")
    _cache[key] = (now, data)
    return data


# Last.fm answers with this same grey star for everything it has no art for.
# It is a valid URL that loads, so it is not detectable as "missing" — only by
# the shape of the address. Returning it would paint a whole Discover page with
# identical placeholders instead of letting the cards draw their own empty state.
_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f"


def _pick_image(images: list) -> str:
    for size in ("extralarge", "large", "medium"):
        for img in images:
            text = img.get("#text")
            # Skipped, not returned: a placeholder in extralarge must not throw
            # away a real cover sitting in large.
            if img.get("size") == size and text and _PLACEHOLDER not in text:
                return text
    return ""


async def get_top_tags(limit: int = 50) -> list[dict]:
    data = await _get("tag.getTopTags")
    tags = data.get("toptags", {}).get("tag", [])
    return [
        {"name": t.get("name", ""), "count": int(t.get("count", 0))}
        for t in tags[:limit]
        if t.get("name")
    ]


async def get_tag_tracks(tag: str, limit: int = 20, page: int = 1) -> list[dict]:
    data = await _get("tag.getTopTracks", {"tag": tag, "limit": limit, "page": page})
    tracks = data.get("tracks", {}).get("track", [])

    def _int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0

    return [
        {
            "name": t.get("name", ""),
            "artist": t.get("artist", {}).get("name", ""),
            "image": _pick_image(t.get("image", [])),
            "type": "track",
            "url": "",
            "listeners": _int(t.get("listeners")),
        }
        for t in tracks
    ]


async def get_tag_albums(tag: str, limit: int = 20, page: int = 1) -> list[dict]:
    data = await _get("tag.getTopAlbums", {"tag": tag, "limit": limit, "page": page})
    albums = data.get("albums", {}).get("album", [])
    return [
        {
            "name": a.get("name", ""),
            "artist": a.get("artist", {}).get("name", ""),
            "image": _pick_image(a.get("image", [])),
            "type": "album",
            "url": "",
        }
        for a in albums
    ]


async def get_similar_tracks(track: str, artist: str, limit: int = 25) -> list[dict]:
    data = await _get("track.getSimilar", {"track": track, "artist": artist, "limit": limit})
    tracks = data.get("similartracks", {}).get("track", [])
    return [
        {
            "name": t.get("name", ""),
            "artist": t.get("artist", {}).get("name", ""),
            "image": _pick_image(t.get("image", [])),
            "type": "track",
            "match": float(t.get("match", 0)),
        }
        for t in tracks
    ]


async def get_similar_artists(artist: str, limit: int = 20) -> list[dict]:
    data = await _get("artist.getSimilar", {"artist": artist, "limit": limit})
    artists = data.get("similarartists", {}).get("artist", [])
    return [
        {
            "name": a.get("name", ""),
            "artist": a.get("name", ""),
            "image": _pick_image(a.get("image", [])),
            "type": "artist",
            "match": float(a.get("match", 0)),
        }
        for a in artists
    ]


async def get_artist_top_tracks(artist: str, limit: int = 10) -> list[dict]:
    data = await _get("artist.getTopTracks", {"artist": artist, "limit": limit})
    tracks = data.get("toptracks", {}).get("track", [])
    return [
        {
            "name": t.get("name", ""),
            "artist": t.get("artist", {}).get("name", ""),
            "image": _pick_image(t.get("image", [])),
            "type": "track",
        }
        for t in tracks
    ]


async def get_artist_top_tags(artist: str, limit: int = 10) -> list[dict]:
    try:
        data = await _get("artist.getTopTags", {"artist": artist})
    except Exception:
        return []
    tags = data.get("toptags", {}).get("tag", [])
    return [{"name": t.get("name", ""), "count": int(t.get("count", 0))} for t in tags[:limit] if t.get("name")]


async def get_track_top_tags(track: str, artist: str, limit: int = 10) -> list[dict]:
    try:
        data = await _get("track.getTopTags", {"track": track, "artist": artist})
    except Exception:
        return []
    tags = data.get("toptags", {}).get("tag", [])
    return [{"name": t.get("name", ""), "count": int(t.get("count", 0))} for t in tags[:limit] if t.get("name")]


async def get_tag_artists(tag: str, limit: int = 20, page: int = 1) -> list[dict]:
    data = await _get("tag.getTopArtists", {"tag": tag, "limit": limit, "page": page})
    artists = data.get("topartists", {}).get("artist", [])
    return [
        {
            "name": a.get("name", ""),
            "artist": a.get("name", ""),
            "image": _pick_image(a.get("image", [])),
            "type": "artist",
            "url": "",
        }
        for a in artists
    ]
