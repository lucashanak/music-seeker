from fastapi import APIRouter, HTTPException, Query, Depends

from app.services import auth, search_providers, settings as app_settings

router = APIRouter(prefix="/api", tags=["search"])


@router.get("/search")
async def search(
    q: str = Query(..., min_length=1),
    type: str = Query("track", pattern="^(track|album|artist|playlist|show|episode)$"),
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0),
    user: dict = Depends(auth.get_current_user),
):
    search_type = type
    if search_type in ("show", "episode"):
        provider = app_settings._settings.get("podcast_provider", "itunes")
    else:
        provider = app_settings._settings.get("search_provider", "deezer")
    fallback = app_settings._settings.get("search_fallback", "")
    results = await search_providers.search(q, search_type, limit, offset, provider=provider, fallback=fallback)
    return {"results": results, "query": q, "type": search_type}


@router.get("/artist/{artist_id}/albums")
async def get_artist_albums(artist_id: str, user: dict = Depends(auth.get_current_user)):
    data = await search_providers.deezer_get_artist_albums(artist_id)
    return data


@router.get("/album/{album_id}/tracks")
async def get_album_tracks(album_id: str, user: dict = Depends(auth.get_current_user)):
    tracks = await search_providers.deezer_get_album_tracks(album_id)
    return {"tracks": tracks}
