import asyncio
import os

from fastapi import APIRouter, HTTPException, Depends, Query, Request
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse

from app.models import QueueState, AddToQueueRequest, RecommendationRequest, PrewarmRequest
from app.services import auth, player, radio, settings as app_settings
from app.dependencies import _stream_auth, _get_device_id, bind_navidrome_creds

router = APIRouter(prefix="/api/player", tags=["player"])

# Retains references to fire-and-forget pre-warm tasks so they are not GC'd
# mid-flight (asyncio only weakly references unawaited tasks).
_prewarm_tasks: set[asyncio.Task] = set()


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
        path = result["path"]
        is_mp3 = path.rsplit(".", 1)[-1].lower() == "mp3" if "." in path else False
        # Match GET: non-mp3 local files are served as a cached 320k MP3 unless
        # lossless was requested, so report that file's MIME + Content-Length.
        if not is_mp3 and not lossless:
            # Non-blocking: report cached MP3 size/MIME if already built;
            # otherwise report raw file (HEAD must never trigger/await a transcode).
            # Mirrors GET's raw pin so a renderer's HEAD and GET agree on which
            # representation (and therefore which Content-Length) it is getting.
            cached = player.local_transcode_cached_path(path)
            if cached and not player.raw_pinned(path):
                mime = "audio/mpeg"
                headers["Content-Length"] = str(os.path.getsize(cached))
            else:
                mime = _mime_for_path(path)
                headers["Content-Length"] = str(os.path.getsize(path))
        else:
            mime = _mime_for_path(path)
            headers["Content-Length"] = str(os.path.getsize(path))
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
    # Owned/cached files are immutable per song → let the browser HTTP cache
    # serve repeat plays (1 day). Only applied to seekable FileResponse paths,
    # never to the live chunked StreamingResponse fallback.
    file_headers = {**headers, "Cache-Control": "private, max-age=86400"}
    if source == "local":
        path = result["path"]
        is_mp3 = path.rsplit(".", 1)[-1].lower() == "mp3" if "." in path else False
        # Local FLAC is the only fat-blob path (Navidrome/YouTube are already 320k
        # MP3). Transcode non-mp3 local files to a cached 320k MP3 so prefetch blobs
        # shrink — unless lossless was requested (audiophile/DLNA path → raw FLAC).
        if not is_mp3 and not lossless:
            # Non-blocking check: serve cached MP3 if already built (warm path).
            # `raw_pinned` vetoes it while a playback that started on the raw file
            # may still be range-requesting its tail — swapping the shorter MP3 in
            # under that play 416s the remaining bytes and silences the track's
            # last stretch (see pin_raw_local in services/player.py).
            cached = player.local_transcode_cached_path(path)
            if cached and not player.raw_pinned(path):
                return FileResponse(cached, media_type="audio/mpeg", headers=file_headers)
            # Cold path: build the compact MP3 cache in the background (so a LATER
            # play gets the smaller cached MP3) but serve the RAW file NOW via
            # FileResponse. A raw file carries a Content-Length + Range support, so
            # the browser learns the real, FINITE duration up front. The old chunked
            # StreamingResponse had no Content-Length → the <audio> element saw
            # duration=Infinity and the on-the-fly transcode's stream `ended` a few
            # seconds SHORT of the real length, so the track restarted from 0 before
            # the shown end and only finished on the (now cached) second play.
            # Correctness beats the one-time larger cold transfer; Range keeps it
            # progressive+seekable, and `headers` (no long max-age) lets the next
            # play revalidate and pick up the cached MP3.
            if not cached:
                t = asyncio.create_task(player.cache_local_transcode(path))
                _prewarm_tasks.add(t)
                t.add_done_callback(_prewarm_tasks.discard)
            # Pin BEFORE responding so a concurrent request for the same path
            # cannot pick the MP3 while this one hands out raw byte offsets.
            player.pin_raw_local(path)
            return FileResponse(path, media_type=_mime_for_path(path), headers=headers)
        mime = _mime_for_path(path)
        # FileResponse supports Range requests (required by Safari for duration/seek)
        return FileResponse(path, media_type=mime, headers=file_headers)
    elif source == "navidrome":
        # Try cached file first (supports Range requests, seeking, correct duration)
        cached = await player.cache_navidrome_stream(result["song_id"], lossless=lossless)
        if cached:
            mime = _mime_for_path(cached) if lossless else "audio/mpeg"
            return FileResponse(cached, media_type=mime, headers=file_headers)
        mime = "audio/flac" if lossless else "audio/mpeg"
        return StreamingResponse(player.stream_navidrome(result["song_id"], lossless=lossless),
                                  media_type=mime, headers=headers)
    else:
        bitrate = "320k" if lossless else "192k"
        # Try cached file first for proper duration/seeking
        cached = await player.cache_youtube_stream(result["url"], name, artist, bitrate=bitrate)
        if cached:
            return FileResponse(cached, media_type="audio/mpeg", headers=file_headers)
        return StreamingResponse(player.stream_youtube(result["url"], bitrate=bitrate),
                                  media_type="audio/mpeg", headers=headers)


