import hashlib
import os
import re
import secrets
import unicodedata
from contextvars import ContextVar
import httpx

NAVIDROME_URL = os.environ.get("NAVIDROME_URL", "http://navidrome:4533")
NAVIDROME_USER = os.environ.get("NAVIDROME_USER", "lucas")
NAVIDROME_PASSWORD = os.environ.get("NAVIDROME_PASSWORD", "")

# Per-request Navidrome credentials for the logged-in user's own account. Set by
# the auth dependency (bind_navidrome_creds) at the start of each request so that
# playlists/stars/play-counts are per-user while the music library stays shared.
# Falls back to the module-global service account (lucas) when unset — e.g. system
# tasks, unauthenticated paths, or users not yet provisioned. asyncio.create_task
# (used by the downloader) copies the current context, so background jobs keep the
# requesting user's creds. Value shape: {"username": str, "password": str}.
_req_creds: ContextVar[dict | None] = ContextVar("navidrome_req_creds", default=None)


def set_request_creds(creds: dict | None) -> None:
    """Bind the current request's Navidrome credentials (or None to use the
    global service account)."""
    _req_creds.set(creds or None)


def _params(**extra) -> dict:
    """Use Subsonic token auth (salt + md5) instead of plaintext password.
    Authenticates as the per-request user when bound, else the service account."""
    creds = _req_creds.get() or {}
    user = creds.get("username") or NAVIDROME_USER
    password = creds.get("password") or NAVIDROME_PASSWORD
    salt = secrets.token_hex(8)
    token = hashlib.md5((password + salt).encode()).hexdigest()
    p = {
        "v": "1.16.1",
        "c": "music-seeker",
        "u": user,
        "t": token,
        "s": salt,
        "f": "json",
    }
    p.update(extra)
    return p


def _normalize(s: str) -> str:
    """Normalize for fuzzy comparison: lowercase, strip accents, remove punctuation and extras."""
    s = s.lower().strip()
    # Normalize unicode (curly quotes, accents, etc.)
    s = unicodedata.normalize("NFKD", s)
    s = s.encode("ascii", "ignore").decode("ascii")
    # Remove common suffixes: (feat. ...), (Remaster ...), [Deluxe], etc.
    s = re.sub(r'\s*[\(\[].*?[\)\]]', '', s)
    # Remove punctuation
    s = re.sub(r'[^\w\s]', '', s)
    # Collapse whitespace
    s = re.sub(r'\s+', ' ', s).strip()
    return s


async def check_items(items: list[dict]) -> list[bool]:
    """Check which items exist in Navidrome. Returns list of booleans matching input order."""
    if not NAVIDROME_PASSWORD:
        return [False] * len(items)

    provider = ""
    try:
        from app.services.settings import _settings
        provider = _settings.get("search_provider", "deezer")
    except Exception:
        pass

    # Deduplicate queries to avoid redundant API calls
    queries: dict[str, dict] = {}
    for i, item in enumerate(items):
        name = item.get("name", "")
        artist = item.get("artist", "")
        item_type = item.get("type", "track")
        album_id = item.get("id", "")
        key = f"{item_type}:{_normalize(artist)}:{_normalize(name)}"
        if key not in queries:
            queries[key] = {"name": name, "artist": artist, "type": item_type, "album_id": album_id, "indices": []}
        queries[key]["indices"].append(i)

    results = [False] * len(items)

    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=30) as client:
        for key, q in queries.items():
            try:
                found = await _search_navidrome(client, q["name"], q["artist"], q["type"],
                                                album_id=q["album_id"], provider=provider)
                for idx in q["indices"]:
                    results[idx] = found
            except Exception:
                pass

    return results


