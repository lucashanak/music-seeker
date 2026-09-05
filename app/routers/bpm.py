from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from app.services import auth, bpm, library
from app.dependencies import bind_navidrome_creds

# Router-level so it cannot be forgotten on a new endpoint: every handler here
# can reach Navidrome (directly or through a service), and without the binding
# it silently acts as the shared `lucas` service account.
router = APIRouter(prefix="/api/bpm", tags=["bpm"],
                   dependencies=[Depends(bind_navidrome_creds)])

# Cap on bulk lookup list size to avoid unbounded work / huge payloads.
LOOKUP_MAX = 500
# Default cap on how many uncached tracks a single analyze=true request will scan.
LOOKUP_ANALYZE_DEFAULT = 25


class LookupTrack(BaseModel):
    name: str
    artist: str = ""


class LookupByNameRequest(BaseModel):
    tracks: list[LookupTrack]
    analyze: bool = False
    limit: int = LOOKUP_ANALYZE_DEFAULT


@router.get("/track")
async def get_track_bpm(
    name: str, artist: str, song_id: str = "",
    force: bool = False,
    _user: dict = Depends(auth.get_current_user),
):
    """Get BPM for a single track. Analyzes if not cached."""
    if not force:
        cached = bpm.get_cached_bpm(name, artist)
        # Fast path only when the cached entry already has the current feature set.
        # If energy/key_confidence are missing/stale, fall through to analyze_track, whose
        # cache-hit branch runs the cheap _backfill_features WITHOUT recomputing BPM.
        # Once backfilled, subsequent requests hit this fast path again.
        if cached and cached.get("feature_version") == bpm.FEATURE_VERSION:
            return cached

    if not song_id:
        song_id = await library.find_song_id(name, artist) or ""

    result = await bpm.analyze_track(song_id, name, artist, force=force)
    if not result:
        raise HTTPException(404, "Could not analyze track — audio not available")
    return result


@router.get("/playlist/{playlist_id}")
async def get_playlist_bpm(
    playlist_id: str,
    scan: bool = False,
    limit: int = 0,
    _user: dict = Depends(auth.get_current_user),
):
    """Get BPM for playlist tracks.

    Default: returns only cached BPM data (fast).
    With ?scan=true: analyzes tracks that aren't cached yet.
    With ?limit=N: only analyze up to N uncached tracks per request.
    """
    pl = await library.get_playlist(playlist_id)
    if not pl:
        raise HTTPException(404, "Playlist not found")

    if scan:
        results = await bpm.analyze_playlist(playlist_id, limit=limit or 0)
    else:
        results = []
        for track in pl["tracks"]:
            cached = bpm.get_cached_bpm(track["name"], track["artist"])
            if cached:
                results.append(cached)

    return {
        "playlist": pl["name"],
        "track_count": len(pl["tracks"]),
        "analyzed": len(results),
        "tracks": results,
    }


@router.post("/lookup-by-name")
async def lookup_bpm_by_name(
    req: LookupByNameRequest,
    _user: dict = Depends(auth.get_current_user),
):
    """Bulk cached-BPM hydration for list views (album/Spotify-playlist/search).

    Default (analyze=false): cached-only, fast — NO audio/Navidrome stream access.
    Mirrors GET /api/bpm/playlist semantics so the frontend cache loop is reused.
    Uncached/unowned tracks are simply absent from the response.

    With analyze=true: analyzes up to `limit` uncached tracks (default 25); tracks
    with no audio source return no record (no error). Owned-only by nature.
    """
    truncated = len(req.tracks) > LOOKUP_MAX
    tracks = req.tracks[:LOOKUP_MAX]

    results = []
    if not req.analyze:
        for t in tracks:
            cached = bpm.get_cached_bpm(t.name, t.artist)
            if cached:
                results.append(cached)
        return {
            "found": len(results),
            "requested": len(tracks),
            "truncated": truncated,
            "tracks": results,
        }

    # analyze=true: serve cache hits immediately, analyze a bounded set of misses.
    # Hard-clamp the analyze limit regardless of what the client sent.
    ANALYZE_MAX = 50
    to_analyze = []
    for t in tracks:
        cached = bpm.get_cached_bpm(t.name, t.artist)
        if cached:
            results.append(cached)
        else:
            to_analyze.append(t)

    limit = min(req.limit if req.limit and req.limit > 0 else LOOKUP_ANALYZE_DEFAULT, ANALYZE_MAX)
    for t in to_analyze[:limit]:
        song_id = await library.find_song_id(t.name, t.artist) or ""
        rec = await bpm.analyze_track(song_id, t.name, t.artist)
        if rec:
            results.append(rec)

    return {
        "found": len(results),
        "requested": len(tracks),
        "truncated": truncated,
        "tracks": results,
    }


@router.get("/cache")
async def get_bpm_cache(_user: dict = Depends(auth.get_current_user)):
    """Return all cached BPM data."""
    return bpm.get_all_cached()
