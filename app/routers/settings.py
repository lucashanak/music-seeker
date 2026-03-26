import re

from fastapi import APIRouter, HTTPException, Depends, Request, UploadFile, File

from app.models import SettingsUpdate, LibraryCheckRequest, DeviceSettingRequest
from app.services import auth, settings as app_settings, recognize, search_providers, library
from app.dependencies import _get_device_id

_DEVICE_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')
_VALID_OUTPUT_MODES = {"default", "local", "dlna_only"}

router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings")
async def get_settings(user: dict = Depends(auth.get_current_user)):
    if user.get("is_admin"):
        return app_settings.get_all()
    return app_settings.get_public()


@router.put("/settings")
async def update_settings(req: SettingsUpdate, user: dict = Depends(auth.require_admin)):
    updated = app_settings.update(req.model_dump(exclude_none=True))
    return updated


@router.post("/recognize")
async def recognize_song(audio: UploadFile = File(...), user: dict = Depends(auth.get_current_user)):
    data = await audio.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "Audio file too large")
    result = await recognize.identify_song(data)
    if not result:
        raise HTTPException(404, "Could not identify the song")

    # Enrich with cover art from search provider
    if result.get("name"):
        try:
            provider = app_settings._settings.get("search_provider", "deezer")
            fallback = app_settings._settings.get("search_fallback", "")
            tracks = await search_providers.search(f"{result['artist']} {result['name']}", "track", 1, provider=provider, fallback=fallback)
            if tracks:
                result["image"] = result.get("image") or tracks[0].get("image", "")
                result["id"] = tracks[0].get("id", "")
                result["url"] = tracks[0].get("url", "")
        except Exception:
            pass

    return result


@router.post("/library/check")
async def check_library(req: LibraryCheckRequest, user: dict = Depends(auth.get_current_user)):
    results = await library.check_items(req.items)
    return {"results": results}


# ── Device management ──

@router.get("/user/devices")
async def get_user_devices(user: dict = Depends(auth.get_current_user)):
    devices = auth.get_user_devices(user["username"])
    return {"devices": devices}


@router.put("/user/devices/{device_id}")
async def register_or_update_device(
    device_id: str, req: DeviceSettingRequest, user: dict = Depends(auth.get_current_user)
):
    if not _DEVICE_ID_RE.match(device_id):
        raise HTTPException(400, "Invalid device ID format")
    if req.output_mode not in _VALID_OUTPUT_MODES:
        raise HTTPException(400, f"Invalid output_mode. Must be one of: {', '.join(_VALID_OUTPUT_MODES)}")
    auth.register_device(
        user["username"], device_id,
        name=req.name, output_mode=req.output_mode,
        dlna_renderer_url=req.dlna_renderer_url,
    )
    return {"status": "ok"}


@router.delete("/user/devices/{device_id}")
async def remove_device(device_id: str, user: dict = Depends(auth.get_current_user)):
    if not _DEVICE_ID_RE.match(device_id):
        raise HTTPException(400, "Invalid device ID format")
    ok = auth.remove_device(user["username"], device_id)
    if not ok:
        raise HTTPException(404, "Device not found")
    return {"status": "deleted"}


@router.get("/user/device-settings")
async def get_my_device_settings(request: Request, user: dict = Depends(auth.get_current_user)):
    """Get settings for the current device (from X-Device-ID header)."""
    device_id = _get_device_id(request)
    devices = auth.get_user_devices(user["username"])
    device = devices.get(device_id, {"name": "", "output_mode": "default", "dlna_renderer_url": ""})
    return {"device_id": device_id, **device}
