import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from fastapi import Request, HTTPException

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
    return secret

JWT_SECRET = _get_jwt_secret()
TOKEN_EXPIRY = 7 * 24 * 3600  # 7 days


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_users() -> dict:
    _ensure_data_dir()
    if USERS_FILE.exists():
        return json.loads(USERS_FILE.read_text())
    return {}


def _save_users(users: dict):
    _ensure_data_dir()
    USERS_FILE.write_text(json.dumps(users, indent=2))


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return f"{salt}:{h.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    salt, h = stored.split(":", 1)
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return hmac.compare_digest(check.hex(), h)


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
    }


def init_admin(username: str, password: str):
    """Create admin user if no users exist."""
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
    return _create_token(username, user.get("is_admin", False))


def get_current_user(request: Request) -> dict:
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

    users = _load_users()
    user_data = users.get(payload["sub"], {})
    perms = _user_perms(user_data)
    return {"username": payload["sub"], "is_admin": payload.get("admin", False), **perms}


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


def create_user(username: str, password: str, is_admin: bool = False,
                allowed_formats: list[str] | None = None,
                allowed_methods: list[str] | None = None) -> bool:
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
    users = _load_users()
    if username not in users:
        return False
    users[username]["password"] = _hash_password(new_password)
    _save_users(users)
    return True
