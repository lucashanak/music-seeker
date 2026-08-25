import hashlib
import logging
import os
import re
import time
import httpx

logger = logging.getLogger(__name__)

SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_REFRESH_TOKEN = os.environ.get("SPOTIFY_REFRESH_TOKEN", "")

SPOTIFY_SCOPES = "user-library-read playlist-read-private playlist-read-collaborative user-follow-read user-top-read"


def get_oauth_url(redirect_uri: str, state: str = "", client_id: str = "") -> str:
    """Build Spotify OAuth authorization URL."""
    import urllib.parse
    cid = client_id or SPOTIFY_CLIENT_ID
    params = {
        "client_id": cid,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": SPOTIFY_SCOPES,
        "show_dialog": "true",
    }
    if state:
        params["state"] = state
    return f"https://accounts.spotify.com/authorize?{urllib.parse.urlencode(params)}"


async def exchange_code(code: str, redirect_uri: str, client_id: str = "", client_secret: str = "") -> dict:
    """Exchange authorization code for access + refresh tokens."""
    cid = client_id or SPOTIFY_CLIENT_ID
    csecret = client_secret or SPOTIFY_CLIENT_SECRET
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": cid,
                "client_secret": csecret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        return resp.json()

# Token caches keyed by (client_id, grant_type) to support per-user credentials
# Key format: "{client_id}:app" or "{client_id}:{refresh_token_hash}:user"
_token_cache: dict[str, dict] = {}


def _cache_key(client_id: str, refresh_token: str = "", user: bool = False) -> str:
    if user:
        rt_hash = hashlib.md5(refresh_token.encode()).hexdigest()[:8] if refresh_token else "none"
        return f"{client_id}:{rt_hash}:user"
    return f"{client_id}:app"


async def get_app_token(creds: dict | None = None) -> str:
    """Client Credentials token — no user account, safe for search/browse."""
    cid = (creds or {}).get("client_id") or SPOTIFY_CLIENT_ID
    csecret = (creds or {}).get("client_secret") or SPOTIFY_CLIENT_SECRET
    key = _cache_key(cid)

    cached = _token_cache.get(key, {})
    if cached.get("access_token") and time.time() < cached.get("expires_at", 0) - 60:
        return cached["access_token"]

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://accounts.spotify.com/api/token",
            data={"grant_type": "client_credentials", "client_id": cid, "client_secret": csecret},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        data = resp.json()

    _token_cache[key] = {"access_token": data["access_token"], "expires_at": time.time() + data.get("expires_in", 3600)}
    return data["access_token"]


def _get_global_refresh_token() -> str:
    """Get global refresh token: settings override > env var."""
    try:
        from app.services import settings as _s
        stored = _s._settings.get("spotify_refresh_token", "")
        if stored:
            return stored
    except Exception:
        pass
    return SPOTIFY_REFRESH_TOKEN


async def get_user_token(creds: dict | None = None) -> str:
    """User token via refresh_token — needed for user-specific endpoints (playlists)."""
    cid = (creds or {}).get("client_id") or SPOTIFY_CLIENT_ID
    csecret = (creds or {}).get("client_secret") or SPOTIFY_CLIENT_SECRET
    rt = (creds or {}).get("refresh_token") or _get_global_refresh_token()
    key = _cache_key(cid, rt, user=True)

    cached = _token_cache.get(key, {})
    if cached.get("access_token") and time.time() < cached.get("expires_at", 0) - 60:
        return cached["access_token"]

    if not rt:
        raise RuntimeError("Spotify refresh token not configured — cannot access user data")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://accounts.spotify.com/api/token",
            data={"grant_type": "refresh_token", "refresh_token": rt, "client_id": cid, "client_secret": csecret},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        data = resp.json()

    _token_cache[key] = {"access_token": data["access_token"], "expires_at": time.time() + data.get("expires_in", 3600)}
    return data["access_token"]


class SpotifyUnavailable(RuntimeError):
    """The Spotify API is refusing every request for an account-level reason.

    Subclasses RuntimeError so the existing `except Exception` fallbacks around
    every call site keep working unchanged — this only makes the failure fast
    and named instead of slow and anonymous.
    """


# ── API health latch ────────────────────────────────────────────────
# When the developer account's Premium subscription lapses, Spotify answers 403
# "Active premium subscription required for the owner of the app" on EVERY
# endpoint — search, track metadata, browse, the lot. The token endpoint still
# issues tokens, so nothing upstream notices; each doomed call just costs a round
# trip. That is not free: the taste profile alone fires two per recommendation
# request, and _resolve_tracks fires one per download.
#
# So the first account-level 403 latches the API off for a while. The window is
# short because the condition is externally recoverable — Spotify's own message
# says a subscription change takes a few hours to propagate — so the latch must
# expire and retry rather than require a restart.
_API_DISABLED_TTL = 900  # 15 min
_api_disabled_until = 0.0
_api_disabled_reason = ""

