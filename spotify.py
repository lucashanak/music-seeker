import os
import re
import time
import httpx

SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_REFRESH_TOKEN = os.environ.get("SPOTIFY_REFRESH_TOKEN", "")

# Separate token caches: app-level (client credentials) vs user-level (refresh token)
_app_token = {"access_token": None, "expires_at": 0}
_user_token = {"access_token": None, "expires_at": 0}


async def get_app_token() -> str:
    """Client Credentials token — no user account, safe for search/browse."""
    if _app_token["access_token"] and time.time() < _app_token["expires_at"] - 60:
        return _app_token["access_token"]

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "client_credentials",
                "client_id": SPOTIFY_CLIENT_ID,
                "client_secret": SPOTIFY_CLIENT_SECRET,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        data = resp.json()

    _app_token["access_token"] = data["access_token"]
    _app_token["expires_at"] = time.time() + data.get("expires_in", 3600)
    return data["access_token"]


async def get_user_token() -> str:
    """User token via refresh_token — needed for user-specific endpoints (playlists)."""
    if _user_token["access_token"] and time.time() < _user_token["expires_at"] - 60:
        return _user_token["access_token"]

    if not SPOTIFY_REFRESH_TOKEN:
        raise RuntimeError("SPOTIFY_REFRESH_TOKEN not configured — cannot access user data")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": SPOTIFY_REFRESH_TOKEN,
                "client_id": SPOTIFY_CLIENT_ID,
                "client_secret": SPOTIFY_CLIENT_SECRET,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        data = resp.json()

    _user_token["access_token"] = data["access_token"]
    _user_token["expires_at"] = time.time() + data.get("expires_in", 3600)
    return data["access_token"]


async def spotify_get(endpoint: str, params: dict | None = None, user: bool = False) -> dict:
    token = await (get_user_token() if user else get_app_token())
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://api.spotify.com/v1/{endpoint}",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
        return resp.json()


async def search(query: str, search_type: str = "track", limit: int = 20, offset: int = 0) -> list[dict]:
    params = {"q": query, "type": search_type, "limit": limit, "offset": offset}
    if search_type in ("show", "episode"):
        params["market"] = "CZ"
    data = await spotify_get("search", params)

    results = []
    items_key = f"{search_type}s"
    for item in data.get(items_key, {}).get("items", []):
        if not item or not item.get("id"):
            continue
        if search_type == "track":
            results.append({
                "id": item["id"],
                "name": item["name"],
                "artist": ", ".join(a["name"] for a in item.get("artists", [])),
                "album": item.get("album", {}).get("name", ""),
                "year": (item.get("album", {}).get("release_date", "") or "")[:4],
                "image": _best_image(item.get("album", {}).get("images", [])),
                "url": item["external_urls"].get("spotify", ""),
                "duration_ms": item.get("duration_ms", 0),
                "type": "track",
            })
        elif search_type == "album":
            results.append({
                "id": item["id"],
                "name": item["name"],
                "artist": ", ".join(a["name"] for a in item.get("artists", [])),
                "year": (item.get("release_date", "") or "")[:4],
                "image": _best_image(item.get("images", [])),
                "url": item["external_urls"].get("spotify", ""),
                "total_tracks": item.get("total_tracks", 0),
                "type": "album",
            })
        elif search_type == "artist":
            results.append({
                "id": item["id"],
                "name": item["name"],
                "artist": item["name"],
                "image": _best_image(item.get("images", [])),
                "url": item["external_urls"].get("spotify", ""),
                "genres": item.get("genres", []),
                "type": "artist",
            })
        elif search_type == "playlist":
            results.append({
                "id": item["id"],
                "name": item["name"],
                "artist": item.get("owner", {}).get("display_name", ""),
                "image": _best_image(item.get("images", [])),
                "url": item["external_urls"].get("spotify", ""),
                "total_tracks": item.get("tracks", {}).get("total", 0),
                "type": "playlist",
            })
        elif search_type == "show":
            results.append({
                "id": item["id"],
                "name": item["name"],
                "artist": item.get("publisher", ""),
                "image": _best_image(item.get("images", [])),
                "url": item["external_urls"].get("spotify", ""),
                "total_tracks": item.get("total_episodes", 0),
                "type": "show",
                "description": (item.get("description", "") or "")[:200],
            })
        elif search_type == "episode":
            results.append({
                "id": item["id"],
                "name": item["name"],
                "artist": item.get("show", {}).get("name", ""),
                "image": _best_image(item.get("images", [])),
                "url": item["external_urls"].get("spotify", ""),
                "duration_ms": item.get("duration_ms", 0),
                "release_date": item.get("release_date", ""),
                "type": "episode",
                "show_id": item.get("show", {}).get("id", ""),
                "description": (item.get("description", "") or "")[:200],
            })

    return results


async def resolve_url(name: str, artist: str, item_type: str = "track") -> dict | None:
    query = f"{artist} {name}" if artist else name
    results = await search(query, item_type, 1)
    return results[0] if results else None


async def get_user_playlists() -> list[dict]:
    data = await spotify_get("me/playlists", {"limit": 50}, user=True)
    playlists = []
    for item in data.get("items", []):
        playlists.append({
            "id": item["id"],
            "name": item["name"],
            "description": item.get("description", ""),
            "image": _best_image(item.get("images", [])),
            "tracks_total": item.get("tracks", {}).get("total", 0),
            "url": item["external_urls"].get("spotify", ""),
        })
    return playlists


