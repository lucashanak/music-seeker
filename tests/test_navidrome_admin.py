"""API-canary tests for the Navidrome native admin client.

Navidrome's native REST API (used for per-user account provisioning) is a
private, unversioned contract. These tests exercise it end-to-end against a LIVE
Navidrome so that a Navidrome upgrade which changes the login flow, the
`x-nd-authorization` header, or the /api/user CRUD shape fails here immediately —
before it silently breaks user provisioning in production.

Run against a reachable Navidrome, e.g.:
    NAVIDROME_URL=http://localhost:4533 NAVIDROME_USER=lucas \
    NAVIDROME_PASSWORD=... pytest tests/test_navidrome_admin.py -v

Skipped automatically when NAVIDROME_PASSWORD is unset (e.g. plain CI).
"""
import asyncio
import os

import httpx
import pytest

from app.services import navidrome_admin as na

pytestmark = pytest.mark.skipif(
    not os.environ.get("NAVIDROME_PASSWORD"),
    reason="NAVIDROME_PASSWORD not set — canary needs a live Navidrome",
)

PROBE_USER = "ms_canary_probe"
PROBE_PW1 = "MsCanaryPw_123!"
PROBE_PW2 = "MsCanaryPw_456!"


def _run(coro):
    return asyncio.run(coro)


def test_login_returns_jwt_token():
    """POST /auth/login must return a token we can use as x-nd-authorization."""
    async def go():
        async with httpx.AsyncClient(base_url=na.NAVIDROME_URL, timeout=15) as client:
            token = await na._login(client)
            assert isinstance(token, str) and token, "login returned no token"
    _run(go())


def test_x_nd_authorization_header_required():
    """The native API must reject the standard Authorization header (regression
    guard: if this starts passing, Navidrome changed its auth scheme)."""
    async def go():
        async with httpx.AsyncClient(base_url=na.NAVIDROME_URL, timeout=15) as client:
            token = await na._login(client)
            std = await client.get("/api/user", headers={"Authorization": f"Bearer {token}"})
            assert std.status_code == 401, f"expected 401 for std Authorization, got {std.status_code}"
            ok = await client.get("/api/user", headers={"x-nd-authorization": f"Bearer {token}"})
            assert ok.status_code == 200, f"x-nd-authorization should work, got {ok.status_code}"
    _run(go())


def test_user_crud_contract():
    """create → find → set_password → delete round-trip must hold."""
    async def go():
        # Clean slate in case a previous run aborted before cleanup.
        stale = await na.find_user(PROBE_USER)
        if stale:
            await na.delete_user(stale["id"])

        uid = await na.create_user(PROBE_USER, PROBE_PW1, name="MS Canary")
        try:
            assert uid, "create_user returned no id"

            found = await na.find_user(PROBE_USER)
            assert found is not None, "created user not found"
            assert found["id"] == uid
            assert found["userName"] == PROBE_USER

            assert await na.set_password(uid, PROBE_USER, PROBE_PW2) is True
        finally:
            assert await na.delete_user(uid) is True
            assert await na.find_user(PROBE_USER) is None, "user still present after delete"
    _run(go())
