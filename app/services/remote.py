import asyncio
import collections
import itertools
import math
import re
import secrets
import time

from app.services import auth

# In-memory, single-process broker for device→device remote control.
# Consistent with the in-memory DLNA session state — the app runs as one
# uvicorn worker in one container.
#
# A DEVICE is one `ms_device_id` (localStorage), so every tab of one browser
# profile shares it. A TAB is one `tab_id` (sessionStorage). Commands go to ONE
# tab of the device (`_delivery_order`), never to all of them: two tabs that both
# applied a transfer played the same queue twice, out of phase (review B3).

TAB_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
DEFAULT_TAB = "default"            # what an old client without a tab id is

_CMD_QUEUE_MAX = 256          # pending commands per connection if a consumer stalls
_MAX_QUEUES_PER_DEVICE = 8    # cap concurrent SSE connections per device
MAX_LISTENING_DEVICES = 32    # distinct devices with an open stream, per user
MAX_STATE_DEVICES = 16        # devices with a remembered state, per user
MAX_STATE_TABS = 8            # tabs with a remembered state, per device
_STATE_TTL = 3600.0           # evict tab states not refreshed within this window
_SWEEP_EVERY = 60.0           # how often idle users' leftovers are swept
COMMAND_MAX_AGE = 5.0         # a command that waited longer than this is dropped
PING_INTERVAL = 10.0          # SSE keep-alive (clients report on it), token re-check
STR_CAP = 300                 # every string in a reported state is cut to this
# A tab silent longer than this ranks below every fresh one. Generous: a hidden
# tab's timers are throttled to ~1/min, but it still answers a ping (a network
# event) with a report, so a live tab is heard at least every PING_INTERVAL.
FRESH_FOR = 35.0

# Command ids restart at 1 with the process; the epoch tells a target's ack of
# "5" from before a restart apart from the new "5". Sent with every command and
# in the /command answer; the target reports ack as "<epoch>:<id>".
EPOCH = secrets.token_hex(4)
_ACK_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}:\d{1,15}$')

_seq = itertools.count(1)     # connection age: a higher number is a newer connection
_cmd_ids: dict[str, int] = {}  # {username: last command id}
_last_sweep = 0.0


class Conn:
    """One open SSE connection.

    Commands wait in `cmds`; a `devices` update is only a flag (`devices_dirty`)
    and the snapshot is built when it is SENT, so a stalled reader holds at most
    one pending snapshot instead of 256 of them (review R3 M2). `wake` is set by
    anything the reader should look at. `closed` is set when the broker drops the
    connection (evicted past the cap, or replaced by a reconnect of the same tab);
    the generator then ends, so the client sees the stream close and reconnects.
    Popping only the queue left a deaf connection that kept pinging (B13)."""

    __slots__ = ("username", "device_id", "tab_id", "cmds", "devices_dirty",
                 "wake", "closed", "seq", "opened_at")

    def __init__(self, username: str, device_id: str, tab_id: str):
        self.username = username
        self.device_id = device_id
        self.tab_id = tab_id
        self.cmds: collections.deque = collections.deque()
        self.devices_dirty = False
        self.wake = asyncio.Event()
        self.closed = asyncio.Event()
        self.seq = next(_seq)
        self.opened_at = time.time()

    def close(self):
        self.closed.set()
        self.wake.set()


# {username: {device_id: [Conn, ...]}}
_listeners: dict[str, dict[str, list[Conn]]] = {}
# {username: {device_id: {tab_id: state_dict}}} — state_dict is already sanitised
# and carries `updated_at`, plus the private `_playing_since` / `_played_at`.
_states: dict[str, dict[str, dict[str, dict]]] = {}


def norm_tab(tab_id) -> str:
    return tab_id if isinstance(tab_id, str) and TAB_ID_RE.match(tab_id) else DEFAULT_TAB


# ── connections ──

def may_register(username: str, device_id: str) -> bool:
    """A new device may open a stream only while the user has fewer than
    MAX_LISTENING_DEVICES devices online: every one of them is in every snapshot."""
    devices = _listeners.get(username, {})
    return device_id in devices or len(devices) < MAX_LISTENING_DEVICES