async def get_playlist_tracks(playlist_id: str) -> dict:
    # Get playlist metadata first
    try:
        playlist = await spotify_get(f"playlists/{playlist_id}", {"fields": "name,images"})
    except httpx.HTTPStatusError:
        playlist = await spotify_get(f"playlists/{playlist_id}", {"fields": "name,images"}, user=True)

    # Paginate through all tracks (Spotify returns max 100 per request)
    tracks = []
    offset = 0
    use_user = False
    while True:
        try:
            if use_user:
                data = await spotify_get(f"playlists/{playlist_id}/tracks",
                    {"limit": 100, "offset": offset}, user=True)
            else:
                data = await spotify_get(f"playlists/{playlist_id}/tracks",
                    {"limit": 100, "offset": offset})
        except httpx.HTTPStatusError:
            if not use_user:
                use_user = True
                continue
            raise

        for item in data.get("items", []):
            t = item.get("track")
            if not t or not t.get("id"):
                continue
            tracks.append({
                "id": t["id"],
                "name": t["name"],
                "artist": ", ".join(a["name"] for a in t.get("artists", [])),
                "album": t.get("album", {}).get("name", ""),
                "image": _best_image(t.get("album", {}).get("images", [])),
                "url": t["external_urls"].get("spotify", ""),
                "duration_ms": t.get("duration_ms", 0),
                "type": "track",
            })

        if not data.get("next"):
            break
        offset += 100

    return {
        "name": playlist.get("name", ""),
        "image": _best_image(playlist.get("images", [])),
        "tracks": tracks,
    }


async def get_liked_tracks() -> dict:
    """Fetch user's Liked Songs (saved tracks) with pagination."""
    tracks = []
    offset = 0
    while True:
        data = await spotify_get("me/tracks", {"limit": 50, "offset": offset}, user=True)
        for item in data.get("items", []):
            t = item.get("track")
            if not t or not t.get("id"):
                continue
            tracks.append({
                "id": t["id"],
                "name": t["name"],
                "artist": ", ".join(a["name"] for a in t.get("artists", [])),
                "album": t.get("album", {}).get("name", ""),
                "image": _best_image(t.get("album", {}).get("images", [])),
                "url": t["external_urls"].get("spotify", ""),
                "duration_ms": t.get("duration_ms", 0),
                "type": "track",
            })
        if not data.get("next"):
            break
        offset += 50
    return {
        "name": "Liked Songs",
        "image": "",
        "tracks": tracks,
    }


def parse_spotify_url(url: str) -> tuple[str, str] | None:
    """Extract (type, id) from a Spotify URL. Returns None if not a valid Spotify URL."""
    m = re.search(r"open\.spotify\.com/(track|album|playlist|artist|episode|show)/([a-zA-Z0-9]+)", url)
    if m:
        return m.group(1), m.group(2)
    return None


async def get_track_metadata(track_id: str) -> dict:
    """Get basic metadata for a single track."""
    data = await spotify_get(f"tracks/{track_id}")
    return {
        "name": data["name"],
        "artist": ", ".join(a["name"] for a in data.get("artists", [])),
        "album": data.get("album", {}).get("name", ""),
        "image": _best_image(data.get("album", {}).get("images", [])),
    }


async def get_album_tracks(album_id: str) -> list[dict]:
    """Get all tracks from an album with metadata."""
    album = await spotify_get(f"albums/{album_id}")
    album_name = album.get("name", "")
    album_artist = ", ".join(a["name"] for a in album.get("artists", []))
    album_image = _best_image(album.get("images", []))

    tracks = []
    offset = 0
    while True:
        data = await spotify_get(f"albums/{album_id}/tracks", {"limit": 50, "offset": offset})
        for item in data.get("items", []):
            if not item or not item.get("id"):
                continue
            tracks.append({
                "name": item["name"],
                "artist": ", ".join(a["name"] for a in item.get("artists", [])),
                "album": album_name,
                "image": album_image,
                "url": item["external_urls"].get("spotify", ""),
            })
        if not data.get("next"):
            break
        offset += 50

    return tracks


async def get_episode_metadata(episode_id: str) -> dict:
    """Get metadata for a single podcast episode."""
    data = await spotify_get(f"episodes/{episode_id}", {"market": "CZ"})
    return {
        "name": data["name"],
        "artist": data.get("show", {}).get("name", ""),
        "album": data.get("show", {}).get("name", ""),
        "image": _best_image(data.get("images", [])),
        "url": data["external_urls"].get("spotify", ""),
        "duration_ms": data.get("duration_ms", 0),
        "type": "episode",
    }


async def get_show_episodes(show_id: str) -> dict:
    """Get all episodes from a podcast show."""
    show = await spotify_get(f"shows/{show_id}", {"market": "CZ"})
    show_name = show.get("name", "")
    show_image = _best_image(show.get("images", []))
    publisher = show.get("publisher", "")

    episodes = []
    offset = 0
    while True:
        data = await spotify_get(f"shows/{show_id}/episodes",
                                 {"limit": 50, "offset": offset, "market": "CZ"})
        for item in data.get("items", []):
            if not item or not item.get("id"):
                continue
            episodes.append({
                "id": item["id"],
                "name": item["name"],
                "artist": show_name,
                "album": show_name,
                "image": _best_image(item.get("images", [])) or show_image,
                "url": item["external_urls"].get("spotify", ""),
                "duration_ms": item.get("duration_ms", 0),
                "release_date": item.get("release_date", ""),
                "type": "episode",
                "description": (item.get("description", "") or "")[:200],
            })
        if not data.get("next"):
            break
        offset += 50

    return {
        "name": show_name,
        "image": show_image,
        "publisher": publisher,
        "episodes": episodes,
    }


def _best_image(images: list[dict]) -> str:
    if not images:
        return ""
    for img in images:
        if img.get("width") and img["width"] >= 300:
            return img["url"]
    return images[0].get("url", "")
