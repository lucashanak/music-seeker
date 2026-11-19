from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import JSONResponse
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
    # Where to start on the receiver: the local position when a cast takes over.
    start_seconds: float = 0
    # This item's index in the queue the client saved (PUT /api/player/queue). A cast
    # that carries one is followed by the server, which advances the queue itself.
    queue_index: int = -1
    # What the client would play after this one ({queue_index, name, artist, album,
    # image, duration_ms}) — Smart Queue's pick is known only to the client.
    next: dict | None = None
    repeat: str = "off"
    shuffle: bool = False


class NextHintRequest(BaseModel):
    queue_index: int
    next: dict | None = None
    repeat: str = "off"
    shuffle: bool = False


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
        outcome = await asyncio.wait_for(dlna.cast_with_outcome(
            sk, req.device_id, req.name, req.artist, token,
            album=req.album, image=req.image, duration_ms=req.duration_ms,
            start_seconds=max(0.0, req.start_seconds or 0.0), queue_index=req.queue_index,
            next_item=req.next, repeat=req.repeat, shuffle=req.shuffle,
            username=user["username"], client_device=_get_device_id(request), by="client",
        ), timeout=40)
    except asyncio.TimeoutError:
        outcome = "failed"
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
    if outcome == "superseded":
        # A newer cast (two quick Next taps) or a stop replaced this one: not a failure.
        raise HTTPException(409, {"message": "superseded", "superseded": True, "cause": "superseded"})
    if outcome != "ok":
        raise HTTPException(502, {"message": "Cast failed", "cause": "unknown"})
    return {"status": "casting", "cast_seq": dlna.get_cast_seq(sk),
            "session_id": dlna.get_session_id(sk)}


@router.post("/next-hint")
async def next_hint(req: NextHintRequest, request: Request, user: dict = Depends(auth.get_current_user)):
    """What the client would play after the track it believes is playing. Refused
    (409 stale) when the server has moved on — the client takes the status first."""
    res = await dlna.set_next_hint(_session_key(user, request), req.queue_index, req.next,
                                   repeat=req.repeat, shuffle=req.shuffle)
    if res == "no_session":
        raise HTTPException(400, "No active cast session")
    if res == "stale":
        return JSONResponse(status_code=409, content={"stale": True})
    return {"status": "ok"}


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
    sk = _session_key(user, request)
    status = await dlna.get_status(sk)
    if not status:
        # A session the server gave up on says why — once.
        why = dlna.take_abandoned(sk)
        if why:
            return {"active": False, "abandoned": why}
        if dlna.is_resuming(sk):
            # Back after a restart and still reconnecting: do not end the cast yet.
            return {"active": False, "resuming": True}
        return {"active": False}
    return {"active": True, **status}