async def _search_navidrome(client: httpx.AsyncClient, name: str, artist: str, item_type: str,
                            album_id: str = "", provider: str = "") -> bool:
    # Try with artist+name first for precision, fall back to name-only for recall
    queries = [f"{artist} {name}"] if artist else [name]
    if artist:
        queries.append(name)

    for query in queries:
        params = _params(query=query, songCount=50, albumCount=50, artistCount=20)
        resp = await client.get("/rest/search3", params=params)
        resp.raise_for_status()
        data = resp.json()

        sr = data.get("subsonic-response", {}).get("searchResult3", {})

        if item_type == "track":
            for song in sr.get("song", []):
                if _matches(song.get("title", ""), name) and _artist_matches(song.get("artist", ""), artist):
                    return True

        elif item_type == "album":
            for album in sr.get("album", []):
                if _matches(album.get("name", ""), name) and _artist_matches(album.get("artist", ""), artist):
                    return True
            # Fallback: check if a song with this title exists (singles filed under different albums or different artist)
            for song in sr.get("song", []):
                if _matches(song.get("title", ""), name):
                    return True

        elif item_type == "artist":
            for a in sr.get("artist", []):
                if _matches(a.get("name", ""), artist or name):
                    return True

    # Last resort for albums: fetch track list and check if majority exist in library
    if item_type == "album" and album_id and provider:
        return await _check_album_tracks(client, album_id, provider)

    return False


async def _check_album_tracks(client: httpx.AsyncClient, album_id: str, provider: str) -> bool:
    """Fetch album tracks from provider and check if most exist in Navidrome."""
    try:
        if provider == "deezer":
            from app.services.search_providers import deezer_get_album_tracks
            tracks = await deezer_get_album_tracks(album_id)
        else:
            return False

        if not tracks:
            return False

        found = 0
        for track in tracks:
            tname = track.get("name", "")
            tartist = track.get("artist", "")
            params = _params(query=f"{tartist} {tname}" if tartist else tname, songCount=10, albumCount=0, artistCount=0)
            resp = await client.get("/rest/search3", params=params)
            resp.raise_for_status()
            sr = resp.json().get("subsonic-response", {}).get("searchResult3", {})
            for song in sr.get("song", []):
                if _matches(song.get("title", ""), tname):
                    found += 1
                    break

        # Consider "in library" if majority of tracks exist
        return found >= len(tracks) * 0.5
    except Exception:
        return False


def _matches(a: str, b: str) -> bool:
    na, nb = _normalize(a), _normalize(b)
    if not na or not nb:
        return False
    # Exact match or one contains the other (handles remaster tags, feat. etc.)
    return na == nb or na in nb or nb in na


def _artist_matches(lib_artist: str, search_artist: str) -> bool:
    """Fuzzy match: check if the primary artist name appears in the search artist string."""
    la = _normalize(lib_artist)
    sa = _normalize(search_artist)
    if not la or not sa:
        return True  # skip artist check if either is empty
    return la in sa or sa in la


async def find_song_id(name: str, artist: str, album: str = "") -> str | None:
    """Find a song's Navidrome ID by name and artist. If album is set, only match songs on that album."""
    if not NAVIDROME_PASSWORD:
        return None
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=10) as client:
        params = _params(query=name, songCount=50, albumCount=0, artistCount=0)
        resp = await client.get("/rest/search3", params=params)
        resp.raise_for_status()
        sr = resp.json().get("subsonic-response", {}).get("searchResult3", {})
        for song in sr.get("song", []):
            if _matches(song.get("title", ""), name) and _artist_matches(song.get("artist", ""), artist):
                if album and not _matches(song.get("album", ""), album):
                    continue
                return song.get("id")
    return None


def _song_to_dict(song: dict) -> dict:
    """Map a Subsonic song object to the app's track dict shape."""
    return {
        "id": song.get("id", ""),
        "name": song.get("title", ""),
        "artist": song.get("artist", ""),
        "album": song.get("album", ""),
        "image": f"/api/library/cover/{song['coverArt']}" if song.get("coverArt") else "",
        "type": "track",
    }


async def get_similar_songs(artist: str, title: str, count: int = 20) -> list[dict]:
    """Subsonic getSimilarSongs2: songs similar to a given track (needs a song id).
    Resolves the track to a Navidrome song id first, then asks for similar songs.
    Returns [] gracefully when Navidrome is unreachable or nothing matches."""
    if not NAVIDROME_PASSWORD:
        return []
    try:
        song_id = await find_song_id(title, artist)
        if not song_id:
            return []
        async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=15) as client:
            resp = await client.get("/rest/getSimilarSongs2",
                                    params=_params(id=song_id, count=count))
            resp.raise_for_status()
            sr = resp.json().get("subsonic-response", {})
            if sr.get("status") != "ok":
                return []
            songs = sr.get("similarSongs2", {}).get("song", [])
            if isinstance(songs, dict):
                songs = [songs]
            return [_song_to_dict(s) for s in songs if s.get("title")]
    except Exception:
        return []


