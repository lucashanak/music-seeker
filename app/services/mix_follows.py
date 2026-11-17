"""Followed DJs: per user, with an optional auto-download of their NEW mixes.

Podcast subscriptions are global; follows are not, because the mixes they
download land in the follower's own `<user>/<DJ>/DJ Sets` folders and count against that
user's quota.

The one rule that matters: auto-download fetches only what a DJ uploads AFTER
the follow. Every upload visible when the follow is made is marked `seen` at
once, and every upload a check looks at — downloaded or turned down for quality
or length — joins `seen`, so a Mixcloud SQ mix is not reconsidered every six
hours (it will never become HQ). An upload that passed but did not fit under the
per-run cap stays unseen and is taken on the next run.

A started download is not `seen` yet but `inflight` ({url: {job_id, n, title,
uploader}}): a later check that finds its job FAILED or CANCELLED starts it again
while n < MAX_ATTEMPTS. A job the process no longer knows (a restart) counts as
done. One check per user runs at a time (`_user_lock`), so "Check now" pressed
twice, or pressed while the 6-hourly run is on, cannot start one upload twice.
"""

import asyncio
import json
import logging
import os
import tempfile
import time
from pathlib import Path

from app.services import mix_sources

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
FOLLOWS_FILE = DATA_DIR / "mix_follows.json"

SEEN_MAX = 300
MAX_PER_DJ_PER_RUN = 3
MAX_ATTEMPTS = 3
MAX_FOLLOWS = 200
PARALLEL_DJS = 3            # "Check now" has to answer inside a 60 s proxy timeout
CHECK_LIMIT = mix_sources.UPLOADS_DEFAULT
DEFAULT_MIN_KBPS = 128
DEFAULT_MIN_MINUTES = 20


# ── Storage: {username: [follow, ...]} ──

