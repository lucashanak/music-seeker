import time
import secrets

from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import RedirectResponse

from app.services import auth, spotify as spotify_service, search_providers, settings as app_settings
from app.dependencies import _user_spotify_creds

router = APIRouter(prefix="/api/spotify", tags=["spotify"])

# In-memory store for pending OAuth states (state_token -> username)
# Entries expire after 10 minutes
_oauth_states: dict[str, dict] = {}


def _build_base_url(request: Request) -> str:
    """Get external base URL, respecting reverse proxy headers."""
    base = str(request.base_url).rstrip("/")
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    if forwarded_host:
        proto = forwarded_proto or "https"
        base = f"{proto}://{forwarded_host}"
    return base


@router.get("/playlists")
async def get_playlists(user: dict = Depends(auth.get_current_user)):
    creds = _user_spotify_creds(user)
    playlists = await spotify_service.get_user_playlists(creds=creds)
    return {"playlists": playlists}


@router.get("/liked")
async def get_liked_tracks(user: dict = Depends(auth.get_current_user)):
    creds = _user_spotify_creds(user)
    data = await spotify_service.get_liked_tracks(creds=creds)
    return data


@router.get("/playlist/{playlist_id}/tracks")
async def get_playlist_tracks(playlist_id: str, user: dict = Depends(auth.get_current_user)):
    creds = _user_spotify_creds(user)
    data = await spotify_service.get_playlist_tracks(playlist_id, creds=creds)
    return data


@router.get("/albums")
async def get_saved_albums(user: dict = Depends(auth.get_current_user)):
    creds = _user_spotify_creds(user)
    albums = await spotify_service.get_saved_albums(creds=creds)
    return {"albums": albums}


@router.get("/artists")
async def get_followed_artists(user: dict = Depends(auth.get_current_user)):
    creds = _user_spotify_creds(user)
    artists = await spotify_service.get_followed_artists(creds=creds)
    return {"artists": artists}


@router.get("/shows")
async def get_saved_shows(user: dict = Depends(auth.get_current_user)):
    creds = _user_spotify_creds(user)
    shows = await spotify_service.get_saved_shows(creds=creds)
    return {"shows": shows}


@router.get("/show/{show_id}/episodes")
async def get_show_episodes(show_id: str, user: dict = Depends(auth.get_current_user)):
    podcast_prov = app_settings._settings.get("podcast_provider", "itunes")
    if podcast_prov != "spotify":
        # Use iTunes/RSS for non-Spotify providers
        try:
            data = await search_providers.itunes_get_show_episodes(show_id)
            return data
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(f"iTunes show episodes failed: {e}")
            # Only fall back to Spotify if credentials are available
            if not spotify_service.SPOTIFY_CLIENT_ID:
                raise HTTPException(500, f"Failed to load episodes: {e}")
    data = await spotify_service.get_show_episodes(show_id)
    return data


@router.get("/auth-url")
async def spotify_auth_url(request: Request, origin: str = "", user: dict = Depends(auth.get_current_user)):
    """Return Spotify OAuth URL. Frontend redirects browser there."""
    base = origin.rstrip("/") if origin else _build_base_url(request)
    redirect_uri = f"{base}/api/spotify/callback"
    state = secrets.token_urlsafe(32)
    _oauth_states[state] = {"username": user["username"], "redirect_uri": redirect_uri, "ts": time.time()}
    # Cleanup old states (>10 min)
    cutoff = time.time() - 600
    for k in list(_oauth_states):
        if _oauth_states[k]["ts"] < cutoff:
            del _oauth_states[k]
    url = spotify_service.get_oauth_url(redirect_uri, state=state)
    return {"url": url, "redirect_uri": redirect_uri}


@router.get("/callback")
async def spotify_callback(request: Request, code: str = "", error: str = "", state: str = ""):
    """Handle Spotify OAuth callback — exchange code for tokens, store per-user."""
    if error:
        return RedirectResponse("/?spotify_error=" + error)
    if not code:
        return RedirectResponse("/?spotify_error=no_code")

    # Look up username and redirect_uri from state
    state_data = _oauth_states.pop(state, None) if state else None
    if not state_data or time.time() - state_data["ts"] > 600:
        return RedirectResponse("/?spotify_error=invalid_state")
    username = state_data["username"]
    redirect_uri = state_data.get("redirect_uri") or f"{_build_base_url(request)}/api/spotify/callback"

    try:
        data = await spotify_service.exchange_code(code, redirect_uri)
    except Exception:
        return RedirectResponse("/?spotify_error=exchange_failed")

    if "refresh_token" not in data:
        return RedirectResponse("/?spotify_error=no_refresh_token")

    # Store per-user: use global client_id/secret + user's refresh token
    auth.update_user_spotify(username, spotify_service.SPOTIFY_CLIENT_ID, spotify_service.SPOTIFY_CLIENT_SECRET, data["refresh_token"])
    return RedirectResponse("/?spotify_connected=1")