async def get_top_songs(artist: str, count: int = 20) -> list[dict]:
    """Subsonic getTopSongs: most popular songs for an artist (by name).
    Returns [] gracefully when Navidrome is unreachable or nothing matches."""
    if not NAVIDROME_PASSWORD or not artist:
        return []
    try:
        async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=15) as client:
            resp = await client.get("/rest/getTopSongs",
                                    params=_params(artist=artist, count=count))
            resp.raise_for_status()
            sr = resp.json().get("subsonic-response", {})
            if sr.get("status") != "ok":
                return []
            songs = sr.get("topSongs", {}).get("song", [])
            if isinstance(songs, dict):
                songs = [songs]
            return [_song_to_dict(s) for s in songs if s.get("title")]
    except Exception:
        return []


async def get_starred() -> list[dict]:
    """Subsonic getStarred2: the user's starred (favorited) songs.
    Returns [] gracefully when Navidrome is unreachable."""
    if not NAVIDROME_PASSWORD:
        return []
    try:
        async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=15) as client:
            resp = await client.get("/rest/getStarred2", params=_params())
            resp.raise_for_status()
            sr = resp.json().get("subsonic-response", {})
            if sr.get("status") != "ok":
                return []
            songs = sr.get("starred2", {}).get("song", [])
            if isinstance(songs, dict):
                songs = [songs]
            return [_song_to_dict(s) for s in songs if s.get("title")]
    except Exception:
        return []


async def star_song(song_id: str) -> bool:
    """Subsonic star: mark a song as a favorite in Navidrome."""
    if not NAVIDROME_PASSWORD or not song_id:
        return False
    try:
        async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=10) as client:
            resp = await client.get("/rest/star", params=_params(id=song_id))
            resp.raise_for_status()
            return resp.json().get("subsonic-response", {}).get("status") == "ok"
    except Exception:
        return False


async def unstar_song(song_id: str) -> bool:
    """Subsonic unstar: remove a song from favorites in Navidrome."""
    if not NAVIDROME_PASSWORD or not song_id:
        return False
    try:
        async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=10) as client:
            resp = await client.get("/rest/unstar", params=_params(id=song_id))
            resp.raise_for_status()
            return resp.json().get("subsonic-response", {}).get("status") == "ok"
    except Exception:
        return False


async def get_playlists() -> list[dict]:
    """Get all playlists from Navidrome via Subsonic API."""
    if not NAVIDROME_PASSWORD:
        return []
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=10) as client:
        resp = await client.get("/rest/getPlaylists", params=_params())
        resp.raise_for_status()
        sr = resp.json().get("subsonic-response", {})
        if sr.get("status") != "ok":
            return []
        items = sr.get("playlists", {}).get("playlist", [])
        if isinstance(items, dict):
            items = [items]
        return [
            {
                "id": p["id"],
                "name": p.get("name", ""),
                "description": p.get("comment", ""),
                "songCount": p.get("songCount", 0),
                "duration": p.get("duration", 0),
                "changed": p.get("changed", ""),  # ISO mtime — used by gc_temp_playlists recency sort
                "coverArt": p.get("coverArt", ""),
                "image": f"/api/library/cover/{p['coverArt']}" if p.get("coverArt") else "",
            }
            for p in items
        ]


async def get_cover_art(cover_id: str) -> bytes | None:
    """Proxy cover art from Navidrome."""
    if not NAVIDROME_PASSWORD:
        return None
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=10) as client:
        resp = await client.get("/rest/getCoverArt", params=_params(id=cover_id))
        resp.raise_for_status()
        return resp.content