# 403s that are about the app/account, not about this particular request.
_ACCOUNT_403_MARKERS = ("premium subscription", "subscription required")


def api_available() -> bool:
    """False while the account-level failure latch is held."""
    return time.time() >= _api_disabled_until


def api_status() -> dict:
    """Health for the version endpoint and diagnostics."""
    return {
        "available": api_available(),
        "reason": "" if api_available() else _api_disabled_reason,
        "retry_in": max(0, int(_api_disabled_until - time.time())),
    }


def _latch_unavailable(reason: str) -> None:
    global _api_disabled_until, _api_disabled_reason
    if api_available():  # log the transition once, not once per call
        logger.warning("Spotify API disabled for %ds: %s", _API_DISABLED_TTL, reason)
    _api_disabled_until = time.time() + _API_DISABLED_TTL
    _api_disabled_reason = reason


async def spotify_get(endpoint: str, params: dict | None = None, user: bool = False, creds: dict | None = None) -> dict:
    if not api_available():
        raise SpotifyUnavailable(f"Spotify API unavailable: {_api_disabled_reason}")
    token = await (get_user_token(creds) if user else get_app_token(creds))
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://api.spotify.com/v1/{endpoint}",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        )
        if resp.status_code == 403:
            body = (resp.text or "")[:300]
            if any(m in body.lower() for m in _ACCOUNT_403_MARKERS):
                _latch_unavailable(body.strip())
                raise SpotifyUnavailable(f"Spotify API unavailable: {body.strip()}")
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


async def get_user_playlists(creds: dict | None = None) -> list[dict]:
    data = await spotify_get("me/playlists", {"limit": 50}, user=True, creds=creds)
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


async def get_playlist_tracks(playlist_id: str, creds: dict | None = None) -> dict:
    # Get playlist metadata first
    try:
        playlist = await spotify_get(f"playlists/{playlist_id}", {"fields": "name,images"}, creds=creds)
    except httpx.HTTPStatusError:
        playlist = await spotify_get(f"playlists/{playlist_id}", {"fields": "name,images"}, user=True, creds=creds)

    # Paginate through all tracks (Spotify returns max 100 per request)
    tracks = []
    offset = 0
    use_user = False
    while True:
        try:
            if use_user:
                data = await spotify_get(f"playlists/{playlist_id}/tracks",
                    {"limit": 100, "offset": offset}, user=True, creds=creds)
            else:
                data = await spotify_get(f"playlists/{playlist_id}/tracks",
                    {"limit": 100, "offset": offset}, creds=creds)
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


async def get_liked_tracks(creds: dict | None = None) -> dict:
    """Fetch user's Liked Songs (saved tracks) with pagination."""
    tracks = []
    offset = 0
    while True:
        data = await spotify_get("me/tracks", {"limit": 50, "offset": offset}, user=True, creds=creds)
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


async def get_saved_albums(creds: dict | None = None) -> list[dict]:
    """Fetch user's saved albums."""
    albums = []
    offset = 0
    while True:
        data = await spotify_get("me/albums", {"limit": 50, "offset": offset}, user=True, creds=creds)
        for item in data.get("items", []):
            a = item.get("album")
            if not a or not a.get("id"):
                continue
            albums.append({
                "id": a["id"],
                "name": a["name"],
                "artist": ", ".join(ar["name"] for ar in a.get("artists", [])),
                "image": _best_image(a.get("images", [])),
                "url": a["external_urls"].get("spotify", ""),
                "total_tracks": a.get("total_tracks", 0),
                "release_date": a.get("release_date", ""),
                "type": "album",
            })
        if not data.get("next"):
            break
        offset += 50
    return albums


async def get_followed_artists(creds: dict | None = None) -> list[dict]:
    """Fetch user's followed artists."""
    artists = []
    after = None
    while True:
        params = {"type": "artist", "limit": 50}
        if after:
            params["after"] = after
        data = await spotify_get("me/following", params, user=True, creds=creds)
        items = data.get("artists", {}).get("items", [])
        for item in items:
            if not item or not item.get("id"):
                continue
            artists.append({
                "id": item["id"],
                "name": item["name"],
                "artist": item["name"],
                "image": _best_image(item.get("images", [])),
                "url": item["external_urls"].get("spotify", ""),
                "genres": item.get("genres", [])[:3],
                "followers": item.get("followers", {}).get("total", 0),
                "type": "artist",
            })
        cursors = data.get("artists", {}).get("cursors", {})
        after = cursors.get("after")
        if not after or not items:
            break
    return artists


