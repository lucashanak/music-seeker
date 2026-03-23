import hashlib
import os
import re
import secrets
import unicodedata
import httpx

NAVIDROME_URL = os.environ.get("NAVIDROME_URL", "http://navidrome:4533")
NAVIDROME_USER = os.environ.get("NAVIDROME_USER", "lucas")
NAVIDROME_PASSWORD = os.environ.get("NAVIDROME_PASSWORD", "")


def _params(**extra) -> dict:
    """Use Subsonic token auth (salt + md5) instead of plaintext password."""
    salt = secrets.token_hex(8)
    token = hashlib.md5((NAVIDROME_PASSWORD + salt).encode()).hexdigest()
    p = {
        "v": "1.16.1",
        "c": "music-seeker",
        "u": NAVIDROME_USER,
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


async def create_playlist(name: str, song_ids: list[str]) -> bool:
    """Create a playlist in Navidrome via Subsonic API."""
    if not NAVIDROME_PASSWORD or not song_ids:
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