async def get_playlist(playlist_id: str) -> dict | None:
    """Get a playlist with its tracks from Navidrome."""
    if not NAVIDROME_PASSWORD:
        return None
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=15) as client:
        resp = await client.get("/rest/getPlaylist", params=_params(id=playlist_id))
        resp.raise_for_status()
        sr = resp.json().get("subsonic-response", {})
        if sr.get("status") != "ok":
            return None
        pl = sr.get("playlist", {})
        entries = pl.get("entry", [])
        if isinstance(entries, dict):
            entries = [entries]
        tracks = [
            {
                "id": e.get("id", ""),
                "name": e.get("title", ""),
                "artist": e.get("artist", ""),
                "album": e.get("album", ""),
                "duration_ms": e.get("duration", 0) * 1000,
                "image": f"/api/library/cover/{e['coverArt']}" if e.get("coverArt") else "",
                "type": "track",
            }
            for e in entries
        ]
        return {
            "id": pl.get("id", ""),
            "name": pl.get("name", ""),
            "description": pl.get("comment", ""),
            "songCount": pl.get("songCount", 0),
            "image": f"/api/library/cover/{pl['coverArt']}" if pl.get("coverArt") else "",
            "tracks": tracks,
        }


async def update_playlist(playlist_id: str, song_ids_to_add: list[str] | None = None,
                           song_indices_to_remove: list[int] | None = None) -> bool:
    """Add or remove tracks from a Navidrome playlist."""
    if not NAVIDROME_PASSWORD:
        return False
    # No-op request: nothing to add or remove. Return False so callers don't
    # report a successful "added"/"removed" when nothing happened.
    if not song_ids_to_add and not song_indices_to_remove:
        return False
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=30) as client:
        param_list = list(_params(playlistId=playlist_id).items())
        if song_ids_to_add:
            for sid in song_ids_to_add:
                param_list.append(("songIdToAdd", sid))
        if song_indices_to_remove:
            for idx in song_indices_to_remove:
                param_list.append(("songIndexToRemove", str(idx)))
        resp = await client.get("/rest/updatePlaylist", params=param_list)
        resp.raise_for_status()
        sr = resp.json().get("subsonic-response", {})
        return sr.get("status") == "ok"


async def remove_track_by_name(playlist_id: str, name: str, artist: str, index: int | None = None) -> bool:
    """Remove a track from a playlist by matching name/artist. When an explicit
    index is given and the track at that index still matches, that EXACT row is
    removed (duplicate-safe); otherwise falls back to the first name/artist match."""
    pl = await get_playlist(playlist_id)
    if not pl:
        return False
    tracks = pl["tracks"]
    # Prefer the exact clicked index when it still matches (handles duplicate songs)
    if index is not None and 0 <= index < len(tracks):
        t = tracks[index]
        if _matches(t.get("name", ""), name) and _artist_matches(t.get("artist", ""), artist):
            return await update_playlist(playlist_id, song_indices_to_remove=[index])
    # Fallback: first matching track index
    for i, track in enumerate(tracks):
        if _matches(track.get("name", ""), name) and _artist_matches(track.get("artist", ""), artist):
            return await update_playlist(playlist_id, song_indices_to_remove=[i])
    return False


async def update_playlist_details(playlist_id: str, name: str | None = None,
                                   comment: str | None = None) -> bool:
    """Update a playlist's name and/or comment (description) via Subsonic
    updatePlaylist. Passing an empty string clears the field; None leaves it
    unchanged. Returns False if nothing was provided to change."""
    if not NAVIDROME_PASSWORD:
        return False
    extra = {"playlistId": playlist_id}
    if name is not None:
        extra["name"] = name
    if comment is not None:
        extra["comment"] = comment
    # Nothing to change (only playlistId present)
    if len(extra) == 1:
        return False
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=10) as client:
        resp = await client.get("/rest/updatePlaylist", params=_params(**extra))
        resp.raise_for_status()
        sr = resp.json().get("subsonic-response", {})
        return sr.get("status") == "ok"


async def rename_playlist(playlist_id: str, name: str) -> bool:
    """Rename a Navidrome playlist."""
    if not name:
        return False
    return await update_playlist_details(playlist_id, name=name)


