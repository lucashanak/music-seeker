"""Library → Mixes → clips: cut a passage out of a downloaded set into a new track."""

import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.dependencies import _stream_auth, bind_navidrome_creds
from app.services import auth, clips, mixes

# The scan after a change talks to Navidrome as the user, so every route binds the
# credentials. Not router-wide: /audio is fetched by an <audio> element, which cannot
# send the Authorization header bind_navidrome_creds reads — it binds through _stream_auth.
router = APIRouter(prefix="/api/clips", tags=["clips"])
_bind = [Depends(bind_navidrome_creds)]

AUDIO_TYPES = {"m4a": "audio/mp4", "mp4": "audio/mp4", "mp3": "audio/mpeg", "flac": "audio/flac",
               "opus": "audio/ogg", "ogg": "audio/ogg", "wav": "audio/wav", "aac": "audio/aac"}


class ClipRequest(BaseModel):
    dj: str
    file: str
    start: float
    end: float
    title: str
    artist: str = ""


class ClipDeleteRequest(BaseModel):
    dir: str
    file: str


def _music_dir() -> str:
    return os.environ.get("MUSIC_DIR", "/music")


def _source(user: dict, dj: str, file: str) -> str:
    try:
        path = mixes.resolve_library_file(_music_dir(), user["username"], dj, file)
    except mixes.MixPathError as e:
        raise HTTPException(400, str(e))
    if not os.path.isfile(path):
        raise HTTPException(404, "Mix not found")
    return path


@router.get("/audio")
async def audio(dj: str = Query(""), file: str = Query(""), user: dict = Depends(_stream_auth)):
    """The set itself, so the editor plays exactly the file the cut is made from
    (the player's stream may be a transcode with other timing). FileResponse gives Range."""
    path = _source(user, dj, file)
    ext = path.rsplit(".", 1)[-1].lower()
    return FileResponse(path, media_type=AUDIO_TYPES.get(ext, "application/octet-stream"))


@router.get("/waveform", dependencies=_bind)
async def waveform(dj: str = Query(""), file: str = Query(""), user: dict = Depends(auth.get_current_user)):
    path = _source(user, dj, file)
    try:
        return await clips.get_waveform(path)
    except clips.ClipError as e:
        raise HTTPException(e.status, e.message)


@router.get("/beats", dependencies=_bind)
async def beats(dj: str = Query(""), file: str = Query(""), t: float = Query(0.0),
                user: dict = Depends(auth.get_current_user)):
    return await clips.get_beats(_source(user, dj, file), t)


@router.post("", dependencies=_bind)
async def create_clip(req: ClipRequest, user: dict = Depends(auth.get_current_user)):
    from app.services import downloader, player
    # The same gate a download passes; it walks the user's folder, so off the loop.
    if not await asyncio.to_thread(downloader._check_quota, user["username"]):
        raise HTTPException(507, "Disk quota exceeded")
    try:
        made = await clips.create_clip(_music_dir(), user["username"], req.dj, req.file,
                                       req.start, req.end, req.title, req.artist)
    except mixes.MixPathError as e:
        raise HTTPException(400, str(e))
    except clips.ClipError as e:
        raise HTTPException(e.status, e.message)
    player.invalidate_cache(made["name"], made["artist"])
    await downloader._trigger_navidrome_scan()
    return made


@router.get("", dependencies=_bind)
async def list_clips(user: dict = Depends(auth.get_current_user)):
    return await asyncio.to_thread(clips.list_clips, _music_dir(), user["username"])


@router.delete("", dependencies=_bind)
async def delete_clip(req: ClipDeleteRequest, user: dict = Depends(auth.get_current_user)):
    try:
        gone = await asyncio.to_thread(clips.delete_clip, _music_dir(), user["username"], req.dir, req.file)
    except mixes.MixPathError as e:
        raise HTTPException(400, str(e))
    if not gone:
        raise HTTPException(404, "Clip not found")
    from app.services import downloader, player
    player.invalidate_cache(gone["title"], gone["artist"])
    await downloader._trigger_navidrome_scan()
    return {"status": "deleted"}