def register_listener(username: str, device_id: str, tab_id: str = DEFAULT_TAB) -> Conn:
    tab_id = norm_tab(tab_id)
    conn = Conn(username, device_id, tab_id)
    conns = _listeners.setdefault(username, {}).setdefault(device_id, [])
    # A reconnect of the same tab replaces its old connection: the old one is
    # usually a half-open TCP the browser already gave up on. Its pending
    # commands (already answered 202) move to the new connection.
    for old in [c for c in conns if c.tab_id == tab_id]:
        conns.remove(old)
        conn.cmds.extend(old.cmds)
        old.cmds.clear()
        old.close()
    # Past the cap, the oldest connection is closed, not just forgotten.
    while len(conns) >= _MAX_QUEUES_PER_DEVICE:
        conns.pop(0).close()
    conns.append(conn)
    _broadcast_devices(username)
    return conn


def unregister_listener(conn: Conn):
    conn.close()
    user_listeners = _listeners.get(conn.username)
    if not user_listeners:
        return
    conns = user_listeners.get(conn.device_id)
    if not conns or conn not in conns:
        return          # already evicted/replaced; whoever did that broadcast
    conns.remove(conn)
    if not conns:
        user_listeners.pop(conn.device_id, None)
    if not user_listeners:
        _listeners.pop(conn.username, None)
    _broadcast_devices(conn.username)


def is_online(username: str, device_id: str) -> bool:
    return bool(_listeners.get(username, {}).get(device_id))


def _push_command(conn: Conn, cmd: dict) -> bool:
    if len(conn.cmds) >= _CMD_QUEUE_MAX:
        return False
    conn.cmds.append(cmd)
    conn.wake.set()
    return True


def token_still_valid(token: str, username: str, device_id: str) -> bool:
    """The SSE connection outlives its request; re-check what the request checked.
    Only a remote token (aud=remote) bound to THIS device; `_decode_token`
    returns None once `exp` has passed."""
    payload = auth._decode_token(token)
    if (not payload or payload.get("aud") != "remote"
            or payload.get("sub") != username or payload.get("dev") != device_id):
        return False
    return username in auth._load_users()


async def listen(conn: Conn, token: str, ping_interval: float = PING_INTERVAL):
    """Yield `(event, data)` for one connection until it is closed, the token
    expires or the user is deleted. Always unregisters on the way out."""
    try:
        conn.devices_dirty = False
        yield "devices", devices_event(conn.username)
        next_check = time.monotonic() + ping_interval
        while True:
            if not (conn.cmds or conn.devices_dirty or conn.closed.is_set()):
                try:
                    await asyncio.wait_for(conn.wake.wait(),
                                           timeout=max(0.0, next_check - time.monotonic()))
                except asyncio.TimeoutError:
                    pass
            conn.wake.clear()
            # Commands first, and before looking at `closed`: one already taken
            # off the queue must not be dropped after its sender got a 202 (R3 L4).
            while conn.cmds:
                cmd = conn.cmds.popleft()
                # A command that sat in the queue (a frozen tab, a stalled proxy) is
                # stale by the time it would arrive; replaying a burst of them on wake
                # skipped several tracks at once (B20).
                if time.time() - cmd.get("ts", 0) > COMMAND_MAX_AGE:
                    continue
                yield "command", cmd
            if conn.closed.is_set():
                return
            if conn.devices_dirty:
                conn.devices_dirty = False
                yield "devices", devices_event(conn.username)
            # Re-check by the clock, not on idle timeouts only: with state reports
            # arriving every 3 s the wait never times out, and the check would never run.
            if time.monotonic() >= next_check:
                if not token_still_valid(token, conn.username, conn.device_id):
                    return
                yield "ping", {"server_time": time.time()}
                next_check = time.monotonic() + ping_interval
    finally:
        unregister_listener(conn)


# ── state ──

_TRACK_KEYS = ("name", "artist", "album", "image", "duration_ms", "id")
_DJ_KEYS = ("smart_queue", "tempo_pref", "fade_beats", "transition_style",
            "energy_weight", "energy_dir")
_REPEAT = ("off", "all", "one")
_ENGINES = ("v3", "classic")