async def reorder_playlist(playlist_id: str, song_ids: list[str]) -> bool:
    """Reorder a playlist using add-before-remove to avoid data loss.

    Appends the new ordered ids FIRST, then removes the original leading
    entries only after all adds succeed. If any add fails, the original
    tracks are still intact (Subsonic appends, removes by current index)."""
    if not NAVIDROME_PASSWORD or not song_ids:
        return False
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=30) as client:
        pl = await get_playlist(playlist_id)
        if not pl:
            return False
        count = len(pl["tracks"])

        # Add new ordered ids FIRST (batches of 20). These append after the
        # existing `count` entries. Any failure here leaves originals intact.
        batch_size = 20
        for i in range(0, len(song_ids), batch_size):
            batch = song_ids[i:i + batch_size]
            param_list = list(_params(playlistId=playlist_id).items())
            for sid in batch:
                param_list.append(("songIdToAdd", sid))
            resp = await client.get("/rest/updatePlaylist", params=param_list)
            resp.raise_for_status()

        # Only after all adds succeeded: remove the ORIGINAL leading indices
        # (0..count-1), descending to avoid index shift.
        if count > 0:
            param_list = list(_params(playlistId=playlist_id).items())
            for i in range(count - 1, -1, -1):
                param_list.append(("songIndexToRemove", str(i)))
            resp = await client.get("/rest/updatePlaylist", params=param_list)
            resp.raise_for_status()

        return True


async def delete_playlist(playlist_id: str) -> bool:
    """Delete a playlist from Navidrome."""
    if not NAVIDROME_PASSWORD:
        return False
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=10) as client:
        resp = await client.get("/rest/deletePlaylist", params=_params(id=playlist_id))
        resp.raise_for_status()
        sr = resp.json().get("subsonic-response", {})
        return sr.get("status") == "ok"


def _cover_params() -> str:
    """Generate URL query string for getCoverArt auth."""
    import urllib.parse
    return urllib.parse.urlencode(_params())


UPNEXT_PREFIX = "__upnext_"
RADIO_PREFIX = "__radio_"
TEMP_PREFIXES = (UPNEXT_PREFIX, RADIO_PREFIX)
TEMP_PLAYLIST_KEEP = 8


def upnext_name(username: str, device_id: str) -> str:
    return f"{UPNEXT_PREFIX}{username}_{device_id}"


def radio_name(username: str, device_id: str) -> str:
    return f"{RADIO_PREFIX}{username}_{device_id}"


def is_upnext_name(name: str) -> bool:
    return (name or "").startswith(UPNEXT_PREFIX)


def is_temp_playlist_name(name: str) -> bool:
    return any((name or "").startswith(p) for p in TEMP_PREFIXES)


async def create_playlist_and_get_id(name: str, description: str | None = None) -> str | None:
    """Create an empty playlist; return the new ID, or None on failure.

    Subsonic's createPlaylist has no `comment` param, so an optional description
    is applied via a follow-up updatePlaylist call (best-effort — a failed
    description update does not fail the create)."""
    if not NAVIDROME_PASSWORD:
        return None
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=15) as client:
        resp = await client.get("/rest/createPlaylist", params=_params(name=name))
        resp.raise_for_status()
        sr = resp.json().get("subsonic-response", {})
        if sr.get("status") != "ok":
            return None
        new_id = sr.get("playlist", {}).get("id")
    if new_id and description is not None:
        await update_playlist_details(new_id, comment=description)
    return new_id


async def get_or_create_temp_playlist(target_name: str) -> dict | None:
    """Idempotently return a temp playlist by exact name."""
    playlists = await get_playlists()
    for p in playlists:
        if p.get("name") == target_name:
            full = await get_playlist(p["id"])
            return full or p
    new_id = await create_playlist_and_get_id(target_name)
    if not new_id:
        return None
    full = await get_playlist(new_id)
    return full or {"id": new_id, "name": target_name, "tracks": [], "songCount": 0}


async def gc_temp_playlists(username: str, prefix: str, keep: int = TEMP_PLAYLIST_KEEP,
                            keep_id: str | None = None) -> None:
    """Best-effort GC: cap how many temp playlists a user keeps per type.

    Selects playlists whose name startswith `prefix + username + "_"` (scopes
    precisely to the same user+type; the trailing `_` avoids matching a
    different user like `username2`), sorts by `changed` DESC (newest first;
    missing `changed` treated as oldest), keeps the newest `keep`, ALWAYS keeps
    `keep_id`, and deletes the rest. Never raises — swallows all errors so it
    can't break /upnext or /radio."""
    try:
        scope = f"{prefix}{username}_"
        playlists = await get_playlists()
        mine = [p for p in playlists if (p.get("name") or "").startswith(scope)]
        # Newest first; missing/empty `changed` sorts as oldest.
        mine.sort(key=lambda p: p.get("changed") or "", reverse=True)
        stale = mine[keep:]
        for p in stale:
            pid = p.get("id")
            if not pid or pid == keep_id:
                continue
            try:
                await delete_playlist(pid)
            except Exception:
                pass
    except Exception:
        pass


