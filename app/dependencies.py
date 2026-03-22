import os

from fastapi import HTTPException, Request

from app.services import auth as auth_service, spotify as spotify_service


def _user_spotify_creds(user: dict) -> dict | None:
    """Get Spotify credentials for a user (per-user first, then global fallback)."""
    raw = auth_service.get_user_spotify_raw(user["username"])
    if raw.get("refresh_token"):
        return raw
    # Fall back to global env credentials
    if spotify_service.SPOTIFY_REFRESH_TOKEN:
        return None  # None = use global defaults in spotify.py
    return None


def _stream_auth(request: Request, token: str = ""):
    """Auth for stream endpoint — accepts token as query param (for <audio> element)."""
    if token:
        payload = auth_service._decode_token(token)
        if not payload:
            raise HTTPException(401, "Invalid token")
        users = auth_service._load_users()
        user_data = users.get(payload["sub"], {})
        return {"username": payload["sub"], "is_admin": payload.get("admin", False), **auth_service._user_perms(user_data)}
    return auth_service.get_current_user(request)


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