def is_finite_number(v) -> bool:
    """A real int/float that fits a float. `math.isfinite` on a 400-digit int
    raises OverflowError, which was a 500 (R3 L1)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    try:
        return math.isfinite(v)
    except OverflowError:
        return False


def _num(v, default=0.0, lo=None, hi=None) -> float:
    if not is_finite_number(v):
        return default
    v = float(v)
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def _int(v, default=0, lo=None) -> int:
    if not is_finite_number(v):
        return default
    v = int(v)
    return v if lo is None else max(lo, v)


def _bool(v, default=False) -> bool:
    return v if isinstance(v, bool) else default


def _str(v, default=None):
    return v[:STR_CAP] if isinstance(v, str) else default


def _scalar(v):
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return v if is_finite_number(v) else None
    return _str(v)


def _track(v):
    if not isinstance(v, dict):
        return None
    out = {}
    for k in _TRACK_KEYS:
        if k not in v:
            continue
        x = v[k]
        out[k] = _num(x, 0.0) if k == "duration_ms" else _scalar(x)
    return out


def sanitize_state(raw: dict) -> dict:
    """Whitelist and cap one state report (B23). Unknown keys are dropped, wrong
    types fall back to defaults, every string is at most STR_CAP characters. An
    old client's body (playing/position/volume/track) passes through unchanged."""
    dj = raw.get("dj")
    controlling = raw.get("controlling")
    return {
        "playing": _bool(raw.get("playing")),
        "position_seconds": _num(raw.get("position_seconds"), 0.0, lo=0.0),
        "duration": _num(raw.get("duration"), 0.0, lo=0.0),
        "volume": _num(raw.get("volume"), 1.0, lo=0.0, hi=1.0),
        "muted": _bool(raw.get("muted")),
        "shuffle": _bool(raw.get("shuffle")),
        "repeat": raw.get("repeat") if raw.get("repeat") in _REPEAT else "off",
        "index": _int(raw.get("index"), -1, lo=-1),
        "queue_len": _int(raw.get("queue_len"), 0, lo=0),
        "queue_rev": _int(raw.get("queue_rev"), 0, lo=0),
        "track": _track(raw.get("track")),
        "next": _track(raw.get("next")),
        "engine": raw.get("engine") if raw.get("engine") in _ENGINES else None,
        "dj": {k: _scalar(dj.get(k)) for k in _DJ_KEYS if k in dj} if isinstance(dj, dict) else None,
        "controlling": controlling if isinstance(controlling, str) and TAB_ID_RE.match(controlling) else None,
        "blocked": _bool(raw.get("blocked")),
        "casting": _str(raw.get("casting")),
        "radio": _bool(raw.get("radio")),
        "ack": _ack(raw.get("ack")),
    }


def _ack(v):
    """"<epoch>:<id>" from a current client, a bare int from an older one."""
    if isinstance(v, str):
        return v if _ACK_RE.fullmatch(v) else 0
    return _int(v, 0, lo=0)


STATE_FIELDS = tuple(sanitize_state({}).keys())


def update_state(username: str, device_id: str, state: dict, tab_id: str = DEFAULT_TAB):
    """`state` must already be sanitised (`sanitize_state`)."""
    tab_id = norm_tab(tab_id)
    now = time.time()
    _sweep(now)
    user_states = _states.setdefault(username, {})
    _evict_stale(user_states, now)
    tabs = user_states.setdefault(device_id, {})
    prev = tabs.get(tab_id, {})
    state = dict(state)
    state["updated_at"] = now
    if state.get("playing"):
        # When this tab STARTED playing, so two tabs that both play do not swap
        # places on every report; and the last time it played at all.
        state["_playing_since"] = prev.get("_playing_since") if prev.get("playing") else now
        state["_played_at"] = now
    else:
        state["_playing_since"] = 0.0
        state["_played_at"] = prev.get("_played_at", 0.0)
    tabs[tab_id] = state
    # Bounded per user and per device (R3 M2): every new X-Device-ID / tab_id
    # used to add an entry for an hour. The least recently updated one goes.
    while len(tabs) > MAX_STATE_TABS:
        tabs.pop(min(tabs, key=lambda t: tabs[t].get("updated_at", 0.0)))
    while len(user_states) > MAX_STATE_DEVICES:
        user_states.pop(min(user_states, key=lambda d: _last_update(user_states[d])))
    _broadcast_devices(username)


def _last_update(tabs: dict) -> float:
    return max((s.get("updated_at", 0.0) for s in tabs.values()), default=0.0)


def _evict_stale(user_states: dict, now: float):
    """Drop tab states not refreshed within _STATE_TTL, and devices left empty."""
    for did in list(user_states):
        tabs = user_states[did]
        for tid in [t for t, s in tabs.items() if now - s.get("updated_at", 0.0) > _STATE_TTL]:
            tabs.pop(tid, None)
        if not tabs:
            user_states.pop(did, None)


