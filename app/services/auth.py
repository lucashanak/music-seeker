import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

from fastapi import Request, Response, HTTPException

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
USERS_FILE = DATA_DIR / "users.json"
def _get_jwt_secret():
    """Get or create a persistent JWT secret."""
    secret_file = DATA_DIR / "jwt_secret"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    env_secret = os.environ.get("JWT_SECRET")
    if env_secret:
        return env_secret
    if secret_file.exists():
        return secret_file.read_text().strip()
    secret = secrets.token_hex(32)
    secret_file.write_text(secret)
    os.chmod(secret_file, 0o600)
    return secret

JWT_SECRET = _get_jwt_secret()
TOKEN_EXPIRY = 30 * 24 * 3600  # 30 days — combined with sliding renewal (see
                               # get_current_user) an active session never expires.
STREAM_TOKEN_EXPIRY = 6 * 3600  # 6 hours — stream-scoped tokens used in <audio>/cast URLs

# Usernames become filesystem paths (per-user queue files) — restrict to a safe set
# and require an alphanumeric first char so "." / ".." / "-x" can't slip through.
_USERNAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


# mtime-keyed cache so hot read paths (e.g. the remote-control device snapshot,
# broadcast every few seconds per device) don't re-read+parse users.json from disk
# on every call. Safe because every mutator goes through _save_users, which refreshes
# the cache; reads and the load→mutate→save pattern run synchronously with no awaits
# in between, so there is no interleaving on the single-threaded event loop.
_users_cache: dict | None = None
_users_cache_mtime: float = -1.0


def _load_users() -> dict:
    global _users_cache, _users_cache_mtime
    _ensure_data_dir()
    if not USERS_FILE.exists():
        _users_cache, _users_cache_mtime = {}, -1.0
        return _users_cache
    mtime = USERS_FILE.stat().st_mtime
    if _users_cache is None or mtime != _users_cache_mtime:
        _users_cache = json.loads(USERS_FILE.read_text())
        _users_cache_mtime = mtime
    return _users_cache


def _save_users(users: dict):
    global _users_cache, _users_cache_mtime
    _ensure_data_dir()
    USERS_FILE.write_text(json.dumps(users, indent=2))
    _users_cache = users
    _users_cache_mtime = USERS_FILE.stat().st_mtime


PBKDF2_ITERATIONS = 600_000  # OWASP 2023 recommendation for SHA-256


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    return f"{salt}:{h.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    salt, h = stored.split(":", 1)
    # Try new iteration count first, fallback to legacy 100k
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    if hmac.compare_digest(check.hex(), h):
        return True
    check_legacy = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return hmac.compare_digest(check_legacy.hex(), h)


