import hashlib
import os
import re
import secrets
import unicodedata
import asyncio
import functools
from contextlib import AsyncExitStack, asynccontextmanager
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


def bound_navidrome_user() -> str | None:
    """The Navidrome account bound to this request, or None when the request
    talks to Navidrome through the shared service account."""
    return (_req_creds.get() or {}).get("username") or None


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
    song = await find_song(name, artist, album)
    return song.get("id") if song else None


async def find_song(name: str, artist: str, album: str = "") -> dict | None:
    """The Subsonic song object find_song_id matches — for callers that also need to
    know what the file IS (suffix, bitRate), not only where it is."""
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
                return song
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
                "owner": p.get("owner", ""),
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
                # Entries come from a Navidrome playlist, so they were in the library at the last
                # scan (a deleted file stays listed until the next one). Informational only.
                "owned": True,
            }
            for e in entries
        ]
        return {
            "id": pl.get("id", ""),
            "name": pl.get("name", ""),
            "description": pl.get("comment", ""),
            "songCount": pl.get("songCount", 0),
            "owner": pl.get("owner", ""),
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
    """Make the playlist hold exactly `song_ids`, in that order.

    Subsonic can only append and remove by position, so the rows from the first
    difference onwards are appended in the new order and only THEN the old ones
    are removed: a failure half-way leaves the original rows intact. A move near
    the end of a long playlist therefore costs two writes, not a rewrite of all
    of it. Every write's Subsonic status is checked (Navidrome answers a refused
    write with HTTP 200); after a refused or failed append the rows appended so
    far are stripped again, so the playlist is left as it was."""
    if not NAVIDROME_PASSWORD or not song_ids:
        return False
    pl = await get_playlist(playlist_id)
    if not pl:
        return False
    old = [t.get("id") for t in pl["tracks"]]
    count = len(old)
    k = 0
    while k < count and k < len(song_ids) and old[k] == song_ids[k]:
        k += 1
    if k == count == len(song_ids):
        return True
    tail = song_ids[k:]
    appended = False
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=30) as client:
        async def _write(param_list) -> bool:
            resp = await client.get("/rest/updatePlaylist", params=param_list)
            resp.raise_for_status()
            try:
                return resp.json().get("subsonic-response", {}).get("status") == "ok"
            except ValueError:          # not JSON (a proxy error page): refused
                return False

        try:
            batch_size = 20
            for i in range(0, len(tail), batch_size):
                param_list = list(_params(playlistId=playlist_id).items())
                for sid in tail[i:i + batch_size]:
                    param_list.append(("songIdToAdd", sid))
                appended = True
                if not await _write(param_list):
                    raise TransferError("append refused")
            # All appended: remove the old rows k..count-1 (indices are those of
            # the list before this request).
            if count > k:
                param_list = list(_params(playlistId=playlist_id).items())
                for i in range(count - 1, k - 1, -1):
                    param_list.append(("songIndexToRemove", str(i)))
                if not await _write(param_list):
                    raise TransferError("strip refused")
            return True
        except BaseException as e:      # also a cancelled request (container restart)
            if appended:
                # Inline, not asyncio.shield: a shielded task is another task,
                # and the playlist lock this one holds would make it wait forever.
                landed = await _undo_append(playlist_id, old, tail, song_ids)
                if landed:
                    return True
            if isinstance(e, (TransferError, httpx.HTTPError)):
                return False
            raise


async def _undo_append(playlist_id: str, old: list[str], tail: list[str], wanted: list[str]) -> bool:
    """After a failed reorder: remove what it appended, and ONLY that — the rows
    are stripped only when the playlist is exactly the old list plus a prefix of
    the appended tail. Returns True when the reorder in fact landed (the answer
    to its last write was lost, not the write)."""
    try:
        pl = await get_playlist(playlist_id)
        if not pl:
            return False
        cur = [t.get("id") for t in pl["tracks"]]
        if cur == wanted:
            return True
        n = len(old)
        if cur[:n] == old and len(cur) > n and cur[n:] == tail[:len(cur) - n]:
            await update_playlist(playlist_id, song_indices_to_remove=list(range(len(cur) - 1, n - 1, -1)))
    except Exception:
        pass
    return False


