from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from app.services import auth, dlna

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


@router.get("/devices")
async def get_devices(user: dict = Depends(auth.get_current_user)):
    return {"devices": dlna.get_devices()}


@router.post("/cast")
async def cast_to_device(req: CastRequest, user: dict = Depends(auth.get_current_user)):
    # Use the user's token for stream authentication
    token = auth._create_token(user["username"], user.get("admin", False))
    ok = await dlna.cast_to_device(
        req.device_id, req.name, req.artist, token,
        album=req.album, image=req.image, duration_ms=req.duration_ms,
    )
    if not ok:
        raise HTTPException(500, "Failed to cast to device")
    return {"status": "casting"}


@router.post("/play")
async def play(user: dict = Depends(auth.get_current_user)):
    ok = await dlna.play()
    if not ok:
        raise HTTPException(400, "No active cast session")
    return {"status": "playing"}


@router.post("/pause")
async def pause(user: dict = Depends(auth.get_current_user)):
    ok = await dlna.pause()
    if not ok:
        raise HTTPException(400, "No active cast session")
    return {"status": "paused"}


@router.post("/stop")
async def stop(user: dict = Depends(auth.get_current_user)):
    ok = await dlna.stop()
    if not ok:
        raise HTTPException(400, "No active cast session")
    return {"status": "stopped"}


@router.post("/seek")
async def seek(req: SeekRequest, user: dict = Depends(auth.get_current_user)):
    ok = await dlna.seek(req.position_seconds)
    if not ok:
        raise HTTPException(400, "Seek failed")
    return {"status": "ok"}


@router.post("/volume")
async def set_volume(req: VolumeRequest, user: dict = Depends(auth.get_current_user)):
    ok = await dlna.set_volume(req.volume)
    if not ok:
        raise HTTPException(400, "Volume change failed")
    return {"status": "ok", "volume": req.volume}


@router.get("/status")
async def get_status(user: dict = Depends(auth.get_current_user)):
    status = await dlna.get_status()
    if not status:
        return {"active": False}
    return {"active": True, **status}