async def get_or_create_upnext(username: str, device_id: str) -> dict | None:
    pl = await get_or_create_temp_playlist(upnext_name(username, device_id))
    await gc_temp_playlists(username, UPNEXT_PREFIX, keep=TEMP_PLAYLIST_KEEP,
                            keep_id=pl.get("id") if pl else None)
    return pl


async def get_or_create_radio(username: str, device_id: str) -> dict | None:
    pl = await get_or_create_temp_playlist(radio_name(username, device_id))
    await gc_temp_playlists(username, RADIO_PREFIX, keep=TEMP_PLAYLIST_KEEP,
                            keep_id=pl.get("id") if pl else None)
    return pl


async def replace_playlist_by_names(playlist_id: str, tracks: list[dict]) -> dict:
    """Atomically replace a playlist's contents by matching tracks by name/artist.
    Tracks not in Navidrome are skipped and reported as `missing`.
    Returns {matched: int, missing: list[{name, artist, album}]}."""
    if not NAVIDROME_PASSWORD:
        return {"matched": 0, "missing": tracks or []}
    # Resolve all song IDs in parallel
    import asyncio as _aio
    sem = _aio.Semaphore(6)

    async def _resolve(t: dict):
        async with sem:
            sid = await find_song_id(t.get("name", ""), t.get("artist", ""), t.get("album", ""))
            return (t, sid)

    pairs = await _aio.gather(*[_resolve(t) for t in (tracks or [])])
    song_ids = [sid for _, sid in pairs if sid]
    missing = [t for t, sid in pairs if not sid]

    # Nothing matched: never clear the existing playlist on zero matches.
    if not song_ids:
        return {"matched": 0, "missing": missing}

    # Add-before-remove: add the new ids FIRST so a failed add leaves the
    # original tracks intact. Only remove the originals after adds succeed.
    pl = await get_playlist(playlist_id)
    orig_count = len(pl["tracks"]) if pl and pl.get("tracks") else 0

    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=30) as client:
        # Add new ids in batches (appended after the existing entries)
        batch_size = 20
        for i in range(0, len(song_ids), batch_size):
            batch = song_ids[i:i + batch_size]
            param_list = list(_params(playlistId=playlist_id).items())
            for sid in batch:
                param_list.append(("songIdToAdd", sid))
            resp = await client.get("/rest/updatePlaylist", params=param_list)
            resp.raise_for_status()

        # Only after all adds succeeded: remove the ORIGINAL leading entries
        # (indices 0..orig_count-1), descending to avoid index shift.
        if orig_count > 0:
            param_list = list(_params(playlistId=playlist_id).items())
            for i in range(orig_count - 1, -1, -1):
                param_list.append(("songIndexToRemove", str(i)))
            resp = await client.get("/rest/updatePlaylist", params=param_list)
            resp.raise_for_status()

    return {"matched": len(song_ids), "missing": missing}


async def create_playlist(name: str, song_ids: list[str]) -> bool:
    """Create a playlist in Navidrome via Subsonic API."""
    if not NAVIDROME_PASSWORD:
        return False
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=30) as client:
        # Step 1: Create empty playlist
        resp = await client.get("/rest/createPlaylist", params=_params(name=name))
        resp.raise_for_status()
        data = resp.json()
        sr = data.get("subsonic-response", {})
        if sr.get("status") != "ok":
            return False
        playlist_id = sr.get("playlist", {}).get("id")
        if not playlist_id:
            return False

        # Step 2: Add songs in batches (avoid URL length limits)
        batch_size = 20
        for i in range(0, len(song_ids), batch_size):
            batch = song_ids[i:i + batch_size]
            param_list = list(_params(playlistId=playlist_id).items())
            for sid in batch:
                param_list.append(("songIdToAdd", sid))
            resp = await client.get("/rest/updatePlaylist", params=param_list)
            resp.raise_for_status()

        return True
