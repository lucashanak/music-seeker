"""A Lidarr job is finished here and only here.

`_run_lidarr` asks Lidarr to go looking; nothing has been downloaded when it
returns. The job carries a flag saying so, while `status` stays DONE — every
filter in jobs.py keys on the three terminal statuses, and an unknown fourth
one would also make `_load_history()` raise and drop the whole history.
"""
import asyncio
import json

import pytest

from app.services import downloader, jobs
from app.services.jobs import JobStatus


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _empty_job_table(monkeypatch, tmp_path):
    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(jobs, "_tasks", {})
    monkeypatch.setattr(jobs, "HISTORY_FILE", tmp_path / "download_history.json")


@pytest.fixture(autouse=True)
def _no_navidrome(monkeypatch):
    async def noop(*a, **kw):
        return None
    monkeypatch.setattr(downloader, "_trigger_navidrome_scan", noop)


@pytest.fixture
def lidarr(monkeypatch):
    """Lidarr with the artist already added, so the hand-off is the only outcome.

    Only the HTTP layer is faked: `_run_lidarr` itself runs for real, which is
    the whole point — a stub that set the flag would be testing the stub.
    """
    class _Resp:
        def __init__(self, data):
            self._data = data

        def raise_for_status(self):
            pass

        def json(self):
            return self._data

    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, path, **kw):
            return _Resp([{"id": 7, "foreignArtistId": "mbid", "artistName": "Daft Punk"}])

        async def post(self, path, json=None):
            return _Resp({"id": 1})

    monkeypatch.setattr(downloader.httpx, "AsyncClient", _Client)


def _lidarr_job():
    return jobs.create_job("album", "Daft Punk - Discovery", "u", "lidarr", "flac",
                           username="claude_test")


def test_a_lidarr_job_says_it_only_handed_the_work_on(lidarr):
    job = _lidarr_job()
    run(downloader.run_download(job))
    assert job.status is JobStatus.DONE
    assert job.handed_off is True


def test_a_ytdlp_job_does_not(monkeypatch):
    async def fake_ytdlp(job):
        return True
    monkeypatch.setattr(downloader, "_run_ytdlp", fake_ytdlp)

    job = jobs.create_job("track", "One More Time", "u", "yt-dlp", "flac",
                          username="claude_test")
    run(downloader.run_download(job))
    assert job.status is JobStatus.DONE
    assert job.handed_off is False


def test_a_handed_off_job_is_still_an_ordinary_finished_job(lidarr):
    """The whole reason for a flag instead of a fourth status.

    History, restart and "Clear history" all filter on the terminal statuses.
    """
    job = _lidarr_job()
    run(downloader.run_download(job))

    jobs._save_history()
    assert [e["id"] for e in json.loads(jobs.HISTORY_FILE.read_text())] == [job.id]

    assert jobs.clear_history(username="claude_test") == 1
    assert jobs.get_job(job.id) is None


def test_history_on_disk_keeps_the_shape_an_older_image_can_read(lidarr):
    """`Job(**entry)` on a rolled-back image must not choke on a key it lacks."""
    job = _lidarr_job()
    run(downloader.run_download(job))
    jobs._save_history()

    entry = json.loads(jobs.HISTORY_FILE.read_text())[0]
    assert "handed_off" not in entry
    assert jobs.Job(**{**entry, "status": JobStatus(entry["status"])}).id == job.id


def test_the_api_shape_does_carry_the_flag(lidarr):
    job = _lidarr_job()
    run(downloader.run_download(job))
    assert jobs.get_all_jobs(username="claude_test")[0]["handed_off"] is True
