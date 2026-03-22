from fastapi import APIRouter, HTTPException, Query, Depends

from app.models import ResolveRequest
from app.services import auth, lastfm, search_providers, settings as app_settings, radio

router = APIRouter(prefix="/api", tags=["discover"])


@router.get("/discover/tags")
async def discover_tags(
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(auth.get_current_user),
):
    if not lastfm.LASTFM_API_KEY:
        raise HTTPException(503, "Last.fm API key not configured")
    tags = await lastfm.get_top_tags(limit)
    return {"tags": tags}


@router.get("/discover/tag/{tag_name}")
async def discover_tag(
    tag_name: str,
    type: str = Query("track", pattern="^(track|album|artist|playlist)$"),
    limit: int = Query(20, ge=1, le=50),
    page: int = Query(1, ge=1),
    user: dict = Depends(auth.get_current_user),
):
    if not lastfm.LASTFM_API_KEY:
        raise HTTPException(503, "Last.fm API key not configured")
    if type == "track":
        results = await lastfm.get_tag_tracks(tag_name, limit, page)
    elif type == "album":
        results = await lastfm.get_tag_albums(tag_name, limit, page)
    else:
        results = await lastfm.get_tag_artists(tag_name, limit, page)
    return {"results": results, "tag": tag_name, "type": type}


@router.post("/discover/resolve")
async def discover_resolve(req: ResolveRequest, user: dict = Depends(auth.get_current_user)):
    provider = app_settings._settings.get("search_provider", "deezer")
    fallback = app_settings._settings.get("search_fallback", "")
    result = await search_providers.resolve(req.name, req.artist, req.type, provider=provider, fallback=fallback)
    if not result:
        raise HTTPException(404, "Not found")
    return result


@router.get("/radio")
async def get_radio(
    track: str = "",
    artist: str = "",
    artist_id: str = "",
    limit: int = Query(25, ge=1, le=50),
    user: dict = Depends(auth.get_current_user),
):
    source = app_settings._settings.get("recommendation_source", "combined")
    tracks = await radio.get_radio_tracks(source, track, artist, artist_id, limit)
    if not tracks:
        raise HTTPException(404, "No radio tracks found")
    return {"tracks": tracks, "source": source}