async def get_top_tracks(time_range: str = "medium_term", limit: int = 50,
                         creds: dict | None = None) -> list[dict]:
    """Fetch user's top tracks via /me/top/tracks (requires user-top-read scope).
    time_range: 'short_term' (~4 weeks), 'medium_term' (~6 months), 'long_term' (years)."""
    tracks = []
    try:
        data = await spotify_get("me/top/tracks",
                                 {"time_range": time_range, "limit": min(limit, 50)},
                                 user=True, creds=creds)
    except Exception as e:
        logger.warning("Spotify top tracks failed (time_range=%s): %s", time_range, e)
        return []
    for t in data.get("items", []):
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
    return tracks


async def get_top_artists(time_range: str = "medium_term", limit: int = 50,
                          creds: dict | None = None) -> list[dict]:
    """Fetch user's top artists via /me/top/artists (requires user-top-read scope)."""
    artists = []
    try:
        data = await spotify_get("me/top/artists",
                                 {"time_range": time_range, "limit": min(limit, 50)},
                                 user=True, creds=creds)
    except Exception as e:
        logger.warning("Spotify top artists failed (time_range=%s): %s", time_range, e)
        return []
    for a in data.get("items", []):
        if not a or not a.get("id"):
            continue
        artists.append({
            "id": a["id"],
            "name": a["name"],
            "artist": a["name"],
            "image": _best_image(a.get("images", [])),
            "url": a["external_urls"].get("spotify", ""),
            "genres": a.get("genres", []),
            "type": "artist",
        })
    return artists


async def get_saved_shows(creds: dict | None = None) -> list[dict]:
    """Fetch user's saved podcast shows."""
    shows = []
    offset = 0
    while True:
        data = await spotify_get("me/shows", {"limit": 50, "offset": offset}, user=True, creds=creds)
        for item in data.get("items", []):
            s = item.get("show")
            if not s or not s.get("id"):
                continue
            shows.append({
                "id": s["id"],
                "name": s["name"],
                "artist": s.get("publisher", ""),
                "image": _best_image(s.get("images", [])),
                "url": s["external_urls"].get("spotify", ""),
                "total_episodes": s.get("total_episodes", 0),
                "type": "show",
                "description": (s.get("description", "") or "")[:200],
            })
        if not data.get("next"):
            break
        offset += 50
    return shows


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


async def get_recommendations(
    seed_tracks: list[str] | None = None,
    seed_artists: list[str] | None = None,
    limit: int = 20,
) -> list[dict]:
    """Get track recommendations from Spotify based on seed tracks/artists.
    Max 5 seeds total (tracks + artists combined)."""
    seeds_t = (seed_tracks or [])[:5]
    seeds_a = (seed_artists or [])[:max(0, 5 - len(seeds_t))]
    if not seeds_t and not seeds_a:
        return []
    params = {"limit": limit}
    if seeds_t:
        params["seed_tracks"] = ",".join(seeds_t)
    if seeds_a:
        params["seed_artists"] = ",".join(seeds_a)
    try:
        data = await spotify_get("recommendations", params)
    except httpx.HTTPStatusError as e:
        # The /recommendations endpoint is deprecated and returns 404 for apps
        # created after Nov 2024. Make the failure observable but still degrade.
        logger.warning("Spotify recommendations failed (HTTP %s) — endpoint deprecated; degrading to []",
                       e.response.status_code)
        return []
    except Exception as e:
        logger.warning("Spotify recommendations failed: %s — degrading to []", e)
        return []
    results = []
    for t in data.get("tracks", []):
        if not t or not t.get("id"):
            continue
        results.append({
            "id": t["id"],
            "name": t["name"],
            "artist": ", ".join(a["name"] for a in t.get("artists", [])),
            "album": t.get("album", {}).get("name", ""),
            "image": _best_image(t.get("album", {}).get("images", [])),
            "url": t["external_urls"].get("spotify", ""),
            "duration_ms": t.get("duration_ms", 0),
            "type": "track",
        })
    return results


def _best_image(images: list[dict]) -> str:
    if not images:
        return ""
    for img in images:
        if img.get("width") and img["width"] >= 300:
            return img["url"]
    return images[0].get("url", "")
