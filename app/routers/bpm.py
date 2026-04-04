from fastapi import APIRouter, HTTPException, Depends

from app.services import auth, bpm, library

router = APIRouter(prefix="/api/bpm", tags=["bpm"])


@router.get("/track")
async def get_track_bpm(
    name: str, artist: str, song_id: str = "",
    force: bool = False,
    _user: dict = Depends(auth.get_current_user),
):
    """Get BPM for a single track. Analyzes if not cached."""
    if not force:
        cached = bpm.get_cached_bpm(name, artist)
        if cached:
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


@router.get("/cache")
async def get_bpm_cache(_user: dict = Depends(auth.get_current_user)):
    """Return all cached BPM data."""
    return bpm.get_all_cached()
