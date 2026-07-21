"""Navidrome native-REST admin client.

Navidrome exposes a private JSON API (the one its own web UI uses) that supports
user CRUD for admins. It is NOT the Subsonic API and is not an officially stable
contract — endpoints were verified against Navidrome 0.63.2:

    POST   /auth/login        {username,password}         -> {token, ...}
    GET    /api/user          (x-nd-authorization: Bearer <token>)
    POST   /api/user          {userName,name,password,isAdmin} -> {id}
    DELETE /api/user/<id>

Auth is the `x-nd-authorization: Bearer <token>` header (NOT standard
Authorization, which returns 401). We authenticate once with the service/admin
account (the same creds library.py uses for Subsonic) and cache the token,
re-logging in on any 401.

This module only creates/finds/deletes Navidrome accounts. Password generation,
persistence and the MusicSeeker-user ⇄ Navidrome-user mapping live in auth.py.
"""
import os

import httpx

NAVIDROME_URL = os.environ.get("NAVIDROME_URL", "http://navidrome:4533")
NAVIDROME_ADMIN_USER = os.environ.get("NAVIDROME_USER", "lucas")
NAVIDROME_ADMIN_PASSWORD = os.environ.get("NAVIDROME_PASSWORD", "")

# Cached admin JWT. Navidrome tokens are short-lived (~48h); we lazily re-login
# whenever a request comes back 401, so no explicit expiry tracking is needed.
_admin_token: str | None = None


class NavidromeAdminError(Exception):
    """Raised when the Navidrome admin API cannot satisfy a request."""


async def _login(client: httpx.AsyncClient) -> str:
    if not NAVIDROME_ADMIN_PASSWORD:
        raise NavidromeAdminError("NAVIDROME_PASSWORD not configured")
    resp = await client.post("/auth/login", json={
        "username": NAVIDROME_ADMIN_USER,
        "password": NAVIDROME_ADMIN_PASSWORD,
    })
    if resp.status_code != 200:
        raise NavidromeAdminError(f"admin login failed: HTTP {resp.status_code}")
    token = resp.json().get("token")
    if not token:
        raise NavidromeAdminError("admin login returned no token")
    return token


async def _request(method: str, path: str, json: dict | None = None) -> httpx.Response:
    """Issue an authenticated native-API request, re-logging in once on 401."""
    global _admin_token
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=15) as client:
        if not _admin_token:
            _admin_token = await _login(client)
        for attempt in range(2):
            headers = {"x-nd-authorization": f"Bearer {_admin_token}"}
            resp = await client.request(method, path, json=json, headers=headers)
            if resp.status_code == 401 and attempt == 0:
                _admin_token = await _login(client)  # token expired — refresh once
                continue
            return resp
    return resp


async def find_user(username: str) -> dict | None:
    """Return the Navidrome user dict for `username` (userName match), or None."""
    resp = await _request("GET", "/api/user")
    if resp.status_code != 200:
        raise NavidromeAdminError(f"list users failed: HTTP {resp.status_code}")
    for u in resp.json():
        if u.get("userName") == username:
            return u
    return None


async def create_user(username: str, password: str, name: str = "",
                       is_admin: bool = False) -> str:
    """Create a Navidrome user and return its id. New users inherit the shared
    library automatically (verified on 0.63.2), so no library assignment needed."""
    resp = await _request("POST", "/api/user", json={
        "userName": username,
        "name": name or username,
        "password": password,
        "isAdmin": is_admin,
    })
    if resp.status_code not in (200, 201):
        raise NavidromeAdminError(
            f"create user '{username}' failed: HTTP {resp.status_code} {resp.text[:200]}")
    uid = resp.json().get("id")
    if not uid:
        raise NavidromeAdminError(f"create user '{username}' returned no id")
    return uid


async def set_password(user_id: str, username: str, password: str,
                       name: str = "", is_admin: bool = False) -> bool:
    """Reset an existing Navidrome user's password (PUT /api/user/<id>). Used when
    a MusicSeeker user exists in Navidrome but we have no stored password."""
    resp = await _request("PUT", f"/api/user/{user_id}", json={
        "userName": username,
        "name": name or username,
        "password": password,
        "isAdmin": is_admin,
    })
    return resp.status_code in (200, 201)


async def delete_user(user_id: str) -> bool:
    resp = await _request("DELETE", f"/api/user/{user_id}")
    return resp.status_code in (200, 204)