def _load() -> dict:
    try:
        data = json.loads(FOLLOWS_FILE.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save(data: dict) -> None:
    FOLLOWS_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(FOLLOWS_FILE.parent), prefix=".mix_follows.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, FOLLOWS_FILE)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _find(lst: list, source: str, user_id: str) -> dict | None:
    for f in lst:
        if f.get("source") == source and f.get("user_id") == user_id:
            return f
    return None


class FollowLimit(Exception):
    pass


def _public(f: dict) -> dict:
    out = {k: v for k, v in f.items() if k not in ("seen", "inflight")}
    out["seen_count"] = len(f.get("seen") or [])
    out["inflight_count"] = len(f.get("inflight") or {})
    return out


def get_follows(username: str) -> list[dict]:
    return [_public(f) for f in _load().get(username, [])]


def all_follows() -> dict[str, list[dict]]:
    return {u: list(lst) for u, lst in _load().items() if isinstance(lst, list)}


def _add_seen(f: dict, urls) -> None:
    new = list(dict.fromkeys(u for u in urls if u))
    fresh = set(new)
    # Newest last; keep the newest SEEN_MAX.
    seen = [u for u in (f.get("seen") or []) if u not in fresh] + new
    f["seen"] = seen[-SEEN_MAX:]


def add_follow(username: str, source: str, user_id: str, name: str = "", image: str = "",
               url: str = "", seen_urls: list[str] | None = None) -> dict | None:
    """None when this DJ is already followed. `seen_urls` None = the current
    uploads could not be read; the first check reads them and downloads nothing."""
    data = _load()
    lst = data.setdefault(username, [])
    if _find(lst, source, user_id):
        return None
    if len(lst) >= MAX_FOLLOWS:
        raise FollowLimit(f"You can follow at most {MAX_FOLLOWS} DJs")
    f = {
        "source": source, "user_id": user_id, "name": name or user_id, "image": image or "",
        "url": url or "", "auto_download": False, "min_kbps": DEFAULT_MIN_KBPS,
        "min_minutes": DEFAULT_MIN_MINUTES, "added": int(time.time()),
        "seeded": seen_urls is not None, "seen": [], "inflight": {},
    }
    _add_seen(f, seen_urls or [])
    lst.append(f)
    _save(data)
    return _public(f)


def remove_follow(username: str, source: str, user_id: str) -> bool:
    data = _load()
    lst = data.get(username, [])
    f = _find(lst, source, user_id)
    if not f:
        return False
    lst.remove(f)
    if not lst:
        data.pop(username, None)
    _save(data)
    return True


def update_follow(username: str, source: str, user_id: str, auto_download=None,
                  min_kbps=None, min_minutes=None) -> dict | None:
    data = _load()
    f = _find(data.get(username, []), source, user_id)
    if not f:
        return None
    if auto_download is not None:
        f["auto_download"] = bool(auto_download)
    if min_kbps is not None:
        f["min_kbps"] = max(0, min(int(min_kbps), 1000))
    if min_minutes is not None:
        f["min_minutes"] = max(0, min(int(min_minutes), 600))
    _save(data)
    return _public(f)


def mark_seen(username: str, source: str, user_id: str, urls: list[str], seeded: bool = False) -> None:
    """Re-read before writing: a check awaits the network between reading the
    follow and recording what it saw, and the user may have changed it meanwhile.
    A URL that becomes seen is no longer in flight."""
    if not urls and not seeded:
        return
    data = _load()
    f = _find(data.get(username, []), source, user_id)
    if not f:
        return
    _add_seen(f, urls)
    infl = f.get("inflight") or {}
    for u in urls:
        infl.pop(u, None)
    f["inflight"] = infl
    if seeded:
        f["seeded"] = True
    _save(data)


def set_inflight(username: str, source: str, user_id: str, url: str, rec: dict) -> None:
    data = _load()
    f = _find(data.get(username, []), source, user_id)
    if not f:
        return
    f.setdefault("inflight", {})[url] = rec
    _save(data)


# ── The check ──

def may_download_mixes(username: str) -> bool:
    from app.services import auth, mixes
    try:
        mixes.user_folder(username)
    except mixes.MixPathError:
        return False   # its downloads would land in another user's folder
    users = auth._load_users()
    u = users.get(username)
    if u is None:
        return False
    allowed = u.get("allowed_methods", auth.DEFAULT_PERMS["allowed_methods"])
    return "yt-dlp" in allowed


def pick_new(follow: dict, uploads: list[dict]) -> tuple[list[dict], list[dict]]:
    """(to consider, turned down) among uploads neither seen nor in flight. An
    upload of unknown length is neither: it is looked at again next time rather
    than turned down for being "shorter" than the threshold. Pure."""
    seen = set(follow.get("seen") or [])
    infl = follow.get("inflight") or {}
    min_kbps = int(follow.get("min_kbps", DEFAULT_MIN_KBPS) or 0)
    min_sec = int(follow.get("min_minutes", DEFAULT_MIN_MINUTES) or 0) * 60
    ok, rejected = [], []
    for it in uploads:
        url = it.get("url")
        if not url or url in seen or url in infl:
            continue
        dur = it.get("duration") or 0
        if (it.get("kbps") or 0) < min_kbps:
            rejected.append(it)
        elif min_sec and dur <= 0:
            continue
        elif dur < min_sec:
            rejected.append(it)
        else:
            ok.append(it)
    return ok, rejected


def job_status(job_id) -> str | None:
    """'queued'/'running'/'done'/'failed'/'cancelled', None for a job this
    process does not know."""
    from app.services import jobs
    job = jobs.get_job(job_id) if job_id else None
    return job.status.value if job else None


async def check_follow(username: str, follow: dict, fetch, in_library, start_job,
                       status=job_status) -> dict:
    """One DJ: settle downloads in flight, fetch uploads, decide, start up to
    MAX_PER_DJ_PER_RUN jobs (retries included)."""
    src, uid = follow["source"], follow["user_id"]
    started = 0
    queued = []

    def launch(url: str, title: str, uploader: str, n: int, item: dict) -> None:
        nonlocal started
        # Recorded BEFORE the job exists: whatever happens next, no later check
        # can take this URL for new.
        set_inflight(username, src, uid, url, {"job_id": None, "n": n, "title": title, "uploader": uploader})
        job = start_job(username, item)
        set_inflight(username, src, uid, url, {"job_id": getattr(job, "id", None), "n": n,
                                               "title": title, "uploader": uploader})
        started += 1
        queued.append(title)

    # Downloads started by an earlier check.
    done = []
    for url, rec in list((follow.get("inflight") or {}).items()):
        st = status(rec.get("job_id"))
        if st in ("queued", "running"):
            continue
        if st in ("failed", "cancelled") and int(rec.get("n") or 0) < MAX_ATTEMPTS \
                and started < MAX_PER_DJ_PER_RUN:
            item = {"url": url, "title": rec.get("title") or url, "uploader": rec.get("uploader") or ""}
            launch(url, item["title"], item["uploader"], int(rec.get("n") or 0) + 1, item)
        elif st in ("failed", "cancelled") and int(rec.get("n") or 0) < MAX_ATTEMPTS:
            continue   # over this run's cap: next run
        else:
            done.append(url)   # done, given up, or unknown after a restart
    mark_seen(username, src, uid, done)

    items = await fetch(src, uid, CHECK_LIMIT)
    if not follow.get("seeded"):
        # The follow was made while the site did not answer: what is there now
        # is the history, not news.
        mark_seen(username, src, uid, [it["url"] for it in items], seeded=True)
        return {"queued": queued, "seeded": len(items)}
    ok, rejected = pick_new(follow, items)
    mark_seen(username, src, uid, [it["url"] for it in rejected])
    for it in ok:
        if started >= MAX_PER_DJ_PER_RUN:
            break
        try:
            owned = await in_library(it["title"], it["uploader"])
        except Exception:
            owned = False   # the job checks again before downloading
        if owned:
            mark_seen(username, src, uid, [it["url"]])
            continue
        launch(it["url"], it["title"], it["uploader"], 1, it)
    return {"queued": queued}


_locks: dict[str, asyncio.Lock] = {}


def _user_lock(username: str) -> asyncio.Lock:
    lock = _locks.get(username)
    if lock is None:
        lock = _locks[username] = asyncio.Lock()
    return lock


async def check_user(username: str, fetch=None, in_library=None, start_job=None,
                     status=job_status, wait: bool = True) -> dict:
    """Run the check for every auto-download follow of one user. One at a time
    per user; up to PARALLEL_DJS DJs at once. With `wait=False` ("Check now")
    a check already running answers {"status": "already_running"} at once
    instead of queueing behind it past the proxy's timeout."""
    if not wait and _user_lock(username).locked():
        return {"status": "already_running", "checked": 0, "queued": [], "errors": {}}
    fetch = fetch or mix_sources.uploads
    if in_library is None:
        from app.services import library
        in_library = library.find_song_id
    start_job = start_job or start_mix_job
    async with _user_lock(username):
        # Read under the lock: a check that waited sees what the previous one wrote.
        follows = [f for f in _load().get(username, []) if f.get("auto_download")]
        result = {"checked": 0, "queued": [], "errors": {}}
        if not follows:
            return result
        if not may_download_mixes(username):
            result["errors"]["account"] = "This account may not download mixes"
            return result
        slots = asyncio.Semaphore(PARALLEL_DJS)

        async def one(f):
            key = f"{f['source']}/{f['user_id']}"
            async with slots:
                try:
                    r = await check_follow(username, f, fetch, in_library, start_job, status)
                    result["checked"] += 1
                    result["queued"].extend(r["queued"])
                except Exception as e:
                    result["errors"][key] = (str(e) or type(e).__name__)[:200]

        await asyncio.gather(*(one(f) for f in follows))
        return result


def start_mix_job(username: str, item: dict):
    from app.services import downloader, jobs
    job = jobs.create_job(type_="mix", title=f"{item['uploader']} - {item['title']}",
                          url=item["url"], method="yt-dlp", fmt="original", username=username)
    task = asyncio.create_task(downloader.run_download(job))
    jobs.register_task(job.id, task)
    return job


async def check_all() -> dict:
    out = {}
    for username, lst in all_follows().items():
        if any(f.get("auto_download") for f in lst):
            try:
                out[username] = r = await check_user(username)
                for key, err in r["errors"].items():
                    logger.warning("Mix follow check %s %s: %s", username, key, err)
            except Exception as e:
                logger.warning("Mix follow check for %s failed: %s", username, e)
    return out