# ── Playlist manager: move / copy / reorder one track ──
# Subsonic can only append (songIdToAdd) and remove by position
# (songIndexToRemove), so every operation here is a short sequence of those.
# Two rules keep it from losing a track:
#   * the client names the row by (index, song id) and the index must still hold
#     that song — a playlist changed elsewhere since it was drawn answers
#     TransferStale instead of removing whatever now sits there;
#   * a move ADDS to the target before it removes from the source, so a failure
#     half-way leaves a copy, never a loss.
# Writes on one playlist are serialised in-process: reorder_playlist appends the
# whole list and then strips the leading `count` rows, and two of those
# interleaved would strip the wrong rows.

class TransferError(Exception):
    """A playlist write Navidrome refused (e.g. a playlist the user does not own)."""


class TransferStale(Exception):
    """The source row no longer holds the song the client saw there."""


class TransferMissing(Exception):
    """A playlist that does not exist (or this user cannot see)."""


class TransferForbidden(Exception):
    """A playlist that belongs to someone else."""


def _check_owner(pl: dict, owner: str | None) -> None:
    # owner None = no check (internal callers); "" = the caller owns nothing.
    if owner is not None and (not owner or pl.get("owner") != owner):
        raise TransferForbidden(pl.get("id", ""))


_pl_locks: dict[str, "asyncio.Lock"] = {}
# Which task holds each playlist's lock: a locked write may call another locked
# write on the same playlist (asyncio.Lock is not re-entrant). Keyed by the
# owning TASK, not by context — a task spawned inside a locked region inherits
# the context but not the lock.
_pl_owner: dict[str, "asyncio.Task"] = {}


def _pl_lock(playlist_id: str):
    import asyncio as _aio
    lock = _pl_locks.get(str(playlist_id))
    if lock is None:
        lock = _pl_locks[str(playlist_id)] = _aio.Lock()
    return lock


@asynccontextmanager
async def playlist_lock(*playlist_ids: str):
    """Serialise writes to these playlists within this process. Acquired in
    sorted order (no deadlock between two cross-playlist transfers); re-entrant
    within one task."""
    import asyncio as _aio
    me = _aio.current_task()
    need = sorted({str(i) for i in playlist_ids if i is not None and _pl_owner.get(str(i)) is not me})
    async with AsyncExitStack() as stack:
        for pid in need:
            await stack.enter_async_context(_pl_lock(pid))
            _pl_owner[pid] = me
        try:
            yield
        finally:
            for pid in need:
                if _pl_owner.get(pid) is me:
                    del _pl_owner[pid]


def _serialised(fn):
    @functools.wraps(fn)
    async def wrapper(playlist_id, *args, **kwargs):
        async with playlist_lock(playlist_id):
            return await fn(playlist_id, *args, **kwargs)
    return wrapper


def _insert_at(ids: list[str], song_id: str, index: int | None) -> list[str]:
    out = list(ids)
    if index is None or index >= len(out):
        out.append(song_id)
    else:
        out.insert(max(0, index), song_id)
    return out


async def transfer_track(from_id: str, from_index: int, song_id: str, to_id: str,
                         to_index: int | None = None, copy: bool = False,
                         owner: str | None = None) -> dict:
    """Move (or copy) the track at `from_index` of `from_id` to position `to_index`
    of `to_id` (None = the end). Same playlist on both sides = a reorder.

    Returns {"status": "reordered"|"unchanged"|"moved"|"copied"|"already",
             "placed": bool, "removed": bool, "from": [tracks], "to": [tracks]}.
    `placed` is False when the track landed at the end because the reorder that
    puts it at `to_index` failed; `removed` is False when a move added the track
    but could not take it out of the source (it is then in both).
    With `owner`, both playlists must belong to that Navidrome account
    (TransferForbidden otherwise) — checked before anything is written."""
    if from_index < 0:
        raise TransferStale("bad index")
    async with playlist_lock(from_id, to_id):
        return await _transfer_locked(from_id, from_index, song_id, to_id, to_index, copy, owner)


