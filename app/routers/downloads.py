import asyncio
import os

from fastapi import APIRouter, HTTPException, Depends

from app.models import DownloadRequest
from app.services import auth, jobs, downloader
from app.dependencies import _get_dir_size, bind_navidrome_creds

router = APIRouter(prefix="/api", tags=["downloads"], dependencies=[Depends(bind_navidrome_creds)])


@router.post("/download")
async def start_download(req: DownloadRequest, user: dict = Depends(auth.get_current_user)):
    auth.require_download_perms(user, req.method, req.format)
    # Quota check
    quota_gb = user.get("quota_gb", 0)
    if quota_gb > 0:
        music_dir = os.environ.get("MUSIC_DIR", "/music")
        user_dir = os.path.join(music_dir, user["username"])
        used_bytes, _ = _get_dir_size(user_dir)
        quota_bytes = quota_gb * 1024 * 1024 * 1024
        if used_bytes >= quota_bytes:
            used_gb = used_bytes / (1024 ** 3)
            if quota_gb < 1:
                used_mb = used_bytes / (1024 ** 2)
                quota_mb = quota_gb * 1024
                raise HTTPException(403, f"Disk quota exceeded ({used_mb:.0f} MB / {quota_mb:.0f} MB)")
            raise HTTPException(403, f"Disk quota exceeded ({used_gb:.1f} GB / {quota_gb:.1f} GB)")
    job = jobs.create_job(
        type_=req.type,
        title=req.title or req.url,
        url=req.url,
        method=req.method,
        fmt=req.format,
        playlist_name=req.playlist_name,
        playlist_tracks=req.playlist_tracks,
        username=user["username"],
    )
    task = asyncio.create_task(downloader.run_download(job))
    jobs.register_task(job.id, task)
    return job.to_dict()


@router.get("/jobs")
async def list_jobs(user: dict = Depends(auth.get_current_user)):
    return {"jobs": jobs.get_all_jobs(username=user["username"], is_admin=user.get("is_admin", False))}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, user: dict = Depends(auth.get_current_user)):
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if not user.get("is_admin") and job.username != user["username"]:
        raise HTTPException(404, "Job not found")
    return job.to_dict()


@router.delete("/jobs/{job_id}")
async def cancel_job(job_id: str, user: dict = Depends(auth.get_current_user)):
    if not jobs.cancel_job(job_id, username=user["username"], is_admin=user.get("is_admin", False)):
        raise HTTPException(404, "Job not found")
    return {"status": "cancelled"}


@router.delete("/jobs")
async def clear_history(user: dict = Depends(auth.get_current_user)):
    count = jobs.clear_history(username=user["username"], is_admin=user.get("is_admin", False))
    return {"status": "cleared", "count": count}


@router.post('/jobs/{job_id}/retry')
async def retry_job(job_id: str, user: dict = Depends(auth.get_current_user)):
    data = jobs.get_retry_data(job_id)
    if not data:
        raise HTTPException(404, 'Job not found or not retryable')
    # Ownership. GET and DELETE on the same job check this; retry did not, so any
    # authenticated user could retry any job by id — and since the new job is
    # created under the CALLER, it also moved the download onto their quota.
    # 404 rather than 403, matching get_job, so a foreign id is indistinguishable
    # from a missing one.
    if not user.get("is_admin") and data.get("username") != user["username"]:
        raise HTTPException(404, 'Job not found or not retryable')
    # Re-check permissions instead of trusting the original job: an admin may
    # have revoked FLAC or slskd since it ran, and a retry must not resurrect it.
    auth.require_download_perms(user, data['method'], data['format'])
    job = jobs.create_job(
        type_=data['type'],
        title=data['title'],
        url=data['url'],
        method=data['method'],
        fmt=data['format'],
        username=user["username"],
    )
    task = asyncio.create_task(downloader.run_download(job))
    jobs.register_task(job.id, task)
    return job.to_dict()
