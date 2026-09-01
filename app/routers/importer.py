import asyncio
import logging
import time
import uuid

from fastapi import APIRouter, HTTPException, Depends, Response

from pydantic import BaseModel, Field

from app.services import auth, playlist_import, playlist_harvest
from app.dependencies import _user_spotify_creds

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/import", tags=["import"])

# Shown when the source refused to hand over the whole thing. Factual on purpose:
# the 100-track ceiling is Spotify's public page, and both ways out are real.
_TRUNCATED_NOTE = ("Spotify's public page only exposes the first 100 tracks. "
                   "Paste the playlist's track links to import more (up to "
                   f"{playlist_import._TEXT_MAX_ENTRIES} per paste), "
                   "or restore Premium on the app account.")
_TRUNCATED_NOTE_GENERIC = "The source capped this import, so some tracks are missing."
# Every harvest failure ends by pointing at the manual paste helper: the feature is
# an optimisation over that helper, never a replacement for it.
_HARVEST_MANUAL_HINT = ("You can still paste the playlist's track links to import them "
                        f"(up to {playlist_import._TEXT_MAX_ENTRIES} per paste).")


class ImportUrlRequest(BaseModel):
    url: str = Field(max_length=2048)


class ImportTextRequest(BaseModel):
    # ~200 KB, well past _TEXT_MAX_ENTRIES worth of `Artist - Title` lines, but
    # bounded: the body used to be parsed before anything could reject its size.
    text: str = Field(max_length=200_000)


@router.post("/playlist")
async def import_playlist(req: ImportUrlRequest, user: dict = Depends(auth.get_current_user)):
    """Resolve a shared Spotify/Deezer playlist or album link to its tracks."""
    creds = _user_spotify_creds(user)
    try:
        data = await playlist_import.import_from_url(req.url, creds=creds)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except playlist_import.ImportNotFound as e:
        # Private or deleted playlist: the embed page 404s. Not our fault, not a 500.
        raise HTTPException(404, str(e))
    except playlist_import.ImportUnavailable as e:
        raise HTTPException(502, str(e))
    except RuntimeError as e:
        # Anything the service didn't classify still beats an uncaught 500 traceback
        # (prod logs to an uncapped json-file driver on a small disk).
        raise HTTPException(502, str(e))
    note = ""
    if data["truncated"]:
        note = _TRUNCATED_NOTE if data["source"] == "spotify" else _TRUNCATED_NOTE_GENERIC
    return {**data, "note": note}


@router.post("/tracks")
async def import_tracks(req: ImportTextRequest, user: dict = Depends(auth.get_current_user)):
    """Resolve pasted per-track links (or `Artist - Title` lines) to tracks."""
    creds = _user_spotify_creds(user)
    return await playlist_import.import_from_text(req.text, creds=creds)


# ── Full harvest via the browser sidecar ────────────────────────────
#
# A harvest scrolls a real playlist page and takes 1.5-3 minutes, so it cannot be
# a synchronous request: POST starts a job, GET polls it. The registry is
# in-process on purpose (one uvicorn worker, same as `remote`/`dlna` state) — a
# harvest is a cache-warming step, there is nothing here worth persisting.
_harvest_jobs: dict[str, dict] = {}
_HARVEST_JOB_TTL = 1800.0   # long enough for a slow client to come back for the result
_HARVEST_JOBS_MAX = 32


class HarvestRequest(BaseModel):
    url: str = Field(max_length=2048)


def _prune_harvest_jobs():
    now = time.time()
    for job_id in [k for k, j in _harvest_jobs.items() if now - j["created_at"] > _HARVEST_JOB_TTL]:
        _harvest_jobs.pop(job_id, None)
    while len(_harvest_jobs) > _HARVEST_JOBS_MAX:
        _harvest_jobs.pop(min(_harvest_jobs, key=lambda k: _harvest_jobs[k]["created_at"]), None)


def _new_harvest_job(url: str) -> dict:
    _prune_harvest_jobs()
    job = {
        "job_id": uuid.uuid4().hex[:12],
        "status": "queued",
        "url": url,
        "count": 0,
        "progress": None,
        "name": "",
        "image": "",
        "tracks": [],
        "error": None,
        "created_at": time.time(),
    }
    _harvest_jobs[job["job_id"]] = job
    return job


def _harvest_view(job: dict) -> dict:
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "count": job["count"],
        "progress": job["progress"],
        "name": job["name"],
        "image": job["image"],
        "tracks": job["tracks"],
        "error": job["error"],
    }


async def _run_harvest_job(job: dict):
    job["status"] = "running"

    def on_progress(count: int):
        job["progress"] = count

    try:
        data = await playlist_harvest.harvest_collection(job["url"], on_progress=on_progress)
        job.update(status="done", name=data["name"], image=data["image"],
                   tracks=data["tracks"], count=data["count"], progress=data["count"])
    except playlist_harvest.HarvestError as e:
        job.update(status="error", error=str(e))
    except asyncio.CancelledError:
        job.update(status="error", error="The fetch was interrupted.")
        raise
    except Exception:
        # Nothing should land here, but an unclassified failure must still read as a
        # failed job rather than an uncaught traceback in a background task.
        logger.exception("Playlist harvest job %s crashed", job["job_id"])
        job.update(status="error",
                   error=f"The full-playlist fetch failed. {_HARVEST_MANUAL_HINT}")


@router.post("/harvest", status_code=202)
async def start_harvest(req: HarvestRequest, response: Response,
                        user: dict = Depends(auth.get_current_user)):
    """Start a full-playlist harvest. 202 + job id, or the finished result if cached."""
    try:
        cached = playlist_harvest.cached_result(req.url)
    except ValueError as e:
        raise HTTPException(400, str(e))

    if cached:
        job = _new_harvest_job(req.url)
        job.update(status="done", name=cached["name"], image=cached["image"],
                   tracks=cached["tracks"], count=cached["count"], progress=cached["count"])
        response.status_code = 200
        return {"cached": True, **_harvest_view(job)}

    if playlist_harvest.is_busy():
        raise HTTPException(409, "Another full-playlist fetch is already running — it takes a "
                                "couple of minutes. Try again once it finishes.")
    if playlist_harvest.rate_limited():
        raise HTTPException(429, "Full-playlist fetching is rate-limited for the next while "
                                 f"(Spotify throttles repeat visits). {_HARVEST_MANUAL_HINT}")
    if not await playlist_harvest.sidecar_available():
        raise HTTPException(503, "The browser helper isn't running, so only the first 100 "
                                 f"tracks can be imported. {_HARVEST_MANUAL_HINT}")

    job = _new_harvest_job(req.url)
    task = asyncio.create_task(_run_harvest_job(job))
    # Keep a reference: a bare create_task result can be garbage-collected mid-run.
    job["task"] = task
    return {"cached": False, "job_id": job["job_id"], "status": job["status"]}


@router.get("/harvest/{job_id}")
async def get_harvest(job_id: str, user: dict = Depends(auth.get_current_user)):
    job = _harvest_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "That fetch has expired — start it again.")
    return _harvest_view(job)
