from fastapi import APIRouter, HTTPException, Query, Depends

from app.services import auth, search_providers, settings as app_settings
from app.dependencies import _user_spotify_creds

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
        # The music fallback can't serve podcasts (deezer_search has no show/episode type)
        fallback = "none"
    else:
        provider = app_settings._settings.get("search_provider", "deezer")
        fallback = app_settings._settings.get("search_fallback", "")
    results = await search_providers.search(q, search_type, limit, offset, provider=provider, fallback=fallback)
    return {"results": results, "query": q, "type": search_type}


@router.get("/search/all")
async def search_all(
    q: str = Query(..., min_length=1),
    limit_per_type: int = Query(8, ge=1, le=20),
    user: dict = Depends(auth.get_current_user),
):
    provider = app_settings._settings.get("search_provider", "deezer")
    fallback = app_settings._settings.get("search_fallback", "")
    return await search_providers.search_all(q, provider=provider, fallback=fallback, limit_per_type=limit_per_type)


@router.get("/artist/{artist_id}/albums")
async def get_artist_albums(
    artist_id: str,
    provider: str = Query(""),
    user: dict = Depends(auth.get_current_user),
):
    provider = provider or app_settings._settings.get("search_provider", "deezer")
    data = await search_providers.get_artist_albums(artist_id, provider=provider)
    return data


@router.get("/album/{album_id}/tracks")
async def get_album_tracks(
    album_id: str,
    provider: str = Query(""),
    user: dict = Depends(auth.get_current_user),
):
    provider = provider or app_settings._settings.get("search_provider", "deezer")
    tracks = await search_providers.get_album_tracks(album_id, provider=provider)
    return {"tracks": tracks}


@router.get("/playlist/{playlist_id}/tracks")
async def get_playlist_tracks(
    playlist_id: str,
    provider: str = Query(""),
    user: dict = Depends(auth.get_current_user),
):
    provider = provider or app_settings._settings.get("search_provider", "deezer")
    # Pass the caller's own Spotify creds so a spotify-sourced playlist reads the
    # same account as /api/spotify/playlist/{id}/tracks (only used by that branch).
    data = await search_providers.get_playlist_tracks(
        playlist_id, provider=provider, creds=_user_spotify_creds(user))
    return {
        "tracks": data.get("tracks", []),
        "name": data.get("name", ""),
        "image": data.get("image", ""),
    }
