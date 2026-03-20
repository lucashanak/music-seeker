import asyncio
import json
import os
import uuid
import time
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Job:
    id: str
    type: str  # track, album, playlist
    title: str
    url: str
    method: str  # spotdl, lidarr
    format: str  # flac, mp3
    status: JobStatus = JobStatus.QUEUED
    progress: int = 0
    progress_text: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        return d


MAX_CONCURRENT = 10

_jobs: dict[str, Job] = {}
_semaphore = asyncio.Semaphore(MAX_CONCURRENT)
_tasks: dict[str, asyncio.Task] = {}

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
HISTORY_FILE = DATA_DIR / "download_history.json"


def _load_history():
    """Load completed jobs from disk on startup."""
    if not HISTORY_FILE.exists():
        return
    try:
        entries = json.loads(HISTORY_FILE.read_text())
        for e in entries:
            e["status"] = JobStatus(e["status"])
            job = Job(**e)
            _jobs[job.id] = job
    except Exception:
        pass


def _save_history():
    """Persist finished jobs to disk."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    finished = [
        j.to_dict() for j in _jobs.values()
        if j.status in (JobStatus.DONE, JobStatus.FAILED, JobStatus.CANCELLED)
    ]
    # Keep last 500 entries
    finished.sort(key=lambda j: j["started_at"], reverse=True)
    finished = finished[:500]
    HISTORY_FILE.write_text(json.dumps(finished))


def save_if_finished(job: Job):
    """Called after a job finishes to persist history."""
    if job.status in (JobStatus.DONE, JobStatus.FAILED, JobStatus.CANCELLED):
        _save_history()


# Load history on module import
_load_history()


def create_job(type_: str, title: str, url: str, method: str, fmt: str) -> Job:
    job_id = str(uuid.uuid4())[:8]
    job = Job(id=job_id, type=type_, title=title, url=url, method=method, format=fmt)
    _jobs[job_id] = job
    return job


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def get_all_jobs() -> list[dict]:
    return [j.to_dict() for j in sorted(_jobs.values(), key=lambda j: j.started_at, reverse=True)]


def cancel_job(job_id: str) -> bool:
    job = _jobs.get(job_id)
    if not job:
        return False
    task = _tasks.get(job_id)
    if task and not task.done():
        task.cancel()
    job.status = JobStatus.CANCELLED
    job.finished_at = time.time()
    _save_history()
    return True


def clear_history() -> int:
    """Remove all finished jobs. Returns count removed."""
    to_remove = [
        jid for jid, j in _jobs.items()
        if j.status in (JobStatus.DONE, JobStatus.FAILED, JobStatus.CANCELLED)
    ]
    for jid in to_remove:
        del _jobs[jid]
        _tasks.pop(jid, None)
    _save_history()
    return len(to_remove)


def register_task(job_id: str, task: asyncio.Task):
    _tasks[job_id] = task


def get_semaphore() -> asyncio.Semaphore:
    return _semaphore


def update_semaphore(max_concurrent: int):
    global _semaphore, MAX_CONCURRENT
    MAX_CONCURRENT = max(1, max_concurrent)
    _semaphore = asyncio.Semaphore(MAX_CONCURRENT)


def get_retry_data(job_id: str) -> dict | None:
    """Get data needed to retry a failed job."""
    job = _jobs.get(job_id)
    if not job or job.status not in (JobStatus.FAILED, JobStatus.CANCELLED):
        return None
    return {
        "type": job.type,
        "title": job.title,
        "url": job.url,
        "method": job.method,
        "format": job.format,
    }