async def remove_at(playlist_id: str, index: int, song_id: str,
                    owner: str | None = None) -> list[dict]:
    """Remove the row at `index` if it still holds `song_id` (TransferStale
    otherwise — never a name match, which can pick another track). Returns the
    playlist's tracks afterwards."""
    async with playlist_lock(playlist_id):
        pl = await get_playlist(playlist_id)
        if not pl:
            raise TransferMissing(playlist_id)
        _check_owner(pl, owner)
        if not _row_holds(pl["tracks"], index, song_id):
            raise TransferStale("row changed")
        if not await update_playlist(playlist_id, song_indices_to_remove=[index]):
            raise TransferError("remove refused")
        after = await get_playlist(playlist_id)
        return after["tracks"] if after else []


def _row_holds(tracks: list[dict], index: int, song_id: str) -> bool:
    return 0 <= index < len(tracks) and tracks[index].get("id") == song_id


async def _transfer_locked(from_id, from_index, song_id, to_id, to_index, copy, owner=None) -> dict:
    src = await get_playlist(from_id)
    if not src:
        raise TransferMissing(from_id)
    _check_owner(src, owner)
    if not _row_holds(src["tracks"], from_index, song_id):
        raise TransferStale("source changed")

    if from_id == to_id:
        ids = [t.get("id") for t in src["tracks"]]
        rest = ids[:from_index] + ids[from_index + 1:]
        new = _insert_at(rest, song_id, to_index)
        if new == ids:
            return {"status": "unchanged", "placed": True, "removed": False,
                    "from": src["tracks"], "to": src["tracks"]}
        if not await reorder_playlist(from_id, new):
            raise TransferError("reorder failed")
        after = await get_playlist(from_id)
        tracks = after["tracks"] if after else []
        return {"status": "reordered", "placed": True, "removed": False, "from": tracks, "to": tracks}

    dst = await get_playlist(to_id)
    if not dst:
        raise TransferMissing(to_id)
    _check_owner(dst, owner)
    dst_ids = [t.get("id") for t in dst["tracks"]]
    already = song_id in dst_ids
    placed = True
    if not already:
        if not await update_playlist(to_id, song_ids_to_add=[song_id]):
            raise TransferError("add failed")
        if to_index is not None and to_index < len(dst_ids):
            # On failure reorder_playlist leaves the playlist as it was: the
            # track stays appended at the end, which `placed` reports.
            placed = await reorder_playlist(to_id, _insert_at(dst_ids, song_id, to_index))

    removed = False
    if not copy:
        # Read the source again: the add above took a round trip, and the row is
        # removed by position.
        now = await get_playlist(from_id)
        if now:
            idx = from_index if _row_holds(now["tracks"], from_index, song_id) else next(
                (i for i, t in enumerate(now["tracks"]) if t.get("id") == song_id), -1)
            if idx >= 0:
                try:
                    removed = await update_playlist(from_id, song_indices_to_remove=[idx])
                except httpx.HTTPError:
                    removed = False

    src_after = await get_playlist(from_id)
    dst_after = await get_playlist(to_id)
    status = "already" if already else ("copied" if copy else "moved")
    return {"status": status, "placed": placed, "removed": removed,
            "from": src_after["tracks"] if src_after else [],
            "to": dst_after["tracks"] if dst_after else []}


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
    # Locked from here only: resolving the names above can take seconds.
    async with playlist_lock(playlist_id):
        return await _replace_ids(playlist_id, song_ids, missing)


async def _replace_ids(playlist_id: str, song_ids: list[str], missing: list[dict]) -> dict:
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


# Every write to a playlist's track list goes through the per-playlist lock, so a
# reorder (append, then strip the old rows) cannot interleave with another write
# to the same playlist from this process — the queue mirror, the ✕ in the queue
# panel, a download finishing into a playlist, the manager.
update_playlist = _serialised(update_playlist)
remove_track_by_name = _serialised(remove_track_by_name)
reorder_playlist = _serialised(reorder_playlist)
