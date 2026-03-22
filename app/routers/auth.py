import asyncio
import time

from fastapi import APIRouter, HTTPException, Depends, Request

from app.models import LoginRequest, SpotifyConnectRequest, UserSettingRequest, ChangePasswordRequest
from app.services import auth as auth_service, spotify as spotify_service

router = APIRouter(prefix="/api", tags=["auth"])

# Simple rate limiter: {ip: [timestamps]}
_login_attempts: dict[str, list[float]] = {}
_MAX_ATTEMPTS = 5
_WINDOW_SECONDS = 300  # 5 minutes


@router.post("/auth/login")
async def login(req: LoginRequest, request: Request):
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    # Clean old attempts
    attempts = [t for t in _login_attempts.get(ip, []) if now - t < _WINDOW_SECONDS]
    if len(attempts) >= _MAX_ATTEMPTS:
        raise HTTPException(429, "Too many login attempts. Try again later.")
    token = auth_service.login(req.username, req.password)
    if not token:
        attempts.append(now)
        _login_attempts[ip] = attempts
        await asyncio.sleep(1)  # slow down brute force
        raise HTTPException(401, "Invalid username or password")
    _login_attempts.pop(ip, None)  # clear on success
    return {"token": token}


@router.get("/auth/me")
async def get_me(user: dict = Depends(auth_service.get_current_user)):
    return user


@router.put("/user/spotify")
async def connect_user_spotify(req: SpotifyConnectRequest, user: dict = Depends(auth_service.get_current_user)):
    # Validate credentials by trying to get a token
    try:
        creds = {"client_id": req.client_id, "client_secret": req.client_secret, "refresh_token": req.refresh_token}
        await spotify_service.get_user_token(creds)
    except Exception as e:
        raise HTTPException(400, "Invalid Spotify credentials")
    auth_service.update_user_spotify(user["username"], req.client_id, req.client_secret, req.refresh_token)
    return {"status": "connected"}


@router.get("/user/spotify")
async def get_user_spotify(user: dict = Depends(auth_service.get_current_user)):
    return auth_service.get_user_spotify(user["username"])


@router.delete("/user/spotify")
async def disconnect_user_spotify(user: dict = Depends(auth_service.get_current_user)):
    auth_service.clear_user_spotify(user["username"])
    return {"status": "disconnected"}


@router.put("/user/settings")
async def update_user_settings(req: UserSettingRequest, user: dict = Depends(auth_service.get_current_user)):
    data = req.model_dump(exclude_none=True)
    for key, value in data.items():
        auth_service.update_user_setting(user["username"], key, value)
    return {"status": "updated", **data}


@router.put("/users/{username}/password")
async def change_password(username: str, req: ChangePasswordRequest, user: dict = Depends(auth_service.get_current_user)):
    if username != user["username"] and not user.get("is_admin"):
        raise HTTPException(403, "Can only change your own password")
    if not auth_service.change_password(username, req.new_password):
        raise HTTPException(404, "User not found")
    return {"status": "updated"}
