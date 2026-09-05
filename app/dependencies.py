import os
import re
import secrets

from fastapi import Depends, HTTPException, Request

from app.services import (
    auth as auth_service,
    spotify as spotify_service,
    navidrome_admin,
    library as library_service,
)

_DEVICE_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')


def _user_spotify_creds(user: dict) -> dict | None:
    """Get Spotify credentials for a user (per-user first, then global fallback)."""
    raw = auth_service.get_user_spotify_raw(user["username"])
    if raw.get("refresh_token"):
        return raw
    # Fall back to global env credentials
    if spotify_service.SPOTIFY_REFRESH_TOKEN:
        return None  # None = use global defaults in spotify.py
    return None


async def _resolve_navidrome_creds(user: dict) -> dict | None:
    """Return {username,password} for the user's own Navidrome account, lazily
    provisioning it on first use. Returns None (→ shared service account) for the
    admin and on any provisioning error, so playback/library never hard-fails."""
    username = user["username"]
    # Admin keeps the shared service account (and owns the pre-existing playlists).
    if username == navidrome_admin.NAVIDROME_ADMIN_USER:
        return None
    stored = auth_service.get_user_navidrome_raw(username)
    if stored.get("username") and stored.get("password"):
        return stored
    # Lazy provision: create (or re-key) a Navidrome account named after the MS user.
    try:
        password = secrets.token_urlsafe(18)
        existing = await navidrome_admin.find_user(username)
        if existing:
            if not await navidrome_admin.set_password(existing["id"], username, password):
                return None
        else:
            await navidrome_admin.create_user(username, password, name=username)
        auth_service.set_user_navidrome(username, username, password)
        return {"username": username, "password": password}
    except Exception:
        return None


async def bind_navidrome_creds(user: dict = Depends(auth_service.get_current_user)) -> dict:
    """Router-level dependency: bind the logged-in user's Navidrome creds for this
    request so library.py talks to Navidrome as that user (shared music, per-user
    playlists/likes). asyncio.create_task inherits the contextvar for downloads."""
    creds = await _resolve_navidrome_creds(user)
    library_service.set_request_creds(creds)
    return user


def _get_device_id(request: Request) -> str:
    """Extract device ID from X-Device-ID header. Falls back to 'default'.
    Validates format to prevent path traversal."""
    device_id = request.headers.get("X-Device-ID", "default")
    if not _DEVICE_ID_RE.match(device_id):
        return "default"
    return device_id


async def _stream_auth(request: Request, token: str = ""):
    """Auth for stream endpoint — accepts token as query param (for <audio> element).

    Binds the user's Navidrome credentials too. A stream fetched from Navidrome
    is counted as a play by whichever account fetched it, so leaving this unbound
    put every user's listening history — and the play counts the taste profile
    reads back — on the shared service account. This cannot use
    `bind_navidrome_creds`, which resolves the user from the Authorization
    header; an <audio> element cannot send one, hence the query token.
    """
    if token:
        payload = auth_service._decode_token(token)
        if not payload:
            raise HTTPException(401, "Invalid token")
        users = auth_service._load_users()
        user_data = users.get(payload["sub"])
        if user_data is None:
            # Mirror get_current_user: a deleted user's still-unexpired token is rejected.
            raise HTTPException(401, "User no longer exists")
        user = {"username": payload["sub"], "is_admin": user_data.get("is_admin", False), **auth_service._user_perms(user_data)}
    else:
        user = auth_service.get_current_user(request)
    library_service.set_request_creds(await _resolve_navidrome_creds(user))
    return user


def _get_dir_size(path: str) -> tuple[int, int]:
    """Get total size in bytes and file count for a directory."""
    total = 0
    file_count = 0
    if not os.path.isdir(path):
        return 0, 0
    for root, dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
                file_count += 1
            except OSError:
                pass
    return total, file_count
