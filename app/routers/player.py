import os

from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.responses import StreamingResponse, FileResponse

from app.models import QueueState, AddToQueueRequest, RecommendationRequest
from app.services import auth, player, radio, settings as app_settings
from app.dependencies import _stream_auth

router = APIRouter(prefix="/api/player", tags=["player"])


@router.get("/stream")
async def player_stream(name: str, artist: str = "", user: dict = Depends(_stream_auth)):
    result = await player.resolve_stream(name, artist)
    if not result:
        raise HTTPException(404, "Could not resolve stream for this track")
    source = result["source"]
    headers = {"X-Stream-Source": source}
    if source == "local":
        path = result["path"]
        ext = os.path.splitext(path)[1].lower()
        if ext == ".mp3" and os.path.isfile(path):
            # Serve MP3 directly with Range support (Safari needs this for duration/seek)
            return FileResponse(path, media_type="audio/mpeg", headers=headers)
        # Non-MP3: transcode to MP3 via ffmpeg
        return StreamingResponse(player.stream_local_file(path), media_type="audio/mpeg", headers=headers)
    elif source == "navidrome":
        return StreamingResponse(player.stream_navidrome(result["song_id"]), media_type="audio/mpeg", headers=headers)
    else:
        return StreamingResponse(player.stream_youtube(result["url"]), media_type="audio/mpeg", headers=headers)


@router.get("/queue")
async def get_player_queue(user: dict = Depends(auth.get_current_user)):
    return player.load_queue(user["username"])


@router.put("/queue")
async def save_player_queue(state: QueueState, user: dict = Depends(auth.get_current_user)):
    player.save_queue(user["username"], state.model_dump())
    return {"status": "saved"}


@router.post("/queue/add")
async def add_to_queue(req: AddToQueueRequest, user: dict = Depends(auth.get_current_user)):
    state = player.load_queue(user["username"])
    state["queue"].extend(req.tracks)
    if req.play_now or state["current_index"] < 0:
        state["current_index"] = len(state["queue"]) - len(req.tracks)
        state["position_seconds"] = 0.0
    player.save_queue(user["username"], state)
    return state


@router.delete("/queue")
async def clear_player_queue(user: dict = Depends(auth.get_current_user)):
    player.clear_queue(user["username"])
    return {"status": "cleared"}


@router.get("/resolve-source")
async def resolve_source(name: str, artist: str = "", user: dict = Depends(auth.get_current_user)):
    """Resolve stream source without streaming. Returns source type."""
    result = await player.resolve_stream(name, artist)
    if not result:
        raise HTTPException(404, "Could not resolve")
    return {"source": result["source"]}


@router.get("/recommendations")
async def get_queue_recommendations(
    limit: int = Query(15, ge=1, le=50),
    user: dict = Depends(auth.get_current_user),
):
    """Get recommendations based on the user's current queue."""
    queue_data = player.load_queue(user["username"])
    tracks = queue_data.get("queue", [])
    if not tracks:
        raise HTTPException(400, "Queue is empty")
    source = app_settings._settings.get("recommendation_source", "combined")
    recs = await radio.get_playlist_recommendations(tracks, source, limit, exclude=tracks)
    return {"tracks": recs}


@router.post("/recommendations")
async def get_playlist_recommendations(
    req: RecommendationRequest,
    user: dict = Depends(auth.get_current_user),
):
    """Get recommendations based on an explicit track list."""
    if not req.tracks:
        raise HTTPException(400, "No tracks provided")
    source = app_settings._settings.get("recommendation_source", "combined")
    recs = await radio.get_playlist_recommendations(req.tracks, source, req.limit, exclude=req.tracks)
    return {"tracks": recs}
