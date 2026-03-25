from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import Response

from app.models import CreatePlaylistRequest, AddTracksByIdRequest, RemoveTracksRequest, AddTrackByNameRequest
from app.services import auth, library

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


@router.delete("/playlist/{playlist_id}")
async def delete_playlist(playlist_id: str, user: dict = Depends(auth.get_current_user)):
    ok = await library.delete_playlist(playlist_id)
    if not ok:
        raise HTTPException(500, "Failed to delete playlist")
    return {"status": "deleted"}
