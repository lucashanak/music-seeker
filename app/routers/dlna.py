from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel

from app.services import auth, dlna
from app.dependencies import _get_device_id

router = APIRouter(prefix="/api/dlna", tags=["dlna"])


class CastRequest(BaseModel):
    device_id: str
    name: str
    artist: str = ""
    album: str = ""
    image: str = ""
    duration_ms: int = 0


class SeekRequest(BaseModel):
    position_seconds: float


class VolumeRequest(BaseModel):
    volume: int


def _session_key(user: dict, request: Request) -> str:
    return f"{user['username']}:{_get_device_id(request)}"


@router.get("/devices")
async def get_devices(user: dict = Depends(auth.get_current_user)):
    return {"devices": dlna.get_devices()}


@router.post("/scan")
async def scan_devices(user: dict = Depends(auth.get_current_user)):
    """Active SSDP scan for DLNA renderers on LAN."""
    found = await dlna.scan_devices()
    devices = [
        {"id": d.get("udn", ""), "name": d.get("name", ""), "ip": d.get("ip", ""), "location": d.get("location", "")}
        for d in found
    ]
    return {"devices": devices}


@router.post("/cast")
async def cast_to_device(req: CastRequest, request: Request, user: dict = Depends(auth.get_current_user)):
    import asyncio
    sk = _session_key(user, request)
    # Stream-scoped, short-lived token — this token is sent cleartext to the UPnP
    # renderer and embedded in DIDL metadata, so it must NOT be the full session JWT.
    token = auth.create_stream_token(user["username"], ttl=24 * 3600)
    # Await the cast so a failure is surfaced to the client — fire-and-forget meant a
    # failed cast (incl. an auto-advance re-cast) silently stalled the queue. Bounded by
    # the per-call renderer timeouts inside cast_to_device (+ a hard ceiling here).
    try:
        ok = await asyncio.wait_for(dlna.cast_to_device(
            sk, req.device_id, req.name, req.artist, token,
            album=req.album, image=req.image, duration_ms=req.duration_ms,
        ), timeout=40)
    except asyncio.TimeoutError:
        ok = False
    # Why the cast failed decides what the user should do, and the client needs to tell
    # a dead renderer from a bad track: on "device" it stops casting instead of walking
    # the queue one failed track at a time.
    except dlna.CastUnreachable as e:
        raise HTTPException(503, {
            "message": f"{e.device} did not answer — switch it on and check it is on the network",
            "cause": "device",
        })
    except dlna.CastRefused as e:
        raise HTTPException(409, {
            "message": f"{e.device} refused the track — wake it from standby and select its network input",
            "cause": "device",
        })
    if not ok:
        raise HTTPException(502, {"message": "Cast failed", "cause": "unknown"})
    return {"status": "casting"}


@router.post("/play")
async def play(request: Request, user: dict = Depends(auth.get_current_user)):
    ok = await dlna.play(_session_key(user, request))
    if not ok:
        raise HTTPException(400, "No active cast session")
    return {"status": "playing"}


@router.post("/pause")
async def pause(request: Request, user: dict = Depends(auth.get_current_user)):
    ok = await dlna.pause(_session_key(user, request))
    if not ok:
        raise HTTPException(400, "No active cast session")
    return {"status": "paused"}


@router.post("/stop")
async def stop(request: Request, user: dict = Depends(auth.get_current_user)):
    ok = await dlna.stop(_session_key(user, request))
    if not ok:
        raise HTTPException(400, "No active cast session")
    return {"status": "stopped"}


@router.post("/seek")
async def seek(req: SeekRequest, request: Request, user: dict = Depends(auth.get_current_user)):
    ok = await dlna.seek(_session_key(user, request), req.position_seconds)
    if not ok:
        raise HTTPException(400, "Seek failed")
    return {"status": "ok"}


@router.post("/volume")
async def set_volume(req: VolumeRequest, request: Request, user: dict = Depends(auth.get_current_user)):
    ok = await dlna.set_volume(_session_key(user, request), req.volume)
    if not ok:
        raise HTTPException(400, "Volume change failed")
    return {"status": "ok", "volume": req.volume}


@router.get("/status")
async def get_status(request: Request, user: dict = Depends(auth.get_current_user)):
    status = await dlna.get_status(_session_key(user, request))
    if not status:
        return {"active": False}
    return {"active": True, **status}
