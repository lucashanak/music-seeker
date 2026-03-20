import os
import re
import unicodedata
import httpx

NAVIDROME_URL = os.environ.get("NAVIDROME_URL", "http://navidrome:4533")
NAVIDROME_PASSWORD = os.environ.get("NAVIDROME_PASSWORD", "")

NAVIDROME_USER = os.environ.get("NAVIDROME_USER", "lucas")

_SUBSONIC_PARAMS = {
    "v": "1.16.1",
    "c": "music-seeker",
    "u": NAVIDROME_USER,
    "f": "json",
}


def _params(**extra) -> dict:
    p = {**_SUBSONIC_PARAMS, "p": NAVIDROME_PASSWORD}
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

    # Deduplicate queries to avoid redundant API calls
    queries: dict[str, dict] = {}
    for i, item in enumerate(items):
        name = item.get("name", "")
        artist = item.get("artist", "")
        item_type = item.get("type", "track")
        key = f"{item_type}:{_normalize(artist)}:{_normalize(name)}"
        if key not in queries:
            queries[key] = {"name": name, "artist": artist, "type": item_type, "indices": []}
        queries[key]["indices"].append(i)

    results = [False] * len(items)

    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=10) as client:
        for key, q in queries.items():
            try:
                found = await _search_navidrome(client, q["name"], q["artist"], q["type"])
                for idx in q["indices"]:
                    results[idx] = found
            except Exception:
                pass

    return results


async def _search_navidrome(client: httpx.AsyncClient, name: str, artist: str, item_type: str) -> bool:
    # Search by track/album name — more specific queries yield better matches
    query = name
    params = _params(query=query, songCount=50, albumCount=20, artistCount=20)
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

    elif item_type == "artist":
        for a in sr.get("artist", []):
            if _matches(a.get("name", ""), artist or name):
                return True

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


async def find_song_id(name: str, artist: str) -> str | None:
    """Find a song's Navidrome ID by name and artist."""
    if not NAVIDROME_PASSWORD:
        return None
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=10) as client:
        params = _params(query=name, songCount=50, albumCount=0, artistCount=0)
        resp = await client.get("/rest/search3", params=params)
        resp.raise_for_status()
        sr = resp.json().get("subsonic-response", {}).get("searchResult3", {})
        for song in sr.get("song", []):
            if _matches(song.get("title", ""), name) and _artist_matches(song.get("artist", ""), artist):
                return song.get("id")
    return None


async def create_playlist(name: str, song_ids: list[str]) -> bool:
    """Create a playlist in Navidrome via Subsonic API."""
    if not NAVIDROME_PASSWORD or not song_ids:
        return False
    # Build params as list of tuples to support repeated songId
    param_list = list(_params(name=name).items())
    for sid in song_ids:
        param_list.append(("songId", sid))
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=30) as client:
        resp = await client.get("/rest/createPlaylist", params=param_list)
        resp.raise_for_status()
        data = resp.json()
        return data.get("subsonic-response", {}).get("status") == "ok"
