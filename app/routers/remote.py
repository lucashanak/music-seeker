import asyncio
import json
import re
import uuid
import weakref
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

from app.services import auth, player, remote
from app.dependencies import _get_device_id, _DEVICE_ID_RE, bind_navidrome_creds

router = APIRouter(prefix="/api/remote", tags=["remote"])

_ACTIONS = {"play", "pause", "toggle", "next", "prev", "seek", "volume", "mute",
            "shuffle", "repeat", "transfer", "enqueue", "queue_op", "energy_dir"}
_NO_VALUE = {"play", "pause", "toggle", "next", "prev"}
_ENERGY_DIRS = {"auto", "up", "hold", "down"}
_REPEAT = {"off", "all", "one"}
_QUEUE_OPS = {"play_now", "insert_next", "move_next", "remove", "move", "clear", "jump"}
_MAX_ITEMS = 200            # enqueue / play_now / insert_next
_MAX_QUEUE = 5000           # a transferred queue
# Temporary playlists a transfer must not hand from one device to another: the
# target would then mirror into (and Clear would wipe) the controller's Up Next.
_TEMP_NAMES = {"Up Next", "Radio"}
_TEMP_PREFIXES = ("__upnext_", "__radio_")
_PLAYLIST_ID_RE = re.compile(r'^[A-Za-z0-9_.-]{1,128}$')
# Queue items: any key of this shape, at most _ITEM_MAX_KEYS of them, scalar values
# (or a short flat list of scalars). Not a fixed key list: items carry
# provider-specific fields (mixes: url, uploader, source_label …) the target needs.
_ITEM_KEY_RE = re.compile(r'^[A-Za-z0-9_]{1,64}$')
_ITEM_MAX_KEYS = 40
_ITEM_STR_CAP = 1000          # URLs (image, source page) are longer than STR_CAP
_ITEM_LIST_CAP = 20


class RemoteCommandRequest(BaseModel):
    target_device_id: str
    action: str
    value: Any = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("/token")
async def get_remote_token(device_id: str = "", user: dict = Depends(auth.get_current_user)):
    """Token for `/events` of ONE device: aud=remote, dev=device_id, 1 h. Not the
    stream token — that one sits in every <audio> URL, nginx log and DLNA renderer."""
    if not _DEVICE_ID_RE.match(device_id):
        raise HTTPException(400, "Invalid device ID")
    return {"token": auth.create_remote_token(user["username"], device_id),
            "expires_in": auth.REMOTE_TOKEN_EXPIRY}


@router.get("/events")
async def remote_events(token: str = "", device_id: str = "", tab_id: str = ""):
    """SSE stream — EventSource cannot send headers, so auth via query-param token."""
    if not _DEVICE_ID_RE.match(device_id):
        raise HTTPException(400, "Invalid device ID")
    payload = auth._decode_token(token)
    # Only a remote token for THIS device — never a session token in a URL, never a
    # stream token (R3 M3).
    if not payload or payload.get("aud") != "remote" or payload.get("dev") != device_id:
        raise HTTPException(401, "Invalid token")
    users = auth._load_users()
    if payload["sub"] not in users:
        raise HTTPException(401, "User no longer exists")
    username = payload["sub"]
    # Missing tab id = an old client during a deploy; a malformed one is refused.
    if tab_id and not remote.TAB_ID_RE.match(tab_id):
        raise HTTPException(400, "Invalid tab ID")
    if not remote.may_register(username, device_id):
        raise HTTPException(429, "Too many devices online")

    async def event_gen():
        conn = remote.register_listener(username, device_id, tab_id or remote.DEFAULT_TAB)
        async for event, data in remote.listen(conn, token):
            yield _sse(event, data)

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
    return remote.devices_event(user["username"])


