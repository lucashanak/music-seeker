import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

from app.services import auth, player, remote
from app.dependencies import _get_device_id, _DEVICE_ID_RE, bind_navidrome_creds

router = APIRouter(prefix="/api/remote", tags=["remote"])

_ACTIONS = {"play", "pause", "next", "prev", "seek", "volume", "transfer", "enqueue"}


class RemoteCommandRequest(BaseModel):
    target_device_id: str
    action: str
    value: Any = None


class RemoteStateRequest(BaseModel):
    playing: bool = False
    position_seconds: float = 0.0
    volume: float = 1.0
    track: dict | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("/events")
async def remote_events(token: str = "", device_id: str = ""):
    """SSE stream — EventSource cannot send headers, so auth via query-param token."""
    payload = auth._decode_token(token)
    # Require a stream-scoped token — never accept the full session token in a URL
    # query string (mirrors get_current_user rejecting aud=="stream" on the flip side).
    if not payload or payload.get("aud") != "stream":
        raise HTTPException(401, "Invalid token")
    users = auth._load_users()
    if payload["sub"] not in users:
        raise HTTPException(401, "User no longer exists")
    username = payload["sub"]
    if not _DEVICE_ID_RE.match(device_id):
        raise HTTPException(400, "Invalid device ID")

    async def event_gen():
        q = remote.register_listener(username, device_id)
        try:
            yield _sse("devices", {"devices": remote.snapshot(username)})
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield _sse(msg["event"], msg["data"])
                except asyncio.TimeoutError:
                    yield _sse("ping", {})
        finally:
            remote.unregister_listener(username, device_id, q)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/devices")
async def get_devices(user: dict = Depends(bind_navidrome_creds)):
    return {"devices": remote.snapshot(user["username"])}


@router.post("/command")
async def send_command(req: RemoteCommandRequest, request: Request, user: dict = Depends(bind_navidrome_creds)):
    controller_id = _get_device_id(request)
    if req.action not in _ACTIONS:
        raise HTTPException(400, "Invalid action")
    if not _DEVICE_ID_RE.match(req.target_device_id):
        raise HTTPException(400, "Invalid device ID")
    # seek/volume carry a numeric payload — reject anything else up front.
    if req.action in ("seek", "volume") and not isinstance(req.value, (int, float)):
        raise HTTPException(400, "Numeric value required")
    if req.action == "enqueue":
        if not isinstance(req.value, list):
            raise HTTPException(400, "enqueue value must be a list")
        req.value = req.value[:200]  # bound fan-out size

    # Gate on liveness BEFORE any side effect, so an offline target never has its
    # persisted queue clobbered by a transfer that then returns 404.
    if not remote.is_online(user["username"], req.target_device_id):
        raise HTTPException(404, "Device offline")

    if req.action == "transfer":
        state = player.load_queue(user["username"], controller_id)
        player.save_queue(user["username"], state, req.target_device_id)
        ok = remote.send_command(user["username"], req.target_device_id, "transfer", None)
    else:
        ok = remote.send_command(user["username"], req.target_device_id, req.action, req.value)

    if not ok:
        raise HTTPException(404, "Device offline")
    return JSONResponse(status_code=202, content={"status": "sent"})


@router.post("/state")
async def update_state(req: RemoteStateRequest, request: Request, user: dict = Depends(bind_navidrome_creds)):
    device_id = _get_device_id(request)
    remote.update_state(user["username"], device_id, {
        "playing": req.playing,
        "position_seconds": req.position_seconds,
        "volume": req.volume,
        "track": req.track,
    })
    return {"status": "ok"}
