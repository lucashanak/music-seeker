from fastapi import APIRouter, HTTPException, Depends

from pydantic import BaseModel, Field

from app.services import auth, playlist_import
from app.dependencies import _user_spotify_creds

router = APIRouter(prefix="/api/import", tags=["import"])

# Shown when the source refused to hand over the whole thing. Factual on purpose:
# the 100-track ceiling is Spotify's public page, and both ways out are real.
_TRUNCATED_NOTE = ("Spotify's public page only exposes the first 100 tracks. "
                   "Paste the playlist's track links to import more (up to "
                   f"{playlist_import._TEXT_MAX_ENTRIES} per paste), "
                   "or restore Premium on the app account.")
_TRUNCATED_NOTE_GENERIC = "The source capped this import, so some tracks are missing."


class ImportUrlRequest(BaseModel):
    url: str = Field(max_length=2048)


class ImportTextRequest(BaseModel):
    # ~200 KB, well past _TEXT_MAX_ENTRIES worth of `Artist - Title` lines, but
    # bounded: the body used to be parsed before anything could reject its size.
    text: str = Field(max_length=200_000)


@router.post("/playlist")
async def import_playlist(req: ImportUrlRequest, user: dict = Depends(auth.get_current_user)):
    """Resolve a shared Spotify/Deezer playlist or album link to its tracks."""
    creds = _user_spotify_creds(user)
    try:
        data = await playlist_import.import_from_url(req.url, creds=creds)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except playlist_import.ImportNotFound as e:
        # Private or deleted playlist: the embed page 404s. Not our fault, not a 500.
        raise HTTPException(404, str(e))
    except playlist_import.ImportUnavailable as e:
        raise HTTPException(502, str(e))
    except RuntimeError as e:
        # Anything the service didn't classify still beats an uncaught 500 traceback
        # (prod logs to an uncapped json-file driver on a small disk).
        raise HTTPException(502, str(e))
    note = ""
    if data["truncated"]:
        note = _TRUNCATED_NOTE if data["source"] == "spotify" else _TRUNCATED_NOTE_GENERIC
    return {**data, "note": note}


@router.post("/tracks")
async def import_tracks(req: ImportTextRequest, user: dict = Depends(auth.get_current_user)):
    """Resolve pasted per-track links (or `Artist - Title` lines) to tracks."""
    creds = _user_spotify_creds(user)
    return await playlist_import.import_from_text(req.text, creds=creds)