@router.get("/queue")
async def get_remote_queue(device: str = "", user: dict = Depends(bind_navidrome_creds)):
    """The saved queue of another device of the SAME user, for the controller's
    queue panel (B4). Never the volume — that stays the target's business."""
    if not _DEVICE_ID_RE.match(device):
        raise HTTPException(400, "Invalid device ID")
    data = player.load_queue(user["username"], device, fallback=False)
    return {
        "queue": data.get("queue") or [],
        "current_index": data.get("current_index", -1),
        "shuffle_order": data.get("shuffle_order"),
        "playlist_mode": data.get("playlist_mode"),
        "radio_mode": bool(data.get("radio_mode", False)),
        "radio_seed": data.get("radio_seed"),
    }


# ── payload validation ──

def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


_is_num = remote.is_finite_number


def _item_value(v):
    if v is None or isinstance(v, bool):
        return v, True
    if isinstance(v, (int, float)):
        return (v, True) if _is_num(v) else (None, False)
    if isinstance(v, str):
        return v[:_ITEM_STR_CAP], True
    if isinstance(v, list):
        out = [x for x in (_item_value(y) for y in v[:_ITEM_LIST_CAP])
               if x[1] and not isinstance(x[0], list)]
        return [x[0] for x in out], True
    return None, False          # nested objects are dropped


def sanitize_item(item: dict) -> dict:
    """One queue item, bounded (R3 L2): known-shaped keys, scalar values, strings
    cut. Nothing nested — the engine reads flat fields."""
    out = {}
    for k, v in item.items():
        if len(out) >= _ITEM_MAX_KEYS:
            break
        if not isinstance(k, str) or not _ITEM_KEY_RE.match(k):
            continue
        val, ok = _item_value(v)
        if ok:
            out[k] = val
    return out


def _items(v, cap: int) -> list[dict]:
    if not isinstance(v, list) or not all(isinstance(x, dict) for x in v):
        raise HTTPException(400, "items must be a list of objects")
    return [sanitize_item(x) for x in v[:cap]]


def _cap_str(v) -> str:
    if v is None:
        return ""
    if not isinstance(v, str):
        raise HTTPException(400, "name/artist must be strings")
    return v[:remote.STR_CAP]


def _index(v, field: str) -> int:
    if not _is_int(v) or v < 0:
        raise HTTPException(400, f"{field} must be a non-negative integer")
    return v


def _queue_op(v) -> dict:
    if not isinstance(v, dict) or v.get("op") not in _QUEUE_OPS:
        raise HTTPException(400, "Invalid queue_op")
    op = v["op"]
    if op in ("play_now", "insert_next"):
        return {"op": op, "items": _items(v.get("items"), _MAX_ITEMS)}
    if op == "clear":
        return {"op": op}
    out = {"op": op, "name": _cap_str(v.get("name")), "artist": _cap_str(v.get("artist"))}
    if op == "move":
        out["from"] = _index(v.get("from"), "from")
        out["to"] = _index(v.get("to"), "to")
    else:                       # move_next, remove, jump
        out["index"] = _index(v.get("index"), "index")
    return out


def _command_value(action: str, v):
    if action in _NO_VALUE or action == "transfer":
        return None
    if action == "seek":
        if not _is_num(v) or v < 0:
            raise HTTPException(400, "seek needs a number of seconds >= 0")
        return float(v)
    if action == "volume":
        if not _is_num(v):
            raise HTTPException(400, "Numeric value required")
        return min(1.0, max(0.0, float(v)))
    if action in ("mute", "shuffle"):
        if not isinstance(v, bool):
            raise HTTPException(400, f"{action} needs true/false")
        return v
    if action == "repeat":
        if v not in _REPEAT:
            raise HTTPException(400, "repeat must be off/all/one")
        return v
    if action == "energy_dir":
        if v not in _ENERGY_DIRS:
            raise HTTPException(400, "energy_dir must be auto/up/hold/down")
        return v
    if action == "enqueue":
        return _items(v, _MAX_ITEMS)
    if action == "queue_op":
        return _queue_op(v)
    raise HTTPException(400, "Invalid action")


def _is_temp_playlist(mode) -> bool:
    if not isinstance(mode, dict):
        return True             # no playlist at all — nothing to adopt
    name = mode.get("name")
    pid = mode.get("id")
    if not isinstance(name, str) or not name:
        return True
    if name in _TEMP_NAMES or name.startswith(_TEMP_PREFIXES):
        return True
    return isinstance(pid, str) and pid.startswith(_TEMP_PREFIXES)


