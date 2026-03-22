from fastapi import APIRouter, HTTPException, Depends, UploadFile, File

from app.models import SettingsUpdate, LibraryCheckRequest
from app.services import auth, settings as app_settings, recognize, search_providers, library

router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings")
async def get_settings(user: dict = Depends(auth.get_current_user)):
    return app_settings.get_all()


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
