"""DJ desk: data the desk screen needs about a track the server owns."""

import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import bind_navidrome_creds
from app.services import auth, bpm, clips, player

router = APIRouter(prefix="/api/desk", tags=["desk"], dependencies=[Depends(bind_navidrome_creds)])

# Waveform builds whose page cache still has to be given back. Held here so a request
# that went away (nginx, a closed desk) does not take the clean-up with it.
_pending_drops: set[asyncio.Task] = set()


def _music_dir() -> str:
    return os.environ.get("MUSIC_DIR", "/music")


def _own_file(username: str, name: str, artist: str) -> str | None:
    """The caller's OWN copy first — clips.resolve_source looks only under the caller's
    folder — and only then the player's lookup, which walks every user's folders and
    answers the first hit (another user's copy, possibly another recording)."""
    try:
        return clips.resolve_source(_music_dir(), username, name=name, artist=artist).path
    except clips.ClipError:
        pass
    return player.find_track_file(name, artist)


async def _waveform_then_drop(path: str) -> dict:
    """Wait for the (shared) build, THEN drop the file's page cache — the drop has to
    come after ffmpeg read the file, which may be long after this request was cancelled
    while it waited for the build semaphore."""
    try:
        return await clips.get_waveform(path)
    finally:
        # ffmpeg just read the whole file; give its page cache back (2 GiB cgroup limit).
        await asyncio.to_thread(bpm.drop_file_cache, path)


def _drop_done(task: asyncio.Task) -> None:
    _pending_drops.discard(task)
    if not task.cancelled():
        task.exception()   # retrieved: a request that went away must not leave "never retrieved"


@router.get("/waveform")
async def desk_waveform(name: str = Query(...), artist: str = Query(""),
                        user: dict = Depends(auth.get_current_user)):
    """One byte per 0.1 s of the track's own audio file, or 200 {"owned": false}.

    Ownership follows the BPM rule (audio the server can open, never YouTube), but a
    waveform is only built from a LIBRARY FILE: a track that exists only in Navidrome
    would have to be streamed whole into /tmp, and page cache from that is what
    OOM-killed the container (see CLAUDE.md, feature version 4). Such a track answers
    owned:false; once it is on disk it gets a waveform.
    """
    name, artist = player.nfc(name), player.nfc(artist)
    path = await asyncio.to_thread(_own_file, (user or {}).get("username", ""), name, artist)
    if not path:
        return {"owned": False, "name": name, "artist": artist}
    # Its own task: a cancelled request cancels only its wait (shield), never the
    # build nor the cache drop that follows it.
    task = asyncio.create_task(_waveform_then_drop(path))
    _pending_drops.add(task)
    task.add_done_callback(_drop_done)
    try:
        wave = await asyncio.shield(task)
    except clips.ClipError as e:
        raise HTTPException(e.status, e.message)
    return {"step": 1 / clips.PEAK_RATE, "duration": wave["duration"], "peaks": wave["peaks"]}