def _transfer_fields(src) -> dict:
    """The part of a queue that travels with a transfer, validated. Everything
    here belongs to the new queue and replaces the target's (an old shuffle order
    or radio seed would refer to a queue that is gone); everything else in the
    target's file — volume above all — stays."""
    if not isinstance(src, dict):
        raise HTTPException(400, "transfer value must be an object")
    queue = src.get("queue")
    if not isinstance(queue, list) or not all(isinstance(x, dict) for x in queue):
        raise HTTPException(400, "transfer queue must be a list of objects")
    if len(queue) > _MAX_QUEUE:
        raise HTTPException(400, f"transfer queue is longer than {_MAX_QUEUE}")
    if not queue:
        raise HTTPException(400, "Nothing to transfer")
    queue = [sanitize_item(x) for x in queue]
    idx = src.get("current_index", 0 if queue else -1)
    if not _is_int(idx):
        raise HTTPException(400, "current_index must be an integer")
    idx = min(max(idx, 0), len(queue) - 1) if queue else -1
    pos = src.get("position_seconds", 0.0)
    if pos is None:
        pos = 0.0
    if not _is_num(pos):
        raise HTTPException(400, "position_seconds must be a number")
    order = _shuffle_order(src.get("shuffle_order"), len(queue))
    radio_mode = src.get("radio_mode", False)
    if not isinstance(radio_mode, bool):
        raise HTTPException(400, "radio_mode must be true/false")
    seed = src.get("radio_seed")
    if seed is not None and not isinstance(seed, dict):
        raise HTTPException(400, "radio_seed must be an object")
    mode = src.get("playlist_mode")
    if mode is not None:
        if not isinstance(mode, dict):
            raise HTTPException(400, "playlist_mode must be an object")
        pid, name = mode.get("id"), mode.get("name")
        if not isinstance(pid, str) or not _PLAYLIST_ID_RE.match(pid):
            raise HTTPException(400, "playlist_mode.id is not a playlist id")
        if not isinstance(name, str):
            raise HTTPException(400, "playlist_mode.name must be a string")
        mode = {"id": pid, "name": name[:remote.STR_CAP]}
    return {
        "fields": {
            "queue": queue,
            "current_index": idx,
            "position_seconds": max(0.0, float(pos)),
            "shuffle_order": order,
            "radio_mode": radio_mode,
            "radio_seed": sanitize_item(seed) if radio_mode and seed else None,
        },
        "playlist_mode": mode,
    }


def _shuffle_order(order, n: int):
    """Only `played`/`tail`, each a list of queue positions; positions outside
    the queue and repeats are dropped (the client drops them too)."""
    if order is None:
        return None
    if not isinstance(order, dict):
        raise HTTPException(400, "shuffle_order must be an object")
    out, seen = {}, set()
    for key in ("played", "tail"):
        lst = order.get(key, [])
        if not isinstance(lst, list) or not all(_is_int(i) for i in lst):
            raise HTTPException(400, f"shuffle_order.{key} must be a list of integers")
        out[key] = []
        for i in lst:
            if 0 <= i < n and i not in seen:
                seen.add(i)
                out[key].append(i)
    return out


def merge_transfer(target_saved: dict, src: dict) -> dict:
    t = _transfer_fields(src)
    merged = dict(target_saved)
    merged.update(t["fields"])
    mode = t["playlist_mode"]
    if not _is_temp_playlist(mode):
        merged["playlist_mode"] = {"id": mode.get("id"), "name": mode.get("name")}
    elif not _is_temp_playlist(merged.get("playlist_mode")):
        # The target's own NAMED playlist is no longer what it plays; keeping it
        # would mirror the new queue into that playlist. Its Up Next is kept.
        merged["playlist_mode"] = None
    return merged


TRANSFER_KEYS = ("transfer_id", "queue", "current_index", "position_seconds",
                 "shuffle_order", "playlist_mode", "radio_mode", "radio_seed")


