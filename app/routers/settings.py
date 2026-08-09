import asyncio
import logging
import re

from fastapi import APIRouter, HTTPException, Depends, Request, UploadFile, File

from app.models import SettingsUpdate, LibraryCheckRequest, DeviceSettingRequest
from app.services import auth, settings as app_settings, recognize, search_providers, library, recognize_history
from app.dependencies import _get_device_id

logger = logging.getLogger(__name__)

_DEVICE_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')
_VALID_OUTPUT_MODES = {"default", "local", "dlna_only"}

router = APIRouter(prefix="/api", tags=["settings"])


def _title_matches(candidate_name: str, shazam_name: str) -> bool:
    """Wrap library._matches with a fallback for non-Latin titles.

    library._normalize does NFKD then ascii-encode-ignore, which erases Cyrillic,
    Hangul, Japanese, and Chinese entirely. When both sides normalise to empty,
    library._matches returns False — but that's not evidence of a mismatch, it's
    evidence normalisation can't represent the script, so a correctly-recognised
    K-pop or Russian-titled track would otherwise lose its download link. Fixed here
    rather than in library._matches: find_song_id depends on that function's current
    strictness, so "both sides empty" is treated as inconclusive and falls back to a
    case-folded comparison of the raw strings instead of rejecting outright.
    """
    if library._matches(candidate_name, shazam_name):
        return True
    if not library._normalize(candidate_name) and not library._normalize(shazam_name):
        a, b = candidate_name.strip().casefold(), shazam_name.strip().casefold()
        # Equality only, deliberately: _artist_matches also returns True when a name
        # normalizes away, which is exactly the non-Latin case — so a substring arm here
        # would collapse the whole guard to "is one title a prefix of the other" and
        # adopt the wrong download URL (e.g. "사랑" matching "사랑해").
        if a and b:
            return a == b
    return False


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

    try:
        result = await recognize.identify_song(
            data, user=user.get("username", ""), content_type=audio.content_type or "",
        )
    except recognize.RecognizerInputError as e:
        raise HTTPException(422, str(e))
    except recognize.RecognizerUnavailable as e:
        raise HTTPException(503, str(e))

    if not result:
        raise HTTPException(
            404,
            "No match — Shazam didn't recognise this recording. Covers, live versions, "
            "instrumentals and obscure releases often aren't in its database.",
        )

    # Enrich with cover art / provider id, but only adopt id/url when a candidate's
    # artist+title actually match Shazam's result — otherwise a cover, live cut, or
    # wrong artist could get returned instead (the frontend feeds this `url` straight
    # into the download modal). Reuses library's existing fuzzy title/artist matching
    # rather than re-implementing normalisation here. Always adopt `image`: cosmetic,
    # low risk either way.
    #
    # Fetch a handful of results, not just the top one: if the provider's #1 hit is a
    # cover or a compilation credit, the guard correctly rejects it, but a single
    # candidate then means the user loses the download link on a correctly identified
    # song. Walk the results and take the first one that passes the guard.
    if result.get("name"):
        try:
            provider = app_settings._settings.get("search_provider", "deezer")
            fallback = app_settings._settings.get("search_fallback", "")
            # Bounded: search() tries the primary provider then the fallback, each on a
            # 10s httpx timeout, so an unbounded call could add 20s on top of ffmpeg and
            # Shazam and blow past the client's 30s abort — the client would then report
            # a timeout for a song the server had already identified. The except below
            # swallows the TimeoutError and simply degrades to "no download link".
            tracks = await asyncio.wait_for(
                search_providers.search(
                    f"{result['artist']} {result['name']}", "track", 5,
                    provider=provider, fallback=fallback, raise_on_error=True,
                ),
                timeout=5,
            )
            if tracks:
                matched = None
                for candidate in tracks:
                    if (_title_matches(candidate.get("name", ""), result["name"])
                            and library._artist_matches(candidate.get("artist", ""), result["artist"])):
                        matched = candidate
                        break
                # Take the cover from whichever candidate we actually trust, so the card
                # can't show candidate #0's art next to candidate #3's download target.
                result["image"] = result.get("image") or (matched or tracks[0]).get("image", "")
                if matched:
                    result["id"] = matched.get("id", "")
                    result["url"] = matched.get("url", "")
                else:
                    logger.warning(
                        "recognize enrichment mismatch, not adopting id/url: shazam=%r/%r candidates=%r",
                        result["artist"], result["name"],
                        [(c.get("artist"), c.get("name")) for c in tracks],
                    )
        except Exception as e:
            logger.warning("recognize enrichment failed: %s: %s", type(e).__name__, e)

    try:
        recognize_history.add_entry(
            user["username"], result, recognized_by=result.get("recognized_by", "")
        )
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
