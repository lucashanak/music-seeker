from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import Response

import asyncio

from app.models import CreatePlaylistRequest, AddTracksByIdRequest, RemoveTracksRequest, AddTrackByNameRequest
from app.services import auth, library, downloader, player
from app.services.jobs import create_job

router = APIRouter(prefix="/api/library", tags=["library"])


@router.get("/cover/{cover_id}")
async def get_cover_art(cover_id: str):
    data = await library.get_cover_art(cover_id)
    if not data:
        raise HTTPException(404, "Cover art not found")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/playlists")
async def get_playlists(user: dict = Depends(auth.get_current_user)):
    playlists = await library.get_playlists()
    return {"playlists": playlists}


@router.get("/playlist/{playlist_id}")
async def get_playlist(playlist_id: str, user: dict = Depends(auth.get_current_user)):
    pl = await library.get_playlist(playlist_id)
    if not pl:
        raise HTTPException(404, "Playlist not found")
    return pl


@router.post("/playlist")
async def create_playlist(req: CreatePlaylistRequest, user: dict = Depends(auth.get_current_user)):
    ok = await library.create_playlist(req.name, [])
    if not ok:
        raise HTTPException(500, "Failed to create playlist")
    return {"status": "created"}


@router.put("/playlist/{playlist_id}/tracks")
async def add_tracks_to_playlist(playlist_id: str, req: AddTracksByIdRequest, user: dict = Depends(auth.get_current_user)):
    ok = await library.update_playlist(playlist_id, song_ids_to_add=req.song_ids)
    if not ok:
        raise HTTPException(500, "Failed to add tracks")
    return {"status": "ok"}


@router.post("/playlist/{playlist_id}/add-by-name")
async def add_track_by_name(playlist_id: str, req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    song_id = await library.find_song_id(req.name, req.artist, req.album)
    if not song_id:
        raise HTTPException(404, "Track not found in Navidrome library")
    ok = await library.update_playlist(playlist_id, song_ids_to_add=[song_id])
    if not ok:
        raise HTTPException(500, "Failed to add track")
    return {"status": "ok", "song_id": song_id}


@router.delete("/playlist/{playlist_id}/tracks")
async def remove_tracks_from_playlist(playlist_id: str, req: RemoveTracksRequest, user: dict = Depends(auth.get_current_user)):
    ok = await library.update_playlist(playlist_id, song_indices_to_remove=req.indices)
    if not ok:
        raise HTTPException(500, "Failed to remove tracks")
    return {"status": "ok"}


@router.post("/playlist/{playlist_id}/remove-by-name")
async def remove_track_by_name(playlist_id: str, req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    """Remove a track from playlist by name/artist match."""
    ok = await library.remove_track_by_name(playlist_id, req.name, req.artist)
    if not ok:
        raise HTTPException(404, "Track not found in playlist")
    return {"status": "removed"}


@router.post("/playlist/{playlist_id}/add-and-download")
async def add_and_download(playlist_id: str, req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    """Add track to playlist. If not in Navidrome, download first then add."""
    # Try to find in Navidrome first
    song_id = await library.find_song_id(req.name, req.artist, req.album)
    if song_id:
        ok = await library.update_playlist(playlist_id, song_ids_to_add=[song_id])
        return {"status": "added" if ok else "error"}

    # Not in library — start download with playlist_id callback
    from app.services import settings as app_settings
    fmt = app_settings._settings.get("default_format", "flac")
    method = app_settings._settings.get("default_method", "yt-dlp")
    title = f"{req.artist} - {req.name}" if req.artist else req.name
    job = create_job(
        type_="track", title=title, url="", method=method, fmt=fmt,
        playlist_id=playlist_id,
        playlist_tracks=[{"name": req.name, "artist": req.artist, "album": req.album}],
        username=user["username"],
    )
    asyncio.create_task(downloader.run_download(job))
    return {"status": "downloading", "job_id": job.id}


@router.post("/track/delete")
async def delete_track(req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    """Delete a track file from disk. Returns playlists it belongs to for confirmation."""
    # Check which playlists contain this track
    playlists = await library.get_playlists()
    in_playlists = []
    for pl in playlists:
        detail = await library.get_playlist(pl["id"])
        if not detail:
            continue
        for t in detail["tracks"]:
            if library._matches(t.get("name", ""), req.name) and library._artist_matches(t.get("artist", ""), req.artist):
                in_playlists.append({"id": pl["id"], "name": pl["name"]})
                break

    # Delete the file
    ok = player.delete_track_file(req.name, req.artist)
    if not ok:
        raise HTTPException(404, "Track file not found")

    # Trigger Navidrome scan to update index
    await downloader._trigger_navidrome_scan()

    return {"status": "deleted", "in_playlists": in_playlists}


@router.post("/track/check-playlists")
async def check_track_playlists(req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    """Check which playlists contain a track (for delete confirmation)."""
    playlists = await library.get_playlists()
    in_playlists = []
    for pl in playlists:
        detail = await library.get_playlist(pl["id"])
        if not detail:
            continue
        for t in detail["tracks"]:
            if library._matches(t.get("name", ""), req.name) and library._artist_matches(t.get("artist", ""), req.artist):
                in_playlists.append({"id": pl["id"], "name": pl["name"]})
                break
    has_file = player.find_track_file(req.name, req.artist) is not None
    return {"has_file": has_file, "in_playlists": in_playlists}


@router.delete("/playlist/{playlist_id}")
async def delete_playlist(playlist_id: str, user: dict = Depends(auth.get_current_user)):
    ok = await library.delete_playlist(playlist_id)
    if not ok:
        raise HTTPException(500, "Failed to delete playlist")
    return {"status": "deleted"}