def _create_token(username: str, is_admin: bool) -> str:
    """Simple HMAC-based token (no external JWT lib needed)."""
    payload = json.dumps({
        "sub": username,
        "admin": is_admin,
        "exp": int(time.time()) + TOKEN_EXPIRY,
    })
    import base64
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).decode()
    sig = hmac.new(JWT_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def create_stream_token(username: str, ttl: int = STREAM_TOKEN_EXPIRY) -> str:
    """Short-lived, stream-scoped token (aud=stream) for use in <audio>/cast stream
    URLs. Accepted only by stream endpoints; get_current_user rejects aud=stream, so
    a leaked stream token cannot read the library, settings, or account.
    The cast path passes a longer ttl since a renderer holds the URL for the session."""
    payload = json.dumps({
        "sub": username,
        "aud": "stream",
        "exp": int(time.time()) + ttl,
    })
    import base64
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).decode()
    sig = hmac.new(JWT_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def _decode_token(token: str) -> dict | None:
    import base64
    try:
        payload_b64, sig = token.rsplit(".", 1)
        expected = hmac.new(JWT_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None


DEFAULT_PERMS = {
    "allowed_formats": ["mp3", "flac"],
    "allowed_methods": ["yt-dlp", "slskd", "lidarr"],
    "quota_gb": 0,  # 0 = unlimited
}


def _user_perms(user: dict) -> dict:
    return {
        "allowed_formats": user.get("allowed_formats", DEFAULT_PERMS["allowed_formats"]),
        "allowed_methods": user.get("allowed_methods", DEFAULT_PERMS["allowed_methods"]),
        "quota_gb": user.get("quota_gb", DEFAULT_PERMS["quota_gb"]),
        "hide_spotify": user.get("hide_spotify", False),
        "has_spotify": bool(user.get("spotify_refresh_token")),
    }


def init_admin(username: str, password: str):
    """Create admin user if no users exist."""
    if not _USERNAME_RE.match(username or ""):
        raise ValueError("Invalid admin username")
    users = _load_users()
    if not users:
        users[username] = {
            "password": _hash_password(password),
            "is_admin": True,
            **DEFAULT_PERMS,
        }
        _save_users(users)


def login(username: str, password: str) -> str | None:
    users = _load_users()
    user = users.get(username)
    if not user or not _verify_password(password, user["password"]):
        return None
    # Auto-upgrade legacy hashes (100k iterations → 600k)
    salt = user["password"].split(":")[0]
    new_hash = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    if not hmac.compare_digest(new_hash.hex(), user["password"].split(":")[1]):
        user["password"] = _hash_password(password)
        _save_users(users)
    return _create_token(username, user.get("is_admin", False))


def get_current_user(request: Request, response: Response = None) -> dict:
    """Extract and validate user from Authorization header."""
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
    else:
        token = request.cookies.get("token", "")

    if not token:
        raise HTTPException(401, "Not authenticated")

    payload = _decode_token(token)
    if not payload:
        raise HTTPException(401, "Invalid or expired token")
    if payload.get("aud") == "stream":
        # Stream-scoped tokens may only be used on stream endpoints.
        raise HTTPException(401, "Stream token not valid for this endpoint")

    users = _load_users()
    user_data = users.get(payload["sub"])
    if user_data is None:
        raise HTTPException(401, "User no longer exists")

    # Sliding renewal: once a token is past the halfway point of its lifetime, mint
    # a fresh one and hand it back via a response header. The frontend swaps it in
    # (see api.js), so any active session keeps rolling forward and never reaches the
    # hard 30-day expiry. FastAPI injects `response` when this runs as a route
    # dependency; require_admin calls this directly (response=None) and simply skips
    # renewal, which is fine since read endpoints refresh the token continuously.
    if response is not None:
        exp = payload.get("exp", 0)
        if exp - time.time() < TOKEN_EXPIRY / 2:
            response.headers["X-Refresh-Token"] = _create_token(
                payload["sub"], user_data.get("is_admin", False))
            response.headers["Access-Control-Expose-Headers"] = "X-Refresh-Token"

    perms = _user_perms(user_data)
    return {"username": payload["sub"], "is_admin": user_data.get("is_admin", False), **perms}


def require_admin(request: Request) -> dict:
    user = get_current_user(request)
    if not user.get("is_admin"):
        raise HTTPException(403, "Admin access required")
    return user


def list_users() -> list[dict]:
    users = _load_users()
    return [
        {"username": k, "is_admin": v.get("is_admin", False), **_user_perms(v)}
        for k, v in users.items()
    ]


MIN_PASSWORD_LENGTH = 8


def create_user(username: str, password: str, is_admin: bool = False,
                allowed_formats: list[str] | None = None,
                allowed_methods: list[str] | None = None) -> bool:
    if not _USERNAME_RE.match(username or ""):
        raise ValueError("Username must be 1-64 chars: letters, digits, _ . - (and start alphanumeric)")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    users = _load_users()
    if username in users:
        return False
    users[username] = {
        "password": _hash_password(password),
        "is_admin": is_admin,
        "allowed_formats": allowed_formats or DEFAULT_PERMS["allowed_formats"],
        "allowed_methods": allowed_methods or DEFAULT_PERMS["allowed_methods"],
    }
    _save_users(users)
    return True


def update_user_perms(username: str, allowed_formats: list[str] | None = None,
                      allowed_methods: list[str] | None = None,
                      quota_gb: float | None = None) -> bool:
    users = _load_users()
    if username not in users:
        return False
    if allowed_formats is not None:
        users[username]["allowed_formats"] = allowed_formats
    if allowed_methods is not None:
        users[username]["allowed_methods"] = allowed_methods
    if quota_gb is not None:
        users[username]["quota_gb"] = max(0, quota_gb)
    _save_users(users)
    return True


def delete_user(username: str) -> bool:
    users = _load_users()
    if username not in users:
        return False
    del users[username]
    _save_users(users)
    return True


def change_password(username: str, new_password: str) -> bool:
    if len(new_password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    users = _load_users()
    if username not in users:
        return False
    users[username]["password"] = _hash_password(new_password)
    _save_users(users)
    return True


def get_user_spotify(username: str) -> dict:
    """Get user's Spotify credentials (masked)."""
    users = _load_users()
    user = users.get(username, {})
    return {
        "spotify_client_id": user.get("spotify_client_id", ""),
        "spotify_client_secret": bool(user.get("spotify_client_secret", "")),
        "spotify_refresh_token": bool(user.get("spotify_refresh_token", "")),
        "connected": bool(user.get("spotify_refresh_token")),
    }


def get_user_spotify_raw(username: str) -> dict:
    """Get user's actual Spotify credentials (not masked)."""
    users = _load_users()
    user = users.get(username, {})
    return {
        "client_id": user.get("spotify_client_id", ""),
        "client_secret": user.get("spotify_client_secret", ""),
        "refresh_token": user.get("spotify_refresh_token", ""),
    }


def update_user_spotify(username: str, client_id: str, client_secret: str, refresh_token: str) -> bool:
    users = _load_users()
    if username not in users:
        return False
    users[username]["spotify_client_id"] = client_id
    users[username]["spotify_client_secret"] = client_secret
    users[username]["spotify_refresh_token"] = refresh_token
    _save_users(users)
    return True


def clear_user_spotify(username: str) -> bool:
    users = _load_users()
    if username not in users:
        return False
    users[username].pop("spotify_client_id", None)
    users[username].pop("spotify_client_secret", None)
    users[username].pop("spotify_refresh_token", None)
    _save_users(users)
    return True


# ── Per-user Navidrome account (playlists/likes/stars isolated; library shared) ──
def get_user_navidrome_raw(username: str) -> dict:
    """Get the user's stored per-user Navidrome account creds (empty if none)."""
    users = _load_users()
    user = users.get(username, {})
    return {
        "username": user.get("navidrome_user", ""),
        "password": user.get("navidrome_password", ""),
    }


def set_user_navidrome(username: str, navidrome_user: str, navidrome_password: str) -> bool:
    """Persist the Navidrome account provisioned for this MusicSeeker user."""
    users = _load_users()
    if username not in users:
        return False
    users[username]["navidrome_user"] = navidrome_user
    users[username]["navidrome_password"] = navidrome_password
    _save_users(users)
    return True


def update_user_setting(username: str, key: str, value) -> bool:
    """Update a single user-level setting (e.g., hide_spotify)."""
    allowed = {"hide_spotify"}
    if key not in allowed:
        return False
    users = _load_users()
    if username not in users:
        return False
    users[username][key] = value
    _save_users(users)
    return True


def get_user_devices(username: str) -> dict:
    """Get all registered devices for a user."""
    users = _load_users()
    return users.get(username, {}).get("devices", {})


def register_device(username: str, device_id: str, name: str = "",
                     output_mode: str = "default", dlna_renderer_url: str = "") -> bool:
    """Register or update a device for a user."""
    users = _load_users()
    if username not in users:
        return False
    if "devices" not in users[username]:
        users[username]["devices"] = {}
    existing = users[username]["devices"].get(device_id, {})
    users[username]["devices"][device_id] = {
        "name": name or existing.get("name", ""),
        "output_mode": output_mode or existing.get("output_mode", "default"),
        "dlna_renderer_url": dlna_renderer_url if dlna_renderer_url is not None else existing.get("dlna_renderer_url", ""),
    }
    _save_users(users)
    return True


def update_device_setting(username: str, device_id: str, key: str, value) -> bool:
    """Update a single device setting."""
    allowed = {"name", "output_mode", "dlna_renderer_url"}
    if key not in allowed:
        return False
    users = _load_users()
    if username not in users:
        return False
    devices = users[username].get("devices", {})
    if device_id not in devices:
        return False
    devices[device_id][key] = value
    _save_users(users)
    return True


def remove_device(username: str, device_id: str) -> bool:
    """Remove a device and its queue file."""
    users = _load_users()
    if username not in users:
        return False
    devices = users[username].get("devices", {})
    if device_id not in devices:
        return False
    del devices[device_id]
    _save_users(users)
    # Remove queue file
    import os
    queue_path = os.path.join(os.environ.get("DATA_DIR", "/app/data"), "player", f"{username}_{device_id}.json")
    if os.path.exists(queue_path):
        os.unlink(queue_path)
    return True