def _sweep(now: float):
    """Users who stopped reporting (logged out, deleted) are otherwise only
    cleaned up by their own next report (R3 L5). At most once a minute."""
    global _last_sweep
    if now - _last_sweep < _SWEEP_EVERY:
        return
    _last_sweep = now
    for user in list(_states):
        _evict_stale(_states[user], now)
        if not _states[user]:
            _states.pop(user, None)
    for user in [u for u in _cmd_ids if u not in _states and u not in _listeners]:
        _cmd_ids.pop(user, None)


def _tab_rank(conn: Conn, tabs: dict, now: float):
    s = tabs.get(conn.tab_id)
    # Heard from within FRESH_FOR: a report, or the connection itself just opened.
    # A frozen mobile tab keeps its old "playing" report and would otherwise take
    # every command into a queue nobody reads.
    fresh = now - max(s.get("updated_at", 0.0) if s else 0.0, conn.opened_at) <= FRESH_FOR
    if not s:
        return (fresh, False, 0.0, conn.seq)
    if s.get("playing"):
        return (fresh, True, s.get("_playing_since", 0.0), conn.seq)
    return (fresh, False, s.get("_played_at", 0.0), conn.seq)


def _delivery_order(username: str, device_id: str) -> list[Conn]:
    """Open connections of the device, the one to address first. A tab heard from
    in the last FRESH_FOR seconds beats a silent one; then a tab that is playing
    beats one that is not (the most recently started first); then the tab that
    played last; then the newest connection."""
    conns = _listeners.get(username, {}).get(device_id, [])
    tabs = _states.get(username, {}).get(device_id, {})
    now = time.time()
    return sorted(conns, key=lambda c: _tab_rank(c, tabs, now), reverse=True)


def device_state(username: str, device_id: str) -> dict | None:
    """The state the device is represented by: that of the tab commands go to,
    else the most recently reported one. One tab, so the controller's view does
    not flip between two tabs' reports."""
    tabs = _states.get(username, {}).get(device_id, {})
    if not tabs:
        return None
    for conn in _delivery_order(username, device_id):
        if conn.tab_id in tabs:
            return tabs[conn.tab_id]
    return max(tabs.values(), key=lambda s: s.get("updated_at", 0.0))


def send_command(username: str, device_id: str, action: str, value=None,
                 from_device: str = "") -> dict | None:
    """Queue a command for ONE tab of the device. Returns the command, or None
    when no connection could take it."""
    cmd_id = _cmd_ids.get(username, 0) + 1
    cmd = {"id": cmd_id, "epoch": EPOCH, "action": action, "value": value,
           "ts": time.time(), "from": from_device}
    for conn in _delivery_order(username, device_id):
        if _push_command(conn, cmd):
            _cmd_ids[username] = cmd_id
            return cmd
        # A full queue means its reader stopped long ago; drop that connection
        # and try the next tab rather than losing the command.
        unregister_listener(conn)
    return None


def _broadcast_devices(username: str):
    """Mark every connection of the user as owing a `devices` event; each builds
    the snapshot when it sends (`listen`), so updates coalesce."""
    for conns in _listeners.get(username, {}).values():
        for conn in conns:
            conn.devices_dirty = True
            conn.wake.set()


def devices_event(username: str) -> dict:
    return {"devices": snapshot(username), "server_time": time.time()}


def snapshot(username: str) -> dict:
    registered = auth.get_user_devices(username)
    device_ids = set(registered.keys())
    device_ids |= set(_states.get(username, {}).keys())
    device_ids |= set(_listeners.get(username, {}).keys())

    now = time.time()
    defaults = sanitize_state({})
    result: dict = {}
    for device_id in device_ids:
        state = device_state(username, device_id) or {}
        entry = {k: state.get(k, defaults[k]) for k in STATE_FIELDS}
        entry.update({
            "name": registered.get(device_id, {}).get("name", ""),
            "online": is_online(username, device_id),
            "updated_at": state.get("updated_at", 0.0),
            "server_time": now,
        })
        result[device_id] = entry
    return result


def _reset_for_tests():
    global _last_sweep
    _last_sweep = 0.0
    _listeners.clear()
    _states.clear()
    _cmd_ids.clear()
