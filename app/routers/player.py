import os

from fastapi import APIRouter, HTTPException, Depends, Query, Request
from fastapi.responses import StreamingResponse, FileResponse

from app.models import QueueState, AddToQueueRequest, RecommendationRequest
from app.services import auth, player, radio, settings as app_settings
from app.dependencies import _stream_auth, _get_device_id

router = APIRouter(prefix="/api/player", tags=["player"])


def _mime_for_path(path: str) -> str:
    """Return correct MIME type based on file extension."""
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return {"flac": "audio/flac", "opus": "audio/ogg", "m4a": "audio/mp4"}.get(ext, "audio/mpeg")


@router.head("/stream")
async def player_stream_head(name: str, artist: str = "", quality: str = "standard",
                              user: dict = Depends(_stream_auth)):
    """HEAD request for DLNA renderers to check MIME type before fetching."""
    lossless = quality == "lossless"
    result = await player.resolve_stream(name, artist)
    if not result:
        raise HTTPException(404, "Could not resolve stream for this track")
    mime = "audio/mpeg"
    headers = {"X-Stream-Source": result["source"], "Accept-Ranges": "bytes"}
    if result["source"] == "local":
        mime = _mime_for_path(result["path"])
        size = os.path.getsize(result["path"])
        headers["Content-Length"] = str(size)
    elif result["source"] == "navidrome":
        cached = await player.cache_navidrome_stream(result["song_id"], lossless=lossless)
        if cached:
            mime = _mime_for_path(cached) if lossless else "audio/mpeg"
            headers["Content-Length"] = str(os.path.getsize(cached))
    headers["Content-Type"] = mime
    from fastapi.responses import Response
    return Response(content=b"", headers=headers, media_type=mime)


@router.get("/stream")
async def player_stream(name: str, artist: str = "", quality: str = "standard",
                         user: dict = Depends(_stream_auth)):
    lossless = quality == "lossless"
    result = await player.resolve_stream(name, artist)
    if not result:
        raise HTTPException(404, "Could not resolve stream for this track")
    source = result["source"]
    headers = {"X-Stream-Source": source}
    if source == "local":
        path = result["path"]
        mime = _mime_for_path(path)
        # FileResponse supports Range requests (required by Safari for duration/seek)
        return FileResponse(path, media_type=mime, headers=headers)
    elif source == "navidrome":
        # Try cached file first (supports Range requests, seeking, correct duration)
        cached = await player.cache_navidrome_stream(result["song_id"], lossless=lossless)
        if cached:
            mime = _mime_for_path(cached) if lossless else "audio/mpeg"
            return FileResponse(cached, media_type=mime, headers=headers)
        mime = "audio/flac" if lossless else "audio/mpeg"
        return StreamingResponse(player.stream_navidrome(result["song_id"], lossless=lossless),
                                  media_type=mime, headers=headers)
    else:
        bitrate = "320k" if lossless else "192k"
        # Try cached file first for proper duration/seeking
        cached = await player.cache_youtube_stream(result["url"], name, artist, bitrate=bitrate)
        if cached:
            return FileResponse(cached, media_type="audio/mpeg", headers=headers)
        return StreamingResponse(player.stream_youtube(result["url"], bitrate=bitrate),
                                  media_type="audio/mpeg", headers=headers)


@router.get("/queue")
async def get_player_queue(request: Request, user: dict = Depends(auth.get_current_user)):
    device_id = _get_device_id(request)
    return player.load_queue(user["username"], device_id)


@router.put("/queue")
async def save_player_queue(state: QueueState, request: Request, user: dict = Depends(auth.get_current_user)):
    device_id = _get_device_id(request)
    player.save_queue(user["username"], state.model_dump(), device_id)
    return {"status": "saved"}


@router.post("/queue/add")
async def add_to_queue(req: AddToQueueRequest, request: Request, user: dict = Depends(auth.get_current_user)):
    device_id = _get_device_id(request)
    state = player.load_queue(user["username"], device_id)
    state["queue"].extend(req.tracks)
    if req.play_now or state["current_index"] < 0:
        state["current_index"] = len(state["queue"]) - len(req.tracks)
        state["position_seconds"] = 0.0
    player.save_queue(user["username"], state, device_id)
    return state


@router.delete("/queue")
async def clear_player_queue(request: Request, user: dict = Depends(auth.get_current_user)):
    device_id = _get_device_id(request)
    player.clear_queue(user["username"], device_id)
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
    request: Request,
    limit: int = Query(15, ge=1, le=50),
    user: dict = Depends(auth.get_current_user),
):
    """Get recommendations based on the user's current queue."""
    device_id = _get_device_id(request)
    queue_data = player.load_queue(user["username"], device_id)
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