def _apply_transfer(username: str, controller_id: str, target_id: str, value) -> dict:
    """Merge into the target's file and return what the target must apply. The
    target applies the COMMAND's value: reading the file back raced its own
    debounced save of the old queue. The file is the durable copy; `transfer_id`
    is in both, so either side can tell which transfer a file holds."""
    # An old client sends no value: merge the controller's saved file instead
    # (still a merge, never a copy of the whole file).
    src = value if value is not None else player.load_queue(username, controller_id)
    saved = player.load_queue(username, target_id, fallback=False)
    merged = merge_transfer(saved, src)
    merged["transfer_id"] = uuid.uuid4().hex
    player.save_queue(username, merged, target_id)
    return {k: merged.get(k) for k in TRANSFER_KEYS}


# {(username, target device): Lock} — weak, so idle targets cost nothing.
_target_locks: "weakref.WeakValueDictionary[tuple, asyncio.Lock]" = weakref.WeakValueDictionary()


def _target_lock(username: str, device_id: str) -> asyncio.Lock:
    key = (username, device_id)
    lock = _target_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _target_locks[key] = lock
    return lock


@router.post("/command")
async def send_command(req: RemoteCommandRequest, request: Request, user: dict = Depends(bind_navidrome_creds)):
    username = user["username"]
    controller_id = _get_device_id(request)
    if req.action not in _ACTIONS:
        raise HTTPException(400, "Invalid action")
    if not _DEVICE_ID_RE.match(req.target_device_id):
        raise HTTPException(400, "Invalid device ID")
    value = _command_value(req.action, req.value)
    if req.action == "transfer" and req.value is not None:
        _transfer_fields(req.value)      # garbage → 400 before anything else

    # Gate on liveness BEFORE any side effect, so an offline target never has its
    # persisted queue clobbered by a transfer that then returns 404.
    # A device reconnecting right now (its stream dropped seconds ago) counts as
    # live: its commands wait for the reconnect (remote.RECONNECT_GRACE). Not a
    # transfer: it would merge into the file of a tab that may never apply it.
    may_wait = req.action != "transfer"
    if not (remote.is_online(username, req.target_device_id)
            or (may_wait and remote.reconnecting(username, req.target_device_id))):
        raise HTTPException(404, "Device offline")
    # A target that is itself controlling would relay the command onwards; two
    # devices controlling each other ping-ponged a transfer forever (B2).
    target_state = remote.device_state(username, req.target_device_id)
    if target_state and target_state.get("controlling"):
        raise HTTPException(409, "Device is controlling another device")

    # One command at a time per target, in the order they arrived: two transfers
    # ran load→merge→save in two threads and the older one could land last, in the
    # file and in the target's queue of commands.
    async with _target_lock(username, req.target_device_id):
        if req.action == "transfer":
            # File I/O and up to 5000 items off the event loop (R3 L3).
            value = await asyncio.to_thread(_apply_transfer, username, controller_id,
                                            req.target_device_id, req.value)
        cmd = remote.send_command(username, req.target_device_id, req.action, value,
                                  from_device=controller_id, may_wait=may_wait)
        queued = bool(cmd and cmd.get("queued"))
    if not cmd:
        if may_wait and remote.reconnecting(username, req.target_device_id):
            raise HTTPException(503, "Device is reconnecting; too many commands waiting")
        raise HTTPException(404, "Device offline")
    return JSONResponse(status_code=202, content={"ok": True, "status": "sent", "id": cmd["id"],
                                                 "epoch": cmd["epoch"], "queued": queued})


@router.post("/state")
async def update_state(request: Request, body: Any = Body(...), user: dict = Depends(bind_navidrome_creds)):
    if not isinstance(body, dict):
        raise HTTPException(400, "state must be an object")
    device_id = _get_device_id(request)
    remote.update_state(user["username"], device_id, remote.sanitize_state(body),
                        tab_id=remote.norm_tab(body.get("tab_id")))
    return {"status": "ok"}
