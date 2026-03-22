from fastapi import APIRouter, HTTPException, Depends

from app.models import LoginRequest, SpotifyConnectRequest, UserSettingRequest, ChangePasswordRequest
from app.services import auth as auth_service, spotify as spotify_service

router = APIRouter(prefix="/api", tags=["auth"])


@router.post("/auth/login")
async def login(req: LoginRequest):
    token = auth_service.login(req.username, req.password)
    if not token:
        raise HTTPException(401, "Invalid username or password")
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
        raise HTTPException(400, f"Invalid Spotify credentials: {e}")
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