async def _prewarm_track(track: dict, lossless: bool) -> None:
    """Best-effort: build the server stream cache for one upcoming track using
    the SAME resolution path as GET /stream. Never raises (swallows all errors)
    and never blocks playback — runs as fire-and-forget background work. The
    underlying cache builders are idempotent + per-song locked, so this safely
    races the real stream GET without double-transcoding."""
    try:
        name = (track or {}).get("name") or ""
        artist = (track or {}).get("artist") or ""
        if not name:
            return
        result = await player.resolve_stream(name, artist)
        if not result:
            return
        source = result["source"]
        if source == "navidrome":
            # Idempotent + locked: builds the transcoded/cached file if missing.
            await player.cache_navidrome_stream(result["song_id"], lossless=lossless)
        elif source == "youtube":
            bitrate = "320k" if lossless else "192k"
            await player.cache_youtube_stream(result["url"], name, artist, bitrate=bitrate)
        elif source == "local":
            # Non-mp3 local files (FLAC) are transcoded to a cached 320k MP3 on
            # GET; warm it here (idempotent + locked) so the first track doesn't
            # pay a cold transcode on its first GET. mp3 files are already fast.
            path = result["path"]
            is_mp3 = path.rsplit(".", 1)[-1].lower() == "mp3" if "." in path else False
            if not is_mp3 and not lossless:
                await player.cache_local_transcode(path)
    except Exception:
        # Pre-warm is best-effort: never surface errors.
        pass


@router.post("/prewarm")
async def player_prewarm(req: PrewarmRequest, quality: str = "standard",
                          user: dict = Depends(bind_navidrome_creds)):
    """Pre-warm the server stream cache for the upcoming first track(s) so its
    first GET /stream pays no cold-start transcode latency. Fire-and-forget:
    returns 202 immediately and never blocks on the build. Local-file tracks are
    skipped (already fast); per-track errors are swallowed (never 500)."""
    lossless = quality == "lossless"
    tracks = (req.tracks or [])[:3]  # bounded to <=3
    for track in tracks:
        t = asyncio.create_task(_prewarm_track(track, lossless))
        _prewarm_tasks.add(t)
        t.add_done_callback(_prewarm_tasks.discard)
    return JSONResponse(status_code=202, content={"status": "warming", "count": len(tracks)})


@router.get("/stream-token")
async def get_stream_token(user: dict = Depends(bind_navidrome_creds)):
    """Mint a short-lived, stream-scoped token for <audio>/prefetch stream URLs,
    so the full session JWT never appears in a URL/log/Referer."""
    return {"token": auth.create_stream_token(user["username"])}


@router.get("/queue")
async def get_player_queue(request: Request, user: dict = Depends(bind_navidrome_creds)):
    device_id = _get_device_id(request)
    return player.load_queue(user["username"], device_id)


@router.put("/queue")
async def save_player_queue(state: QueueState, request: Request, user: dict = Depends(bind_navidrome_creds)):
    device_id = _get_device_id(request)
    player.save_queue(user["username"], state.model_dump(), device_id)
    return {"status": "saved"}


@router.post("/queue/add")
async def add_to_queue(req: AddToQueueRequest, request: Request, user: dict = Depends(bind_navidrome_creds)):
    device_id = _get_device_id(request)
    state = player.load_queue(user["username"], device_id)
    state["queue"].extend(req.tracks)
    if req.play_now or state["current_index"] < 0:
        state["current_index"] = len(state["queue"]) - len(req.tracks)
        state["position_seconds"] = 0.0
    player.save_queue(user["username"], state, device_id)
    return state


@router.delete("/queue")
async def clear_player_queue(request: Request, user: dict = Depends(bind_navidrome_creds)):
    device_id = _get_device_id(request)
    player.clear_queue(user["username"], device_id)
    return {"status": "cleared"}


@router.get("/resolve-source")
async def resolve_source(name: str, artist: str = "", user: dict = Depends(bind_navidrome_creds)):
    """Resolve stream source without streaming. Returns source type."""
    result = await player.resolve_stream(name, artist)
    if not result:
        raise HTTPException(404, "Could not resolve")
    return {"source": result["source"]}


@router.get("/recommendations")
async def get_queue_recommendations(
    request: Request,
    limit: int = Query(15, ge=1, le=50),
    user: dict = Depends(bind_navidrome_creds),
):
    """Get recommendations based on the user's current queue."""
    device_id = _get_device_id(request)
    queue_data = player.load_queue(user["username"], device_id)
    tracks = queue_data.get("queue", [])
    if not tracks:
        raise HTTPException(400, "Queue is empty")
    source = app_settings._settings.get("recommendation_source", "combined")
    recs = await radio.get_playlist_recommendations(tracks, source, limit, exclude=tracks, user=user)
    return {"tracks": recs}


@router.post("/recommendations")
async def get_playlist_recommendations(
    req: RecommendationRequest,
    user: dict = Depends(bind_navidrome_creds),
):
    """Get recommendations based on an explicit track list."""
    if not req.tracks:
        raise HTTPException(400, "No tracks provided")
    source = app_settings._settings.get("recommendation_source", "combined")
    recs = await radio.get_playlist_recommendations(
        req.tracks, source, req.limit,
        exclude=req.tracks, skipped=req.skipped, accepted=req.accepted,
        user=user, tempo_coherent=req.tempo_coherent, anchors=req.anchors,
    )
    return {"tracks": recs}
