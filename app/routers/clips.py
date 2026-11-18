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
    # The source is a downloaded set (dj + file) OR a library track (name + source_artist);
    # `artist` here is the clip's own artist, so the track's artist has its own field.
    dj: str = ""
    file: str = ""
    name: str = ""
    source_artist: str = ""
    start: float
    end: float
    title: str
    artist: str = ""
    playlist_id: str = ""      # optional: file the new clip into this playlist


class ClipDeleteRequest(BaseModel):
    dir: str
    file: str


def _music_dir() -> str:
    return os.environ.get("MUSIC_DIR", "/music")


async def _source(user: dict, dj: str = "", file: str = "", name: str = "", artist: str = "") -> clips.SourceRef:
    # Resolving a track may scan a NAS folder: off the loop.
    try:
        return await asyncio.to_thread(clips.resolve_source, _music_dir(), user["username"],
                                       dj=dj, file=file, name=name, artist=artist)
    except clips.ClipError as e:
        raise HTTPException(e.status, e.message)


@router.get("/source", dependencies=_bind)
async def source(dj: str = Query(""), file: str = Query(""), name: str = Query(""), artist: str = Query(""),
                 user: dict = Depends(auth.get_current_user)):
    """Can this be cut, and as what? Asked BEFORE the editor opens, so a refusal is a
    message and not an editor that opens only to say no."""
    ref = await _source(user, dj, file, name, artist)
    try:
        info = await asyncio.to_thread(clips.source_info, ref, name, artist)
        return {**info, "duration": round(await asyncio.to_thread(clips._duration_of, ref.path), 3)}
    except OSError:
        raise HTTPException(404, clips.NOT_OWNED)


@router.get("/audio")
async def audio(dj: str = Query(""), file: str = Query(""), name: str = Query(""), artist: str = Query(""),
                user: dict = Depends(_stream_auth)):
    """The set itself, so the editor plays exactly the file the cut is made from
    (the player's stream may be a transcode with other timing). FileResponse gives Range."""
    path = (await _source(user, dj, file, name, artist)).path
    ext = path.rsplit(".", 1)[-1].lower()
    return FileResponse(path, media_type=AUDIO_TYPES.get(ext, "application/octet-stream"))


@router.get("/waveform", dependencies=_bind)
async def waveform(dj: str = Query(""), file: str = Query(""), name: str = Query(""), artist: str = Query(""),
                   user: dict = Depends(auth.get_current_user)):
    ref = await _source(user, dj, file, name, artist)
    try:
        wave = await clips.get_waveform(ref.path)
        # The editor matches clips to this source by this key; for a track it cannot know the relpath.
        return {**wave, "source": await asyncio.to_thread(clips.source_info, ref, name, artist)}
    except clips.ClipError as e:
        raise HTTPException(e.status, e.message)


@router.get("/beats", dependencies=_bind)
async def beats(dj: str = Query(""), file: str = Query(""), name: str = Query(""), artist: str = Query(""),
                t: float = Query(0.0), user: dict = Depends(auth.get_current_user)):
    return await clips.get_beats((await _source(user, dj, file, name, artist)).path, t)


@router.post("", dependencies=_bind)
async def create_clip(req: ClipRequest, user: dict = Depends(auth.get_current_user)):
    from app.services import downloader, player
    # The same gate a download passes; it walks the user's folder, so off the loop.
    if not await asyncio.to_thread(downloader._check_quota, user["username"]):
        raise HTTPException(507, "Disk quota exceeded")
    playlist = None
    if req.playlist_id:
        # Asked BEFORE the cut: a clip saved "into" a playlist that is not there, or is
        # someone else's, is a surprise. Without their own Navidrome account a user talks
        # through the service account and would otherwise write into the admin's playlists.
        import httpx
        from app.routers.library import _own_playlists_owner
        from app.services import library
        try:
            found = await library.get_playlists()
        except httpx.HTTPError:
            raise HTTPException(502, "The library is not answering – the clip was not saved")
        playlist = next((p for p in found if str(p.get("id")) == req.playlist_id
                         and not library.is_temp_playlist_name(p.get("name", ""))), None)
        if not playlist:
            raise HTTPException(404, "Playlist not found")
        me = _own_playlists_owner(user)
        if not me or playlist.get("owner") != me:
            raise HTTPException(403, "Not your playlist")
    try:
        made = await clips.create_clip(_music_dir(), user["username"], req.dj, req.file,
                                       req.start, req.end, req.title, req.artist,
                                       src_name=req.name, src_artist=req.source_artist)
    except mixes.MixPathError as e:
        raise HTTPException(400, str(e))
    except clips.ClipError as e:
        raise HTTPException(e.status, e.message)
    player.invalidate_cache(made["name"], made["artist"])
    await downloader._trigger_navidrome_scan()
    if playlist:
        made["playlist"] = {"id": playlist["id"], "name": playlist["name"],
                            "state": await _into_playlist(made, playlist["id"], user["username"])}
    return made


# A playlist holds Navidrome ids, and the clip gets one only when the scan has seen it —
# usually seconds. The answer waits that long; a slow scan is finished in the background
# (the task keeps the request's Navidrome credentials: a task copies the context).
PLAYLIST_INLINE_WAIT = 15.0
_playlist_tasks: set = set()


async def _into_playlist(made: dict, playlist_id: str, username: str = "") -> str:
    task = asyncio.create_task(clips.add_when_indexed(made["name"], made["artist"], playlist_id,
                                                    made["dir"], made["file"], username))
    _playlist_tasks.add(task)
    task.add_done_callback(_playlist_tasks.discard)
    try:
        ok = await asyncio.wait_for(asyncio.shield(task), PLAYLIST_INLINE_WAIT)
    except asyncio.TimeoutError:
        return "pending"
    return "added" if ok else "failed"


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
