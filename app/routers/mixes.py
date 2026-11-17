"""Library → Mixes: search DJ sets across sites, the user's downloaded mixes, and
followed DJs. Downloading itself goes through `POST /api/download` `type: "mix"`."""

import asyncio
import os
import time
from collections import deque

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import bind_navidrome_creds
from app.models import MixDeleteRequest, MixFollowRequest, MixFollowUpdate
from app.routers.downloads import _require_mix_perms
from app.services import auth, mix_follows, mix_sources, mixes

# Router-level binding: in_library and the scan talk to Navidrome as the user.
router = APIRouter(prefix="/api/mixes", tags=["mixes"], dependencies=[Depends(bind_navidrome_creds)])


def _music_dir() -> str:
    return os.environ.get("MUSIC_DIR", "/music")


def _check_dj(source: str, user_id: str) -> None:
    if source not in mix_sources.SOURCES:
        raise HTTPException(400, "Unknown source")
    if not mix_sources.valid_user_id(source, user_id):
        raise HTTPException(400, "Not a DJ this source can list")


# ── Search ──

# A search can start two yt-dlp processes and asks four sites; ten a minute per
# user is far more than a person types and far less than a stuck client sends.
SEARCH_LIMIT = 10
SEARCH_WINDOW = 60.0
_searches: dict[str, deque] = {}


def _throttle_search(username: str) -> None:
    now = time.monotonic()
    q = _searches.setdefault(username, deque())
    while q and now - q[0] > SEARCH_WINDOW:
        q.popleft()
    if len(q) >= SEARCH_LIMIT:
        wait = int(SEARCH_WINDOW - (now - q[0])) + 1
        raise HTTPException(429, f"Too many mix searches — try again in {wait} s")
    q.append(now)


@router.get("/search")
async def search_mixes(q: str = Query(""), sources: str = Query(""),
                       user: dict = Depends(auth.get_current_user)):
    _require_mix_perms(user)
    if not q.strip():
        raise HTTPException(400, "Empty query")
    _throttle_search(user["username"])
    wanted = mix_sources.parse_sources(sources)
    if not wanted:
        raise HTTPException(400, "No known source asked for")
    return await mix_sources.search(q, wanted)


# ── Downloaded mixes ──

@router.get("/library")
async def list_library(user: dict = Depends(auth.get_current_user)):
    return await asyncio.to_thread(mixes.list_library, _music_dir(), user["username"])


@router.delete("/library")
async def delete_library_mix(req: MixDeleteRequest, user: dict = Depends(auth.get_current_user)):
    try:
        gone = mixes.delete_library_file(_music_dir(), user["username"], req.dj, req.file)
    except mixes.MixPathError as e:
        raise HTTPException(400, str(e))
    if not gone:
        raise HTTPException(404, "Mix not found")
    from app.services import downloader, player
    # The player remembers where it found this track; that file is gone now.
    player.invalidate_cache(gone["title"], gone["artist"])
    await downloader._trigger_navidrome_scan()
    return {"status": "deleted"}


# ── Followed DJs ──

@router.get("/follows")
async def list_follows(user: dict = Depends(auth.get_current_user)):
    return {"follows": mix_follows.get_follows(user["username"])}


@router.post("/follows")
async def follow_dj(req: MixFollowRequest, user: dict = Depends(auth.get_current_user)):
    _require_mix_perms(user)
    _check_dj(req.source, req.user_id)
    uname = user["username"]
    current_follows = mix_follows.get_follows(uname)
    if any(f["source"] == req.source and f["user_id"] == req.user_id for f in current_follows):
        raise HTTPException(409, "Already following")
    if len(current_follows) >= mix_follows.MAX_FOLLOWS:
        raise HTTPException(400, f"You can follow at most {mix_follows.MAX_FOLLOWS} DJs")
    # Everything up now is history: only what comes after the follow is "new".
    try:
        current = await mix_sources.uploads(req.source, req.user_id, mix_follows.CHECK_LIMIT)
        seen = [it["url"] for it in current]
    except Exception:
        seen = None   # the first check marks them instead, downloading nothing
    try:
        f = mix_follows.add_follow(uname, req.source, req.user_id, req.name[:200], req.image[:500],
                                   req.url[:500], seen_urls=seen)
    except mix_follows.FollowLimit as e:
        raise HTTPException(400, str(e))
    if f is None:
        raise HTTPException(409, "Already following")
    return f


@router.delete("/follows/{source}/{user_id}")
async def unfollow_dj(source: str, user_id: str, user: dict = Depends(auth.get_current_user)):
    if not mix_follows.remove_follow(user["username"], source, user_id):
        raise HTTPException(404, "Not following")
    return {"status": "unfollowed"}


@router.put("/follows/{source}/{user_id}")
async def update_follow(source: str, user_id: str, req: MixFollowUpdate,
                        user: dict = Depends(auth.get_current_user)):
    if req.auto_download:
        _require_mix_perms(user)
    f = mix_follows.update_follow(user["username"], source, user_id, req.auto_download,
                                  req.min_kbps, req.min_minutes)
    if f is None:
        raise HTTPException(404, "Not following")
    return f


@router.post("/follows/check")
async def check_follows(user: dict = Depends(auth.get_current_user)):
    _require_mix_perms(user)
    return await mix_follows.check_user(user["username"], wait=False)


@router.get("/follows/{source}/{user_id}/uploads")
async def dj_uploads(source: str, user_id: str, limit: int = Query(mix_sources.UPLOADS_DEFAULT),
                     user: dict = Depends(auth.get_current_user)):
    _require_mix_perms(user)
    _check_dj(source, user_id)
    try:
        items = await mix_sources.uploads(source, user_id, limit)
    except Exception as e:
        raise HTTPException(502, mix_sources._err_text(e))
    from app.services import library
    slots = asyncio.Semaphore(4)

    async def owned(it):
        async with slots:
            try:
                return bool(await library.find_song_id(it["title"], it["uploader"]))
            except Exception:
                return False

    flags = await asyncio.gather(*(owned(it) for it in items))
    for it, flag in zip(items, flags):
        it["in_library"] = flag
    return {"uploads": items}
