"""Every job-creating path must apply the same permission checks (issue #6).

POST /api/download always did. Retry copied method/format from the old job and
checked nothing — not even ownership — and add-and-download used the global
settings defaults instead of the caller's allowed lists. These tests pin all
three so they cannot drift apart again.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import downloads
from app.services import auth, downloader, jobs
from app.services.jobs import JobStatus


def _client(app_user: dict, monkeypatch) -> TestClient:
    app = FastAPI()
    app.include_router(downloads.router)
    app.dependency_overrides[auth.get_current_user] = lambda: app_user

    # Retry spawns the real download coroutine; keep the suite offline.
    async def _noop(job):
        return None

    monkeypatch.setattr(downloader, "run_download", _noop)
    return TestClient(app)


def _failed_job(owner: str, method: str = "slskd", fmt: str = "flac"):
    job = jobs.create_job(type_="track", title="Artist - Song", url="",
                          method=method, fmt=fmt, username=owner)
    job.status = JobStatus.FAILED
    return job


def _user(name: str, formats=("mp3", "flac"), methods=("yt-dlp", "slskd", "lidarr"),
          is_admin: bool = False) -> dict:
    return {"username": name, "allowed_formats": list(formats),
            "allowed_methods": list(methods), "is_admin": is_admin}


# ── retry: ownership ──

def test_retry_of_another_users_job_is_not_found(monkeypatch):
    job = _failed_job("victim")
    client = _client(_user("attacker"), monkeypatch)
    resp = client.post(f"/api/jobs/{job.id}/retry")
    assert resp.status_code == 404


def test_retry_of_own_job_succeeds(monkeypatch):
    job = _failed_job("owner")
    client = _client(_user("owner"), monkeypatch)
    resp = client.post(f"/api/jobs/{job.id}/retry")
    assert resp.status_code == 200
    assert resp.json()["username"] == "owner"


def test_admin_may_retry_any_job(monkeypatch):
    job = _failed_job("someone_else")
    client = _client(_user("admin", is_admin=True), monkeypatch)
    assert client.post(f"/api/jobs/{job.id}/retry").status_code == 200


# ── retry: permissions revoked after the original job ran ──

def test_retry_after_format_revoked_is_forbidden(monkeypatch):
    job = _failed_job("owner", fmt="flac")
    client = _client(_user("owner", formats=("mp3",)), monkeypatch)
    resp = client.post(f"/api/jobs/{job.id}/retry")
    assert resp.status_code == 403
    assert "flac" in resp.json()["detail"].lower()


def test_retry_after_method_revoked_is_forbidden(monkeypatch):
    job = _failed_job("owner", method="slskd")
    client = _client(_user("owner", methods=("yt-dlp",)), monkeypatch)
    resp = client.post(f"/api/jobs/{job.id}/retry")
    assert resp.status_code == 403
    assert "slskd" in resp.json()["detail"].lower()


# ── the shared helper ──

def test_resolve_allowed_keeps_the_global_default_when_permitted():
    user = _user("u", formats=("mp3", "flac"))
    assert auth.resolve_allowed(user, "flac", "format") == "flac"


def test_resolve_allowed_falls_back_to_a_permitted_value():
    """add-and-download has no format picker, so a disallowed global default must
    degrade to something the account may have rather than 403 the feature away."""
    user = _user("u", formats=("mp3",))
    assert auth.resolve_allowed(user, "flac", "format") == "mp3"


def test_resolve_allowed_never_grants_more_than_permitted():
    user = _user("u", methods=("lidarr",))
    assert auth.resolve_allowed(user, "slskd", "method") == "lidarr"


def test_resolve_allowed_rejects_an_explicitly_empty_allow_list():
    """An admin storing [] means "deny everything" — it must not be read as
    "unset" and quietly resolve to the permissive defaults."""
    from fastapi import HTTPException
    user = {"username": "u", "allowed_formats": [], "allowed_methods": []}
    with pytest.raises(HTTPException) as exc:
        auth.resolve_allowed(user, "flac", "format")
    assert exc.value.status_code == 403


def test_require_download_perms_also_denies_on_an_empty_allow_list():
    from fastapi import HTTPException
    user = {"username": "u", "allowed_formats": [], "allowed_methods": []}
    with pytest.raises(HTTPException) as exc:
        auth.require_download_perms(user, "yt-dlp", "mp3")
    assert exc.value.status_code == 403


def test_require_download_perms_accepts_a_permitted_pair():
    auth.require_download_perms(_user("u"), "slskd", "flac")
