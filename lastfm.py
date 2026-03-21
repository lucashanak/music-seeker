import os
import httpx

LASTFM_API_KEY = os.environ.get("LASTFM_API_KEY", "")
LASTFM_URL = "http://ws.audioscrobbler.com/2.0/"


async def _get(method: str, params: dict = None) -> dict:
    p = {"method": method, "api_key": LASTFM_API_KEY, "format": "json"}
    if params:
        p.update(params)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(LASTFM_URL, params=p)
        resp.raise_for_status()
        return resp.json()


def _pick_image(images: list) -> str:
    for size in ("extralarge", "large", "medium"):
        for img in images:
            if img.get("size") == size and img.get("#text"):
                return img["#text"]
    return ""


async def get_top_tags(limit: int = 50) -> list[dict]:
    data = await _get("tag.getTopTags")
    tags = data.get("toptags", {}).get("tag", [])
    return [{"name": t["name"], "count": int(t.get("count", 0))} for t in tags[:limit]]


async def get_tag_tracks(tag: str, limit: int = 20, page: int = 1) -> list[dict]:
    data = await _get("tag.getTopTracks", {"tag": tag, "limit": limit, "page": page})
    tracks = data.get("tracks", {}).get("track", [])
    return [
        {
            "name": t.get("name", ""),
            "artist": t.get("artist", {}).get("name", ""),
            "image": _pick_image(t.get("image", [])),
            "type": "track",
            "url": "",
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
