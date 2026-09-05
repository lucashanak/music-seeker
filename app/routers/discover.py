from fastapi import APIRouter, HTTPException, Query, Depends

from app.models import ResolveRequest
from app.services import auth, lastfm, library, search_providers, settings as app_settings, radio
from app.dependencies import bind_navidrome_creds

# Router-level so it cannot be forgotten on a new endpoint: every handler here
# can reach Navidrome (directly or through a service), and without the binding
# it silently acts as the shared `lucas` service account.
router = APIRouter(prefix="/api", tags=["discover"],
                   dependencies=[Depends(bind_navidrome_creds)])


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
    novelty: str = Query("", pattern="^(new|library|)$"),
    depth: str = Query("", pattern="^(deep|popular|)$"),
    user: dict = Depends(auth.get_current_user),
):
    if not lastfm.LASTFM_API_KEY:
        raise HTTPException(503, "Last.fm API key not configured")

    # depth=deep: skip past the most-popular page to surface lesser-known tracks.
    # Last.fm tag.getTopTracks is relevance-ordered; paging deeper is the reliable
    # way to reach deeper cuts (per-track listener counts are not consistently returned).
    fetch_page = page
    if depth == "deep" and type == "track":
        fetch_page = page + 2

    if type == "track":
        results = await lastfm.get_tag_tracks(tag_name, limit, fetch_page)
        # If any listener counts came through, refine ordering within the page.
        if depth == "deep" and any(r.get("listeners") for r in results):
            results.sort(key=lambda r: r.get("listeners") or 0)
        elif depth == "popular" and any(r.get("listeners") for r in results):
            results.sort(key=lambda r: r.get("listeners") or 0, reverse=True)
    elif type == "album":
        results = await lastfm.get_tag_albums(tag_name, limit, page)
    else:
        results = await lastfm.get_tag_artists(tag_name, limit, page)

    # novelty filter: keep only new (not in library) or only owned tracks.
    # Degrades to no-filter if the library is unavailable / check fails.
    if novelty and results and type in ("track", "album"):
        try:
            owned = await library.check_items(results)
            if len(owned) == len(results):
                if novelty == "new":
                    results = [r for r, o in zip(results, owned) if not o]
                elif novelty == "library":
                    results = [r for r, o in zip(results, owned) if o]
        except Exception:
            pass

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


@router.get("/radio/track")
async def get_track_radio_endpoint(
    track: str = Query(..., min_length=1),
    artist: str = Query(..., min_length=1),
    album: str = "",
    id: str = "",
    camelot: str = "",
    bpm: float | None = None,
    limit: int = Query(25, ge=1, le=50),
    vibe: str = Query("", pattern="^(calm|energy|)$"),
    user: dict = Depends(auth.get_current_user),
):
    source = app_settings._settings.get("recommendation_source", "combined")
    seed = {
        "name": track,
        "artist": artist,
        "album": album,
        "id": id,
        "camelot": camelot,
        "bpm": bpm,
    }
    recs = await radio.get_track_radio(seed, source, limit, vibe=vibe or None)
    if not recs:
        raise HTTPException(404, "No radio tracks found")
    return {"tracks": recs, "seed": {"name": track, "artist": artist}, "source": source}
