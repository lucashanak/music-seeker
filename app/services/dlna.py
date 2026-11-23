"""DLNA/UPnP service: discover renderers on LAN and control playback."""

import asyncio
import re
import html
import ipaddress
import json
import logging
import os
import random
import secrets
import socket
import threading
import time
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

logger = logging.getLogger("musicseeker.dlna")

_MAX_SESSIONS = 50  # bound per-(user,device) cast sessions


def _is_safe_renderer_url(url: str) -> bool:
    """Validate an admin-set renderer URL: http(s) only, no link-local/metadata host.
    Prevents the server being pointed at cloud-metadata or arbitrary internal services."""
    try:
        p = urlparse(url)
        if p.scheme not in ("http", "https") or not p.hostname:
            return False
        try:
            ip = ipaddress.ip_address(p.hostname)
            if (ip.is_link_local or ip.is_multicast or ip.is_reserved
                    or ip.is_unspecified or ip.is_loopback):
                return False  # blocks 169.254.169.254 (metadata), loopback, etc.; LAN privates allowed
        except ValueError:
            pass  # a hostname, not a literal IP — allow (LAN DNS)
        return True
    except Exception:
        return False


# How long the DIDL type may wait for a resolution. A local file or a Navidrome song
# answers in well under a second; what is still unresolved after this is a YouTube
# lookup, and YouTube is always served as MP3.
CAST_MIME_TIMEOUT = 8.0


async def _resolve_cast_mime(name: str, artist: str) -> str:
    """The MIME type for the DIDL protocolInfo — the Content-Type the cast URL
    (`quality=lossless`) will really answer, so a renderer (Onkyo) does not refuse a
    stream whose advertised type does not match. It asks the same functions the stream
    endpoint uses, so the two cannot disagree:

    - local file: served untouched at quality=lossless → its own type;
    - Navidrome: the lossless cache file the endpoint serves (FLAC, or the song's own
      compact format — `player.navidrome_stream_mime`), not "always FLAC" (finding 12);
    - YouTube, unresolved, or a lookup that outlasts CAST_MIME_TIMEOUT: MP3. The old
      fallback was FLAC, which no YouTube stream ever is (finding 13)."""
    from app.services import player
    try:
        res = await asyncio.wait_for(player.resolve_stream(name, artist), timeout=CAST_MIME_TIMEOUT)
    except Exception:
        return "audio/mpeg"
    if not res:
        return "audio/mpeg"
    try:
        if res["source"] == "local":
            return player.mime_for_path(res["path"])
        if res["source"] == "navidrome":
            return player.navidrome_stream_mime(res, lossless=True)
    except Exception:
        return "audio/flac"
    return "audio/mpeg"       # YouTube source is transcoded to MP3


# ── State ──
# Keyed by the renderer's UDN, not by its description URL: a receiver that DHCP moved
# to another address used to leave its old entry behind, and a cast took whichever
# entry came first — the dead address (review finding 14).
_devices: dict[str, dict] = {}  # udn -> {name, ip, location, udn, upnp_device}
_listener_task = None
_requester = None
_factory = None

# Per-session cast state (keyed by "{username}:{client device_id}")
_sessions: dict[str, dict] = {}  # see _get_session for the fields

# Server URL for DLNA renderer to fetch audio from
DLNA_SERVER_URL = os.environ.get("DLNA_SERVER_URL", "")

# Onkyo needs a moment after SetAVTransportURI before it will accept Play, and answers
# 701 until it is ready. Named so a test can shorten it instead of sleeping 10 s.
PLAY_RETRY_DELAYS = (1.0, 1.5, 2.0, 2.5, 3.0)


class CastError(Exception):
    """A cast failure the caller can tell apart. "Cast failed" alone sent the user
    looking for a bug in the app when the renderer was simply in standby."""
    def __init__(self, device: str = ""):
        super().__init__(device)
        self.device = device


class CastUnreachable(CastError):
    """The renderer never answered: powered down, asleep, or off the network."""


class CastRefused(CastError):
    """The renderer answered and said no — Onkyo in standby returns HTTP 501 to every
    AVTransport action, and 701 (Transition not available) when it cannot open media."""


def _get_server_url() -> str:
    if DLNA_SERVER_URL:
        return DLNA_SERVER_URL.rstrip("/")
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return f"http://{ip}:8090"
    except Exception:
        return "http://localhost:8090"


async def _get_factory():
    global _requester, _factory
    if _factory:
        return _factory
    try:
        from async_upnp_client.aiohttp import AiohttpRequester
        from async_upnp_client.client_factory import UpnpFactory
        _requester = AiohttpRequester()
        _factory = UpnpFactory(_requester)
        return _factory
    except ImportError:
        logger.warning("async-upnp-client not installed")
        return None


def _host_of(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""


def _register_device(url: str, upnp_device) -> dict:
    """Remember a renderer found at `url`. One entry per UDN: when the same renderer
    shows up at a new address, the new address replaces the old one. A different
    renderer now answering at an address we knew pushes the old entry out too."""
    udn = getattr(upnp_device, "udn", None) or url
    dev = {
        "name": getattr(upnp_device, "friendly_name", None) or url,
        "location": url,
        "udn": udn,
        "ip": _host_of(url),
        "upnp_device": upnp_device,
    }
    for key, d in list(_devices.items()):
        if key != udn and d.get("location") == url:
            _devices.pop(key, None)
    old = _devices.get(udn)
    if old and old.get("location") != url:
        logger.info(f"DLNA: {dev['name']} moved from {old.get('location')} to {url}")
    _devices[udn] = dev
    return dev


def _device_at(url: str) -> dict | None:
    for d in _devices.values():
        if d.get("location") == url:
            return d
    return None


def _find_device(udn: str) -> dict | None:
    d = _devices.get(udn)
    if d:
        return d
    for d in _devices.values():
        if d.get("udn") == udn:
            return d
    return None


def get_devices() -> list[dict]:
    return [
        {"id": d["udn"], "name": d["name"], "ip": d.get("ip", ""), "location": d["location"]}
        for d in _devices.values()
    ]


async def start_discovery():
    global _listener_task
    if _listener_task:
        return
    from app.services import settings as app_settings
    manual_url = app_settings._settings.get("dlna_renderer_url", "")
    if manual_url:
        # Non-blocking: add the configured renderer immediately so it's usable before
        # the first background sweep completes.
        asyncio.create_task(_add_manual_renderer(manual_url))
    # Always run the periodic LAN scan so renderers appear WITHOUT the user pressing
    # "Scan" first. (SSDP multicast can't cross the Docker bridge network — scan_devices
    # probes the LAN over unicast HTTP instead.)
    _listener_task = asyncio.create_task(_run_discovery())
    logger.info("DLNA discovery started")


async def _add_manual_renderer(url: str):
    if not _is_safe_renderer_url(url):
        logger.warning(f"DLNA: rejected unsafe renderer URL: {url}")
        return
    try:
        factory = await _get_factory()
        if not factory:
            return
        device = await factory.async_create_device(url)
        _register_device(url, device)
        logger.info(f"DLNA: manual renderer added: {device.friendly_name}")
    except Exception as e:
        logger.warning(f"DLNA: failed to add manual renderer {url}: {e}")


async def _run_discovery():
    """Keep the renderer list warm with a periodic LAN HTTP scan, so casting works
    without the user pressing "Scan" first.

    Replaces the old SSDP `async_search` loop, which (a) never worked from the Docker
    bridge network (SSDP multicast doesn't cross it) and (b) broke outright on
    async-upnp-client 0.47 — `async_search` now requires an `async_callback` first arg
    and returns None, so the old `devices_found = await async_search(...)` raised
    `missing 1 required positional argument` every cycle. scan_devices() does the
    actual probing (fast two-phase sweep) and populates `_devices`."""
    try:
        await asyncio.sleep(5)  # let the app finish booting before the first sweep
        seen: list | None = None
        while True:
            try:
                await scan_devices()
                names = sorted(d['name'] for d in _devices.values())
                if names != seen:      # only when the set changes: this runs every 2 minutes
                    seen = names
                    logger.info(f"DLNA: {len(names)} renderer(s): {names}")
            except Exception as e:
                logger.warning(f"DLNA discovery scan error: {e}")
            await asyncio.sleep(120)
    except asyncio.CancelledError:
        pass


async def scan_devices() -> list[dict]:
    """Scan LAN for DLNA renderers by probing common UPnP ports via HTTP.
    Works from Docker bridge networks where SSDP multicast doesn't reach."""
    import httpx

    # Determine subnet to scan from gateway
    gateway_ip = ""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        # Use same /24 subnet
        gateway_ip = ".".join(local_ip.split(".")[:3])
    except Exception:
        pass

    # Also try DLNA_SERVER_URL subnet
    server_url = _get_server_url()
    try:
        server_ip = server_url.split("//")[1].split(":")[0]
        gateway_ip = ".".join(server_ip.split(".")[:3])
    except Exception:
        pass

    if not gateway_ip:
        return []

    # Common UPnP description paths — most common first
    paths = [
        "/description.xml",         # Generic UPnP (most common)
        "/upnp_descriptor_0",      # Onkyo
    ]
    ports = [8888, 49152, 60006, 1400]

    found = []
    factory = await _get_factory()

    # Two-phase scan — fast AND gentle on embedded renderers. A flat HTTP flood over
    # 254 IPs × ports × paths (~2032 GETs) took ~28s at low concurrency; cranked
    # high it made the renderer drop connections (empty results). Instead:
    #   Phase 1 — cheap TCP connect-scan of every IP×port (bare sockets, safe at high
    #             concurrency) to find which ports are actually open.
    #   Phase 2 — HTTP-GET the descriptor paths ONLY on the few open ip:port, with a
    #             generous timeout so a slow renderer still answers.
    # Full sweep is ~1.5s and reliably finds the renderer.
    connect_sem = asyncio.Semaphore(400)

    async def _port_open(ip: str, port: int):
        async with connect_sem:
            try:
                _, writer = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout=0.5)
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass
                return (ip, port)
            except Exception:
                return None

    open_ports = [r for r in await asyncio.gather(*[
        _port_open(f"{gateway_ip}.{i}", port)
        for i in range(1, 255) for port in ports
    ]) if r]

    async with httpx.AsyncClient(timeout=2.0) as client:
        async def probe(ip: str, port: int, path: str):
            try:
                resp = await client.get(f"http://{ip}:{port}{path}")
                if resp.status_code == 200 and "MediaRenderer" in resp.text:
                    return f"http://{ip}:{port}{path}"
            except Exception:
                pass
            return None
        results = await asyncio.gather(*[
            probe(ip, port, path) for (ip, port) in open_ports for path in paths
        ])
    urls = [r for r in results if r]

    # Deduplicate by host
    seen_hosts = set()
    unique_urls = []
    for url in urls:
        host = url.split("//")[1].split("/")[0]
        if host not in seen_hosts:
            seen_hosts.add(host)
            unique_urls.append(url)

    # Fetch device descriptions
    for url in unique_urls:
        known = _device_at(url)
        if known:
            found.append(known)
            continue
        try:
            if factory:
                device = await asyncio.wait_for(factory.async_create_device(url), timeout=5)
                found.append(_register_device(url, device))
        except Exception:
            found.append({"name": url, "location": url, "udn": url, "ip": url.split("//")[1].split(":")[0]})

    return found


# ── Cast sessions ──
#
# While a cast is active the SERVER decides when a track has ended and what plays
# next (review finding 1). A phone page stops its timers when the screen goes off; the
# old client-only end detection then compared a minutes-old position with the
# duration on wake, never saw "near the end", and the queue stood still for good.
# The follower below is one asyncio task per session; everything lives in this one
# process (one uvicorn worker) and active sessions are written to SESSIONS_FILE so a
# container restart picks the follow up again.
#
# Every interval and limit is a module constant so a test can shrink it.

FOLLOW_TICK = 2.0             # seconds between follower samples
FOLLOW_SAMPLE_MAX_AGE = 1.0   # the follower reuses a sample younger than this
STATUS_CACHE_TTL = 1.5        # GET /status answers from a sample younger than this
SOAP_TIMEOUT = 3.0            # one AVTransport/RenderingControl call
VOLUME_EVERY = 5              # GetVolume on every n-th poll only
STALE_SECONDS = 60.0          # no successful sample for this long → the receiver is gone
IDLE_EXPIRE = 30 * 60.0       # not PLAYING for this long → the session ends (no Stop sent)
FOREIGN_SAMPLES = 3           # samples in a row with another track URI → "something else"
LIVE_GAP_MAX = 6.0            # a longer gap between samples is not "watched" time
STALL_RECAST_AFTER = 15.0     # cast, but no PLAYING for this long → send it once more
STALL_SKIP_AFTER = 30.0       # … and for this long → skip the track
DEAD_TRACKS_LIMIT = 2         # tracks in a row that never played → abandon the session
AUTOPLAY_MAX_ITEMS = 20       # the client's autoplay continuation, at most this many tracks
RADIO_BATCH = 25              # tracks asked of the radio service for one refill (as the page asks)
RADIO_TIMEOUT = 20.0          # … and how long the follower waits for them (the page's own limit)
APPEND_WRITE_TRIES = 3        # a queue file that cannot be WRITTEN (disk full): then the queue ends
NEAR_END_MARGIN = 12.0        # a stop this close to the end is the end
NEAR_END_FRACTION = 0.85      # … and so is a stop past this share of the track …
NEAR_END_MAX_WINDOW = 60.0    # … but never further than this from the end (long mixes)
UNKNOWN_DUR_MIN_PLAYED = 30.0  # unknown duration: a stop counts only after this much play
CAST_TIMEOUT = 40.0           # the follower's own cast, end to end
SEEK_TIMEOUT = 10.0
SEEK_RETRY_DELAYS = (0.0, 1.0, 2.0)   # Seek right after Play may meet a renderer still buffering
SEEK_STATE_MAX_AGE = 5.0      # seek() trusts a transport state this fresh
RESUME_CONNECT_TIMEOUT = 10.0
RESUME_END_SLACK = 120.0      # a restart gap longer than the track's rest + this is not an end
PERSIST_POSITION_EVERY = 15.0  # how often a playing position is written for a restart
SESSIONS_FILE = Path(os.environ.get("DATA_DIR", "/app/data")) / "dlna_sessions.json"

_ENDED_STATES = ("STOPPED", "NO_MEDIA_PRESENT")
_PAUSED_STATES = ("PAUSED_PLAYBACK", "PAUSED_RECORDING")
_AVT_URNS = ("urn:schemas-upnp-org:service:AVTransport:2",
             "urn:schemas-upnp-org:service:AVTransport:1")
_RC_URNS = ("urn:schemas-upnp-org:service:RenderingControl:2",
            "urn:schemas-upnp-org:service:RenderingControl:1")

# Why a session ended on its own, handed to the client ONCE by get_status's caller.
_abandoned: dict[str, str] = {}
_UNSET = object()


def _now() -> float:
    """Monotonic clock of the follower — a function so a test can move time."""
    return time.monotonic()


# Plain, and percent-encoded once or twice (a renderer may quote our URL back escaped).
_TOKEN_RE = re.compile(r"token(=|%3[dD]|%253[dD])[^&\s\"'<>%]+")


def _safe(text) -> str:
    """For the log: one line, bounded, and never a stream token (the stream URL the
    renderer is given carries one, and a renderer's error may quote it back)."""
    return _TOKEN_RE.sub(r"token\1…", str(text)).replace("\n", " ")[:300]


def _where(session: dict) -> str:
    """'<track>' at <pos>/<dur> s — what the session was doing, for a log line."""
    track = session.get("track") or {}
    f = session.get("f") or {}
    dur = f.get("renderer_dur") or session.get("duration_seconds") or 0
    return (f"'{_safe(track.get('name', '?'))}' (row {track.get('queue_index', -1)}) at "
            f"{f.get('last_pos', 0):.0f}/{dur:.0f} s")


def _fresh_follow(now: float) -> dict:
    return {
        "reset_at": now,       # samples begun before this belong to the previous track
        "played": False,       # latch: seen PLAYING since the last stop (end detection)
        "started": False,      # latch: this cast ever played — never reset (stall detection)
        "start_pos": 0.0,      # where the cast started (handover position)
        "pending": None,       # generation of an advance that must be tried again
        "resume_pos": None,    # where a stop short of the end left the track (for Play)
        "renderer_dur": 0.0,   # a duration the RENDERER reported for this track
        "our_uri": None,       # how the renderer echoes our stream URL (learned)
        "foreign_n": 0,        # samples in a row naming another track URI
        "foreign_at": None,
        "last_pos": 0.0,       # last reported position …
        "last_pos_at": now,    # … when it was sampled …
        "last_playing": False,  # … and whether the renderer was PLAYING then
        "max_pos": 0.0,
        "play_time": 0.0,      # watched PLAYING time (gaps excluded)
        "prev_at": now,
        "prev_playing": False,
        "wait": 0.0,           # watched time since the cast without PLAYING
        "recast": False,
        "persist_at": now,
    }


def _get_session(session_key: str) -> dict:
    """Get or create a per-device cast session."""
    if session_key not in _sessions:
        # Bound the map — evict the oldest-inserted session if at the cap.
        if len(_sessions) >= _MAX_SESSIONS:
            old_key = next(iter(_sessions))
            _cancel_follower(_sessions.pop(old_key, None))
        _sessions[session_key] = {
            "dmr": None,
            "device": None,
            "lock": asyncio.Lock(),
            "generation": 0,
            "transitioning": False,
            "username": "",
            "client_device": "default",
            "track": None,        # what was cast last: queue_index, name, artist, …, by
            "hint": None,         # the client's "what plays after `track`"
            "hint_used": False,
            # What plays once the saved queue has run out: the page's recommender picks,
            # handed over in advance (the recommender lives only in the page, and a phone
            # page is frozen while the screen is off).
            "autoplay": [],
            # About the playing track, when the follower appended it from that list:
            # the row it followed, and whether the page has since shown it knows the row.
            "autoplay_after": None,
            "autoplay_seen": False,
            # First row of the radio batches the follower appended since the client's
            # last cast: rows from there on are ours, the page has not seen them.
            "radio_from": None,
            "repeat": "off",
            "shuffle": False,
            "cast_seq": 0,
            "duration_seconds": 0,
            "follow": False,
            "follower": None,
            "queue_ended": False,
            "dead_tracks": 0,
            "sample": None,       # last renderer poll
            "poll_task": None,    # the poll in flight (single-flight)
            "poll_n": 0,
            "volume": None,
            "last_pos": 0.0,
            "session_id": secrets.token_hex(8),   # a new session restarts cast_seq at 0
            "last_ok_at": _now(),   # last sample the renderer answered
            "idle_since": None,     # not PLAYING since … (None while playing)
            "queue_ended_at": None,
            "f": _fresh_follow(_now()),
        }
    return _sessions[session_key]


def _cancel_follower(session: dict | None) -> None:
    if not session:
        return
    t = session.get("follower")
    session["follower"] = None
    if t and not t.done():
        try:
            if t is asyncio.current_task():
                return          # the follower ends itself by returning
        except RuntimeError:
            pass
        t.cancel()


def _ensure_follower(session_key: str, session: dict) -> None:
    t = session.get("follower")
    if t and not t.done():
        return
    session["follower"] = asyncio.get_running_loop().create_task(_follow(session_key))


def _same_track(a: dict | None, b: dict | None) -> bool:
    if not a or not b:
        return False
    from app.services.player import nfc
    norm = lambda s: nfc(str(s or "")).strip().casefold()  # noqa: E731
    return norm(a.get("name")) == norm(b.get("name")) and norm(a.get("artist")) == norm(b.get("artist"))


def _norm_repeat(v) -> str:
    return v if v in ("off", "all", "one") else "off"


def _clean_item(item: dict | None) -> dict | None:
    """The fields of a queue item the follower needs, nothing a client could bloat."""
    if not isinstance(item, dict) or not item.get("name"):
        return None
    try:
        qi = int(item.get("queue_index", -1))
    except (TypeError, ValueError):
        qi = -1
    try:
        dur = int(item.get("duration_ms") or 0)
    except (TypeError, ValueError):
        dur = 0
    return {
        "queue_index": qi,
        "name": str(item.get("name") or "")[:500],
        "artist": str(item.get("artist") or "")[:500],
        "album": str(item.get("album") or "")[:500],
        "image": str(item.get("image") or "")[:2000],
        "duration_ms": max(dur, 0),
    }


def _clean_autoplay(items) -> list[dict]:
    """The client's autoplay continuation: queue rows the follower may append once the
    saved queue is over. Bounded, clipped like _clean_item, one entry per track."""
    out: list[dict] = []
    if not isinstance(items, list):
        return out
    for raw in items[:AUTOPLAY_MAX_ITEMS * 3]:      # never walk an unbounded body
        it = _clean_item(raw)
        if not it or any(_same_track(it, o) for o in out):
            continue
        del it["queue_index"]                     # it has no row yet
        rid = raw.get("id")
        if isinstance(rid, (str, int)) and not isinstance(rid, bool) and str(rid):
            it["id"] = str(rid)[:200]
        out.append(it)
        if len(out) >= AUTOPLAY_MAX_ITEMS:
            break
    return out


async def cast_with_outcome(session_key: str, device_id: str, name: str, artist: str, token: str,
                            album: str = "", image: str = "", duration_ms: int = 0, **kw) -> str:
    """Like cast_to_device, but says WHY it did not cast: "ok", "superseded" (a newer
    cast or a stop came in), or "failed"."""
    return await _cast(session_key, device_id, name, artist, token, album, image, duration_ms, **kw)


async def cast_to_device(session_key: str, device_id: str, name: str, artist: str, token: str,
                          album: str = "", image: str = "", duration_ms: int = 0, **kw) -> bool:
    """Send one track to the renderer and play it. True when the renderer took it."""
    return await _cast(session_key, device_id, name, artist, token, album, image,
                       duration_ms, **kw) == "ok"


async def _cast(session_key: str, device_id: str, name: str, artist: str, token: str,
                album: str = "", image: str = "", duration_ms: int = 0, *,
                start_seconds: float = 0.0, queue_index: int = -1,
                next_item=_UNSET, repeat: str | None = None, shuffle: bool | None = None,
                username: str = "", client_device: str = "default",
                by: str = "client", expect_generation: int | None = None,
                recast: bool = False, autoplay=_UNSET, from_autoplay: bool = False,
                kind: str = "") -> str:
    """"ok", "superseded" (another cast or a stop came after it), or "failed".

    `expect_generation` is the follower's guard: its cast goes out only when nothing
    else was cast since it decided to advance. The check and the increment below sit
    with no await between them, so a client cast cannot slip in after the check."""
    if expect_generation is not None:
        existing = _sessions.get(session_key)
        if existing is None or existing["generation"] != expect_generation:
            return "superseded"
    session = _get_session(session_key)

    # The session's own renderer stays castable when discovery has not listed it (yet):
    # after a restart, or a sweep that missed it.
    device = _find_device(device_id) or (
        session["device"] if (session.get("device") or {}).get("udn") == device_id else None)
    if not device:
        return "failed"

    # Increment generation — any older cast in progress will abort
    session["generation"] += 1
    my_gen = session["generation"]
    session["transitioning"] = True

    async with session["lock"]:
        if my_gen != session["generation"]:
            logger.info(f"DLNA: cast '{name}' superseded, skipping")
            return "superseded"

        try:
            from async_upnp_client.profiles.dlna import DmrDevice

            # Reuse DMR for same device, create fresh only if device changed.
            # Use the shared factory/requester (was creating a new AiohttpRequester per
            # cast → leaked an aiohttp ClientSession on every device change).
            if not session["dmr"] or session["device"] != device:
                factory = await _get_factory()
                try:
                    upnp_device = await asyncio.wait_for(
                        factory.async_create_device(device["location"]), timeout=10
                    )
                except (asyncio.TimeoutError, OSError) as e:
                    logger.warning(f"DLNA: [{session_key}] cast of '{_safe(name)}' (by {by}) failed: "
                                   f"{device.get('name') or device['location']} did not answer ({_safe(repr(e))})")
                    raise CastUnreachable(device.get("name") or device["location"]) from e
                session["dmr"] = DmrDevice(upnp_device, None)

            # Our own handle on the renderer. stop() clears session["dmr"], and it can
            # land while this cast sleeps between Play retries — reading the slot there
            # crashed with AttributeError: 'NoneType' object has no attribute 'async_play'
            # and the user saw "Cast failed" for a cast they had just cancelled.
            dmr = session["dmr"]

            if my_gen != session["generation"]:
                session["transitioning"] = False
                return "superseded"

            base = _get_server_url()
            mime = await _resolve_cast_mime(name, artist)
            stream_url = f"{base}/api/player/stream?name={quote(name)}&artist={quote(artist)}&token={quote(token)}&quality=lossless"
            # The renderer fetches the cover itself and has no idea what our host is, so
            # a library cover ("/api/library/cover/...") has to go out absolute.
            art = f"{base}{image}" if image.startswith("/") else image
            metadata = _build_didl_metadata(name, artist, album, art, duration_ms, stream_url, mime)

            # Per UPnP spec: SetAVTransportURI works in any state (including PLAYING)
            # No need to Stop first — the renderer handles the transition internally.
            # The second argument is the TITLE, not the metadata: pass a DIDL document
            # there and async-upnp-client builds a second DIDL around it, so the renderer
            # displays a page of escaped XML as the track name and loses the duration and
            # the cover we just assembled. meta_data takes a str verbatim.
            await asyncio.wait_for(
                dmr.async_set_transport_uri(stream_url, name, metadata), timeout=15
            )

            if my_gen != session["generation"]:
                session["transitioning"] = False
                return "superseded"

            # Retry Play with increasing delays — Onkyo needs time after SetAVTransportURI
            played = False
            for attempt, delay in enumerate(PLAY_RETRY_DELAYS):
                if my_gen != session["generation"]:
                    session["transitioning"] = False
                    return "superseded"
                await asyncio.sleep(delay)
                try:
                    await asyncio.wait_for(dmr.async_play(), timeout=5)
                    played = True
                    break
                except Exception as e:
                    if "701" in str(e) and attempt < len(PLAY_RETRY_DELAYS) - 1:
                        logger.debug(f"DLNA: Play attempt {attempt+1} failed (701), retrying...")
                        continue
                    raise
            if not played:
                raise RuntimeError("Play failed after retries")
            if my_gen != session["generation"]:
                return "superseded"

            # Hand-over of the position (finding 3): a mix playing locally at 45:00 used
            # to restart from 0:00 on the receiver. Seek only once Play has been taken —
            # a STOPPED renderer accepts the Seek and does nothing with it (finding 5).
            if start_seconds and start_seconds >= 1:
                if not await _seek_after_play(dmr, start_seconds, session, my_gen):
                    logger.warning(f"DLNA: [{session_key}] could not seek to {start_seconds:.0f}s")
                if my_gen != session["generation"]:
                    return "superseded"

            session["device"] = device
            session["transitioning"] = False
            _note_cast(session_key, session, by=by, name=name, artist=artist, album=album,
                       image=image, duration_ms=duration_ms, queue_index=queue_index,
                       next_item=next_item, repeat=repeat, shuffle=shuffle,
                       username=username, client_device=client_device,
                       start_seconds=start_seconds, recast=recast,
                       autoplay=autoplay, from_autoplay=from_autoplay, kind=kind)
            # The follower's own advances are logged where they are decided (_advance).
            if by == "client" and expect_generation is None:
                logger.info(f"DLNA: [{session_key}] client cast '{_safe(artist)} - {_safe(name)}' to "
                            f"{device['name']} (row {queue_index}, seq {session['cast_seq']}"
                            f"{', again' if recast else ''}, repeat {session.get('repeat')}, "
                            f"shuffle {bool(session.get('shuffle'))}, "
                            f"list {len(session.get('autoplay') or [])})")
            await _persist()
            return "ok"
        except CastError:
            raise
        except Exception as e:
            import traceback
            logger.error(f"DLNA: [{session_key}] cast of '{_safe(name)}' (by {by}) failed: {_safe(repr(e))}")
            logger.debug(_safe(traceback.format_exc()))
            txt = str(e)
            dev_name = device.get("name") or device["location"]
            # 501 to an AVTransport action and 701 "Transition not available" are what a
            # receiver in standby answers; neither is a fault on our side.
            if "status: 501" in txt or "upnp error: 701" in txt:
                raise CastRefused(dev_name) from e
            if isinstance(e, (asyncio.TimeoutError, OSError)) or "ClientConnectorError" in txt:
                raise CastUnreachable(dev_name) from e
            return "failed"
        finally:
            # Never leave the session wedged in TRANSITIONING (e.g. on task cancellation).
            if session.get("generation") == my_gen:
                session["transitioning"] = False


def _note_cast(session_key: str, session: dict, *, by: str, name: str, artist: str, album: str,
               image: str, duration_ms: int, queue_index: int, next_item, repeat, shuffle,
               username: str, client_device: str, start_seconds: float,
               recast: bool = False, autoplay=_UNSET, from_autoplay: bool = False,
               kind: str = "") -> None:
    """Book-keeping of a cast that the renderer took. `recast`: the same track sent
    again (a seek on a stopped renderer, a stalled start) — what follows it is
    unchanged, so the client's hint stays."""
    now = _now()
    if username:
        session["username"] = username
        session["client_device"] = client_device or "default"
    try:
        qi = int(queue_index)
    except (TypeError, ValueError):
        qi = -1
    prev = session.get("track") or {}
    session["track"] = {"queue_index": qi, "name": name, "artist": artist, "album": album,
                        "image": image, "duration_ms": int(duration_ms or 0), "by": by}
    # A row the follower appended from the autoplay list: the page must add it to its
    # own queue when it adopts it (it has never seen this row). A re-send keeps the mark.
    if from_autoplay or (recast and prev.get("autoplay") and _same_track(prev, session["track"])):
        session["track"]["autoplay"] = True
        # "radio": a row of a radio refill — the page adds it as an ordinary radio row,
        # with no "Autoplay" divider. Absent: a pick from the recommender's list.
        k = kind or (prev.get("kind") if recast else "")
        if k:
            session["track"]["kind"] = k
        if k == "radio" and session.get("radio_from") is None:
            session["radio_from"] = qi
    if by != "server" and not recast:
        session["radio_from"] = None    # the client cast from ITS queue: it has every row
    if not recast:
        session["autoplay_after"] = ({"name": prev.get("name", ""), "artist": prev.get("artist", "")}
                                     if from_autoplay and prev.get("name") else None)
        session["autoplay_seen"] = False
    # Renderers (Onkyo) often report TrackDuration=0/NOT_IMPLEMENTED; status and the
    # end rule fall back to what the client said.
    session["duration_seconds"] = (duration_ms / 1000) if duration_ms else 0
    if repeat is not None:
        session["repeat"] = _norm_repeat(repeat)
    if shuffle is not None:
        session["shuffle"] = bool(shuffle)
    if recast:
        pass
    elif by == "server":
        session["hint"] = None          # it named what follows the PREVIOUS track
        session["hint_used"] = False
    elif next_item is not _UNSET:
        session["hint"] = {"queue_index": qi, "next": _clean_item(next_item)}
        session["hint_used"] = False
    # The autoplay list: a client cast that names one replaces it ([] = none). A cast
    # WITHOUT the field keeps what the server holds — a page whose recommender is still
    # loading (app just reopened) must not wipe the list by saying nothing. The
    # follower's own casts leave what is left.
    if not recast and by != "server" and autoplay is not _UNSET and autoplay is not None:
        session["autoplay"] = _clean_autoplay(autoplay)
    session["cast_seq"] += 1
    session["queue_ended"] = False
    session["queue_ended_at"] = None
    session["sample"] = None
    session["last_ok_at"] = now
    session["idle_since"] = now
    session["last_pos"] = float(start_seconds or 0)
    f = _fresh_follow(now)
    if start_seconds and start_seconds >= 1:
        f["last_pos"] = f["max_pos"] = f["start_pos"] = float(start_seconds)
    session["f"] = f
    _abandoned.pop(session_key, None)
    # A renderer plays one thing. Another client's session on the same renderer must
    # stop following it, or its follower would advance ITS queue at our track's end.
    udn = (session.get("device") or {}).get("udn")
    for other_key, other in list(_sessions.items()):
        if other is session or not other.get("device") or other["device"].get("udn") != udn:
            continue
        other["generation"] += 1
        _cancel_follower(other)
        _sessions.pop(other_key, None)
        logger.info(f"DLNA: [{other_key}] session ended: [{session_key}] cast to the same renderer "
                    f"(was {_where(other)})")
        _abandoned[other_key] = f"{other['device'].get('name')} is now playing from another device"
    # Follow only a cast that says where it sits in the queue (queue_index): an older
    # page that sends none still runs its own end detection, and two advancing at once
    # would skip a track.
    session["follow"] = bool(session["username"]) and (by == "server" or qi >= 0)
    if session["follow"]:
        _ensure_follower(session_key, session)
    else:
        _cancel_follower(session)


async def play(session_key: str) -> bool:
    session = _sessions.get(session_key)
    if not session or not session["dmr"]:
        return False
    # A STOPPED receiver has nothing to resume: Play there starts the track from 0, or
    # nothing at all. After a stop short of the end (Stop on the remote, another
    # input, the receiver's idle stop) cast the same track again where it had got to.
    resume_at = await _stopped_resume_position(session)
    if resume_at is not None:
        return await _recast_current(session_key, session, resume_at)
    try:
        await session["dmr"].async_play()
        session["sample"] = None
        return True
    except Exception as e:
        logger.warning(f"DLNA play error: {e}")
        return False


async def pause(session_key: str) -> bool:
    session = _sessions.get(session_key)
    if not session or not session["dmr"]:
        return False
    try:
        await session["dmr"].async_pause()
        session["sample"] = None
        return True
    except Exception as e:
        logger.warning(f"DLNA pause error: {e}")
        return False


async def stop(session_key: str) -> bool:
    session = _sessions.get(session_key)
    if not session or not session["dmr"]:
        return False
    dmr = session["dmr"]
    # Abort a cast still in flight BEFORE tearing the session down. It checks the
    # generation between its Play retries and bails out on its own; clearing the slot
    # underneath it instead made it crash on None and report a failed cast.
    session["generation"] += 1
    my_gen = session["generation"]
    session["transitioning"] = False
    _cancel_follower(session)
    _abandoned.pop(session_key, None)
    logger.info(f"DLNA: [{session_key}] session ended: stop from the client (was {_where(session)})")
    try:
        await dmr.async_stop()
        return True
    except Exception as e:
        logger.warning(f"DLNA stop error: {e}")
        return False
    finally:
        # A cast that came in while the renderer was answering Stop owns the session
        # now; tearing it down would orphan that cast.
        if session["generation"] == my_gen:
            session["device"] = None
            session["dmr"] = None
            if _sessions.get(session_key) is session:
                _sessions.pop(session_key, None)  # evict — don't accumulate dead sessions
        await _persist()


def _hms(position_seconds: float) -> str:
    p = max(0, int(position_seconds))
    return f"{p // 3600:02d}:{(p % 3600) // 60:02d}:{p % 60:02d}"


async def _seek_dmr(dmr, position_seconds: float) -> bool:
    """One Seek on the renderer. The AVTransport action is called directly with an
    HH:MM:SS target: DmrDevice.async_seek_*_time take a timedelta and silently skip
    the call when the renderer's evented CurrentTransportActions lacks "seek"."""
    target = _hms(position_seconds)
    srv = _service(dmr, _AVT_URNS)
    try:
        if srv is not None:
            action = srv.action("Seek")
            try:
                await action.async_call(InstanceID=0, Unit="ABS_TIME", Target=target)
            except Exception:
                await action.async_call(InstanceID=0, Unit="REL_TIME", Target=target)
            return True
        from datetime import timedelta
        await dmr.async_seek_rel_time(timedelta(seconds=int(position_seconds)))
        return True
    except Exception as e:
        logger.warning(f"DLNA seek error: {e}")
        return False


async def _seek_after_play(dmr, position_seconds: float, session: dict, my_gen: int) -> bool:
    for delay in SEEK_RETRY_DELAYS:
        if my_gen != session["generation"]:
            return False
        if delay:
            await asyncio.sleep(delay)
        try:
            if await asyncio.wait_for(_seek_dmr(dmr, position_seconds), timeout=SEEK_TIMEOUT):
                return True
        except asyncio.TimeoutError:
            pass
    return False


async def _stopped_resume_position(session: dict) -> float | None:
    """Where Play should pick a stopped track up, or None for a plain Play: the
    renderer is not stopped, the track never started, or it stopped at its end."""
    f = session.get("f") or {}
    if not f.get("started") or not session.get("track") or not session.get("username"):
        return None
    sample = session.get("sample")
    if not sample or _now() - sample["at"] > SEEK_STATE_MAX_AGE:
        sample = await _sample(session, 0.0)
    if not sample or sample.get("state") not in _ENDED_STATES:
        return None
    if f.get("resume_pos") is not None:
        return f["resume_pos"]
    if f.get("played"):                 # the follower has not judged this stop yet
        dur, from_renderer = _track_duration(session, f, sample)
        est, ended = _judge_stop(f, _now(), sample.get("pos"), dur, from_renderer)
        return None if ended else est
    return None


async def _recast_current(session_key: str, session: dict, position_seconds: float) -> bool:
    """Cast the session's current track again at `position_seconds` (a re-send: the
    client's hint and track.by stay)."""
    from app.services import auth
    track = session["track"]
    token = auth.create_stream_token(session["username"], ttl=24 * 3600)
    try:
        return await asyncio.wait_for(cast_to_device(
            session_key, session["device"]["udn"] if session.get("device") else "",
            track["name"], track.get("artist", ""), token,
            album=track.get("album", ""), image=track.get("image", ""),
            duration_ms=int(track.get("duration_ms") or 0),
            start_seconds=max(position_seconds, 0.0), queue_index=track.get("queue_index", -1),
            username=session["username"], client_device=session["client_device"],
            by=track.get("by", "client"), recast=True,
        ), timeout=CAST_TIMEOUT)
    except (CastError, asyncio.TimeoutError) as e:
        logger.warning(f"DLNA: re-cast at {position_seconds:.0f}s failed: {e!r}")
        return False


async def seek(session_key: str, position_seconds: float) -> bool:
    session = _sessions.get(session_key)
    if not session or not session["dmr"]:
        return False
    # A STOPPED (or emptied) renderer acknowledges a Seek and then does nothing — the
    # log of 2026-11-19 has five such 200s in a row (finding 5). There the robust move
    # is to cast the track again from that position: SetAVTransportURI, Play, Seek
    # while PLAYING, which is the path seen working (206 re-fetches).
    sample = session.get("sample")
    if not sample or _now() - sample["at"] > SEEK_STATE_MAX_AGE:
        sample = await _sample(session, 0.0)
    state = (sample or {}).get("state")
    track = session.get("track")
    if state in _ENDED_STATES and track and session.get("username"):
        return await _recast_current(session_key, session, position_seconds)
    ok = await _seek_dmr(session["dmr"], position_seconds)
    if ok:
        session["sample"] = None
        f = session["f"]
        f["last_pos"] = float(position_seconds)
        f["last_pos_at"] = _now()
    return ok


async def set_volume(session_key: str, volume: int) -> bool:
    session = _sessions.get(session_key)
    if not session or not session["dmr"]:
        return False
    try:
        await session["dmr"].async_set_volume_level(volume / 100.0)
        session["volume"] = int(volume)
        return True
    except Exception as e:
        logger.warning(f"DLNA set_volume error: {e}")
        return False


def _parse_time(t: str) -> float:
    """Parse HH:MM:SS or H:MM:SS to seconds."""
    if not t or t == "NOT_IMPLEMENTED":
        return 0
    parts = t.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
    except (ValueError, IndexError):
        pass
    return 0


# ── Polling the renderer ──

def _service(dmr, urns):
    try:
        services = dmr.device.services
    except Exception:
        return None
    for urn in urns:
        srv = services.get(urn)
        if srv is not None:
            return srv
    return None


async def _call(srv, action: str, **kw) -> dict:
    if srv is None:
        raise RuntimeError(f"no service for {action}")
    return await asyncio.wait_for(srv.action(action).async_call(**kw), timeout=SOAP_TIMEOUT)


async def _poll(session: dict) -> dict:
    """Ask the renderer once: transport state and position together (gathered, so a
    tick costs one SOAP round trip, not three in a row — finding 6), volume only on
    every VOLUME_EVERY-th poll."""
    dmr = session["dmr"]
    gen = session["generation"]
    started = _now()
    n = session["poll_n"]
    session["poll_n"] = n + 1
    av = _service(dmr, _AVT_URNS) if dmr else None
    rc = _service(dmr, _RC_URNS) if dmr else None
    want_vol = rc is not None and n % VOLUME_EVERY == 0
    calls = [_call(av, "GetTransportInfo", InstanceID=0),
             _call(av, "GetPositionInfo", InstanceID=0)]
    if want_vol:
        calls.append(_call(rc, "GetVolume", InstanceID=0, Channel="Master"))
    res = await asyncio.gather(*calls, return_exceptions=True)
    ti, pi = res[0], res[1]
    ok_ti = not isinstance(ti, BaseException) and isinstance(ti, dict)
    ok_pi = not isinstance(pi, BaseException) and isinstance(pi, dict)
    sample = {
        "at": _now(), "started": started, "gen": gen, "ok": ok_ti or ok_pi,
        "state": (ti.get("CurrentTransportState") or "unknown") if ok_ti else "unknown",
        "transport_status": (ti.get("CurrentTransportStatus") or "") if ok_ti else "",
        "pos": _parse_time(pi.get("RelTime", "")) if ok_pi else None,
        "dur": _parse_time(pi.get("TrackDuration", "")) if ok_pi else None,
        "uri": (pi.get("TrackURI") or "") if ok_pi else "",
    }
    if want_vol:
        v = res[2]
        vol = None
        if not isinstance(v, BaseException) and isinstance(v, dict):
            try:
                vol = int(v.get("CurrentVolume"))
            except (TypeError, ValueError):
                vol = None
        # A failed GetVolume is "unknown", not 0 — the slider used to jump to 0 % (finding 19).
        session["volume"] = vol
    if sample["ok"]:
        session["last_ok_at"] = sample["at"]
        if sample["state"] == "PLAYING":
            session["idle_since"] = None
        elif session.get("idle_since") is None and ok_ti:
            session["idle_since"] = sample["at"]
        if sample["pos"] is not None:
            session["last_pos"] = sample["pos"]
    else:
        await _rebind_if_moved(session)
    session["sample"] = sample
    return sample


async def _rebind_if_moved(session: dict) -> None:
    """The renderer stopped answering at its old address but discovery has since
    seen the same UDN elsewhere: talk to it there (finding 14)."""
    dev = session.get("device")
    if not dev:
        return
    cur = _find_device(dev["udn"])
    if not cur or cur.get("location") == dev.get("location"):
        return
    try:
        from async_upnp_client.profiles.dlna import DmrDevice
        factory = await _get_factory()
        upnp_device = await asyncio.wait_for(factory.async_create_device(cur["location"]),
                                             timeout=SOAP_TIMEOUT)
        session["dmr"] = DmrDevice(upnp_device, None)
        session["device"] = cur
        logger.info(f"DLNA: following {cur['name']} at its new address {cur['location']}")
    except Exception as e:
        logger.debug(f"DLNA: rebind to {cur.get('location')} failed: {e!r}")


async def _sample(session: dict, max_age: float) -> dict | None:
    """A renderer sample no older than `max_age`. Concurrent callers share ONE poll in
    flight instead of each sending their own (the client's polls overlapped after
    every wake-up — finding 6)."""
    s = session.get("sample")
    if s and _now() - s["at"] < max_age and s["gen"] == session["generation"]:
        return s
    task = session.get("poll_task")
    if task is None or task.done():
        task = asyncio.ensure_future(_poll(session))
        session["poll_task"] = task
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.debug(f"DLNA poll error: {e!r}")
        return None


async def _observe(session_key: str, session: dict, max_age: float) -> dict | None:
    """Sample, and end the session when it is over:
    - the renderer has not answered once for STALE_SECONDS (finding 7: failures used to
      be swallowed, so a receiver in standby read "unknown" and active forever; a count
      of failed polls instead ended a cast on a 15 s Wi-Fi drop);
    - it has not been PLAYING for IDLE_EXPIRE (paused, stopped, queue played out): a
      session left behind must not be polled for days and taken over by a page load;
    - it plays something that is not ours."""
    sample = await _sample(session, max_age)
    if _sessions.get(session_key) is not session:
        return None
    now = _now()
    name = (session.get("device") or {}).get("name") or "The receiver"
    if (sample is None or not sample.get("ok")) and now - session.get("last_ok_at", now) >= STALE_SECONDS:
        await _abandon(session_key, session, f"{name} stopped answering — casting ended")
        return None
    if _idle_seconds(session, now) >= IDLE_EXPIRE:
        await _abandon(session_key, session,
                       f"{name} was idle for {int(IDLE_EXPIRE // 60)} minutes — casting ended")
        return None
    if sample and _plays_something_else(session, sample):
        await _abandon(session_key, session, f"{name} is now playing something else — casting ended")
        return None
    return sample


def _idle_seconds(session: dict, now: float | None = None) -> float:
    since = session.get("idle_since")
    return 0.0 if since is None else max(0.0, (_now() if now is None else now) - since)


# URI schemes that are certainly not our stream: what a receiver reports once another
# app has taken it over. Kept short on purpose — anything unknown counts as an echo.
_FOREIGN_SCHEMES = ("spotify:", "x-sonos-spotify:", "tidal:", "qobuz:", "deezer:",
                    "aircast:", "airplay:")


def _decoded(uri: str) -> str:
    txt = uri
    for _ in range(2):                       # escaped and/or percent-encoded, maybe twice
        txt = unquote(html.unescape(txt))
    return txt


def _clearly_foreign(uri: str) -> bool:
    """A URI that cannot be our stream echoed back: a known streaming-service scheme,
    or an http(s) URL on another host:port than ours."""
    txt = _decoded(uri).strip().lower()
    if txt.startswith(_FOREIGN_SCHEMES):
        return True
    if txt.startswith(("http://", "https://")):
        ours = urlparse(_get_server_url()).netloc.lower()
        return bool(ours) and urlparse(txt).netloc != ours
    return False


def _uri_is_ours(session: dict, uri: str) -> bool:
    if uri == session["f"].get("our_uri"):
        return True
    txt = _decoded(uri)
    if "/api/player/stream" in txt:
        return True
    hostport = urlparse(_get_server_url()).netloc
    return bool(hostport) and hostport in txt


def _plays_something_else(session: dict, sample: dict) -> bool:
    """The renderer names a track URI that is not ours: someone switched it to Spotify
    Connect, another controller, its own radio. Robust against a renderer that echoes
    our URL in its own form: the URI is ours when it (unescaped, decoded) has our
    stream path or our host:port, or equals the first URI it reported while playing
    after our cast unless that one was clearly foreign (the learned echo). "Something
    else" needs FOREIGN_SAMPLES
    in a row while PLAYING/TRANSITIONING, after our last cast, with none in flight."""
    f = session["f"]
    if (session.get("transitioning") or sample["gen"] != session["generation"]
            or sample["started"] < f["reset_at"]):
        return False
    if f.get("foreign_at") == sample["at"]:          # the same sample, seen by another caller
        return f["foreign_n"] >= FOREIGN_SAMPLES
    f["foreign_at"] = sample["at"]
    uri = (sample.get("uri") or "").strip()
    if not uri or uri.upper() == "NOT_IMPLEMENTED":
        f["foreign_n"] = 0
        return False
    playing = sample.get("state") in ("PLAYING", "TRANSITIONING")
    ours = _uri_is_ours(session, uri)
    # Learn the echo from the first playing sample after our cast, whatever form the
    # receiver writes our URL in (its own scheme, no query, …) — UNLESS it is clearly
    # foreign: the receiver may still name what it played before (Spotify Connect),
    # and learning that would hide the take-over for good. The risk is lopsided: a
    # wrong "something else" would end EVERY cast on a receiver with its own echo
    # form, a missed take-over is rare.
    if f.get("our_uri") is None and playing and (ours or not _clearly_foreign(uri)):
        f["our_uri"] = uri
        ours = True
    if ours or not playing:
        f["foreign_n"] = 0
        return False
    f["foreign_n"] += 1
    return f["foreign_n"] >= FOREIGN_SAMPLES


async def _abandon(session_key: str, session: dict, message: str) -> None:
    sample = session.get("sample") or {}
    logger.warning(f"DLNA: [{session_key}] session ended: {message} (was {_where(session)}, "
                   f"last state {sample.get('state', '?')}, idle {_idle_seconds(session):.0f} s, "
                   f"queue_ended {bool(session.get('queue_ended'))})")
    session["generation"] += 1
    _cancel_follower(session)
    if _sessions.get(session_key) is session:
        _sessions.pop(session_key, None)
    if len(_abandoned) >= _MAX_SESSIONS:
        _abandoned.pop(next(iter(_abandoned)), None)
    _abandoned[session_key] = message
    session["dmr"] = None
    session["device"] = None
    await _persist()


def take_abandoned(session_key: str) -> str | None:
    """Why the session ended on its own — returned once, then forgotten."""
    return _abandoned.pop(session_key, None)


def _status_from(session: dict, sample: dict) -> dict:
    dev = session["device"]
    ok = bool(sample and sample.get("ok"))
    pos = sample.get("pos") if ok else None
    dur = (sample.get("dur") if ok else None) or session.get("duration_seconds") or 0
    track = session.get("track")
    st = {
        "device": dev["name"],
        "device_id": dev["udn"],
        "location": dev["location"],
        "state": sample["state"] if ok else "unknown",
        "transport_status": sample.get("transport_status", "") if ok else "",
        "position_seconds": pos if pos is not None else session.get("last_pos", 0),
        "duration_seconds": dur,
        "follow": bool(session.get("follow")),
        "session_id": session.get("session_id"),
        "cast_seq": session.get("cast_seq", 0),
        "track": dict(track) if track else None,
        "queue_ended": bool(session.get("queue_ended")),
        "idle_seconds": round(_idle_seconds(session), 1),
        # How many autoplay tracks the follower still holds for the end of the queue.
        "autoplay_left": len(session.get("autoplay") or []),
    }
    # Unknown volume: no key at all (a page cached before the null rule shows "null%").
    if session.get("volume") is not None:
        st["volume"] = session["volume"]
    if session.get("queue_ended") and session.get("queue_ended_at") is not None:
        st["queue_ended_ago"] = round(max(0.0, _now() - session["queue_ended_at"]), 1)
    if not ok:
        st["stale"] = True
    return st


async def get_status(session_key: str) -> dict | None:
    session = _sessions.get(session_key)
    if not session or not session["dmr"] or not session["device"]:
        if session and session["transitioning"]:
            return {"device": "transitioning", "device_id": None, "location": None,
                    "state": "TRANSITIONING", "position_seconds": 0, "duration_seconds": 0,
                    "follow": False, "session_id": session.get("session_id"),
                    "cast_seq": session.get("cast_seq", 0), "idle_seconds": 0,
                    "track": None, "queue_ended": False}
        return None
    sample = await _observe(session_key, session, STATUS_CACHE_TTL)
    if sample is None or _sessions.get(session_key) is not session or not session["device"]:
        return None
    return _status_from(session, sample)


async def set_next_hint(session_key: str, queue_index: int, next_item: dict | None,
                        repeat: str = "off", shuffle: bool = False, autoplay=None) -> str:
    """The client's "after the current track comes …". Returns "ok", "no_session", or
    "stale" when the client is not talking about the track the session plays now."""
    session = _sessions.get(session_key)
    if not session or not session.get("device"):
        return "no_session"
    track = session.get("track")
    if not track or track.get("queue_index") != queue_index:
        return "stale"
    session["hint"] = {"queue_index": queue_index, "next": _clean_item(next_item)}
    session["hint_used"] = False
    # The page speaks about THIS track: it has the row in its queue (it adopted it).
    session["autoplay_seen"] = True
    if autoplay is not None:        # absent = keep what is held; [] = none
        session["autoplay"] = _clean_autoplay(autoplay)
    session["repeat"] = _norm_repeat(repeat)
    session["shuffle"] = bool(shuffle)
    await _persist()
    return "ok"


def get_session_id(session_key: str) -> str | None:
    session = _sessions.get(session_key)
    return session.get("session_id") if session else None


def get_cast_seq(session_key: str) -> int:
    session = _sessions.get(session_key)
    return session.get("cast_seq", 0) if session else 0


# ── The follower ──

async def _follow(session_key: str) -> None:
    me = asyncio.current_task()
    try:
        while True:
            session = _sessions.get(session_key)
            if session is None or session.get("follower") is not me or not session.get("follow"):
                return
            try:
                await _follow_tick(session_key, session)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"DLNA: [{session_key}] follower tick failed: {e!r}")
            if _sessions.get(session_key) is not session or session.get("queue_ended"):
                return
            await asyncio.sleep(FOLLOW_TICK)
    finally:
        session = _sessions.get(session_key)
        if session is not None and session.get("follower") is me:
            session["follower"] = None


async def _follow_tick(session_key: str, session: dict) -> None:
    if session.get("transitioning"):
        return              # a cast is in flight; its outcome resets the follow state
    sample = await _observe(session_key, session, FOLLOW_SAMPLE_MAX_AGE)
    if sample is None or _sessions.get(session_key) is not session:
        return
    if (session.get("transitioning") or sample["gen"] != session["generation"]
            or sample["started"] < session["f"]["reset_at"]):
        return              # a reply about the previous track
    await _follow_step(session_key, session, sample)


async def _follow_step(session_key: str, session: dict, s: dict) -> None:
    """Judge one sample: has the track ended, is it stuck, or nothing to do."""
    f = session["f"]
    if f.get("pending") is not None:
        # An advance that could not read the queue last time: try it again.
        if f["pending"] == session["generation"]:
            f["pending"] = None
            await _advance(session_key, session, session["generation"])
        else:
            f["pending"] = None
        return
    if not s["ok"]:
        return
    now = s["at"]
    gap = now - f["prev_at"]
    live = 0 <= gap <= LIVE_GAP_MAX
    state, pos = s["state"], s["pos"]
    if state == "PLAYING" and s["dur"]:
        f["renderer_dur"] = s["dur"]
    dur, dur_from_renderer = _track_duration(session, f, s)
    prev_playing = f["prev_playing"]
    f["prev_at"] = now
    f["prev_playing"] = state == "PLAYING"

    if state == "PLAYING":
        if prev_playing and live:
            f["play_time"] += gap
        f["played"] = True
        f["started"] = True
        f["resume_pos"] = None    # playing again: an earlier stop's position is history
        f["wait"] = 0.0
        session["dead_tracks"] = 0
        if pos is not None:
            f["last_pos"], f["last_pos_at"], f["last_playing"] = pos, now, True
            f["max_pos"] = max(f["max_pos"], pos)
        if now - f["persist_at"] >= PERSIST_POSITION_EVERY:
            f["persist_at"] = now
            await _persist()
        return

    if state in _PAUSED_STATES:
        if pos is not None:
            f["last_pos"], f["last_pos_at"], f["last_playing"] = pos, now, False
            f["max_pos"] = max(f["max_pos"], pos)
            if pos > 1:
                f["played"] = f["started"] = True
        return

    if state in _ENDED_STATES and f["played"]:
        est, near_end = _judge_stop(f, now, pos, dur, dur_from_renderer)
        f["played"] = False
        f["last_playing"] = False
        if near_end:
            await _advance(session_key, session, session["generation"])
        else:
            f["resume_pos"] = est
            # The one place a queue stands still without ending: say exactly why, with
            # the numbers the decision was made from.
            logger.info(f"DLNA: [{session_key}] receiver {state} mid-track "
                        f"'{_safe((session.get('track') or {}).get('name', '?'))}' "
                        f"(row {(session.get('track') or {}).get('queue_index', -1)}) at {est:.0f}/{dur:.0f} s "
                        f"({'renderer' if dur_from_renderer else 'catalogue' if dur else 'no'} duration, "
                        f"watched {f['play_time']:.0f} s) — not its end, waiting (no advance)")
        return

    # Cast, but not playing yet: count the WATCHED wait (a gap is not evidence of a
    # stall), and leave a renderer alone that reports progress. A track that DID play
    # and was then stopped short of its end (Stop on the remote, another input, the
    # receiver's own idle stop) is not a stall: the follower waits, with no cast, for a
    # new cast or for the receiver to play again.
    if (f["started"] or f["played"] or (pos is not None and pos > 1)
            or state not in _ENDED_STATES + ("TRANSITIONING",)):
        return
    if live:
        f["wait"] += gap
    if f["wait"] >= STALL_SKIP_AFTER:
        session["dead_tracks"] = session.get("dead_tracks", 0) + 1
        if session["dead_tracks"] >= DEAD_TRACKS_LIMIT:
            name = (session.get("device") or {}).get("name") or "The receiver"
            await _abandon(session_key, session,
                           f"{name} did not start {session['dead_tracks']} tracks in a row — casting ended")
            return
        logger.info(f"DLNA: [{session_key}] dead track: {_where(session)} never started in "
                    f"{f['wait']:.0f} s, skipping it")
        await _advance(session_key, session, session["generation"])
    elif f["wait"] >= STALL_RECAST_AFTER and not f["recast"]:
        f["recast"] = True
        track = session.get("track") or {}
        logger.info(f"DLNA: [{session_key}] {_where(session)} did not start in {f['wait']:.0f} s, "
                    f"sending it once more")
        wait = f["wait"]
        result = await _server_cast(session_key, session, track, track.get("queue_index", -1),
                                    session["generation"], by=track.get("by", "client"),
                                    recast=True)
        if result == "ok":
            session["f"]["wait"] = wait          # the skip clock keeps running
            session["f"]["recast"] = True


def _track_duration(session: dict, f: dict, sample: dict) -> tuple[float, bool]:
    """(duration, whether the RENDERER reported it). A renderer often reports 0 once
    stopped, so the last duration it gave while playing counts too."""
    rdur = sample.get("dur") or f.get("renderer_dur") or 0
    if rdur:
        return rdur, True
    return session.get("duration_seconds") or 0, False


def _judge_stop(f: dict, now: float, pos, dur: float, renderer_dur: bool = True) -> tuple[float, bool]:
    """(where the track had got to, whether that is its end) for a renderer that
    reports STOPPED after playing.

    The position is the last one sampled, carried forward over the time since if the
    renderer was playing then. Without this a gap in the samples (a receiver that did
    not answer for a while, a restart) made a track that ended look stopped half-way,
    and the queue stood still."""
    est = f["last_pos"] + ((now - f["last_pos_at"]) if f["last_playing"] else 0.0)
    if pos:
        est = max(est, pos)
    if dur > 0:
        # The server samples without pause and carries the position forward, so a
        # wide window is not needed: 15 % of a two-hour mix would be 18 minutes.
        # A duration only from the catalogue (not from the renderer) may not even be
        # this file's: then only the last NEAR_END_MARGIN counts, or an input switch
        # in the last minute would cast the next track.
        window = (max(NEAR_END_MARGIN, min((1 - NEAR_END_FRACTION) * dur, NEAR_END_MAX_WINDOW))
                  if renderer_dur else NEAR_END_MARGIN)
        return est, est >= dur - window
    # No duration from anyone: only a stop after real progress (from where the cast
    # started — a handover at 45:00 is not progress) AND real, watched play time is an
    # end. Switching the receiver to another input a few seconds in must not move the
    # queue on (finding 10).
    return est, (max(f["max_pos"], pos or 0) - f["start_pos"] > 1
                 and f["play_time"] >= UNKNOWN_DUR_MIN_PLAYED)


async def _server_cast(session_key: str, session: dict, item: dict, queue_index: int,
                       expect_gen: int, by: str = "server", recast: bool = False,
                       from_autoplay: bool = False, kind: str = "") -> str:
    """Cast `item` on the follower's behalf. "ok", "superseded" (the client cast
    meanwhile, or the session ended), or "failed"."""
    from app.services import auth
    if not session.get("device") or not session.get("username"):
        return "superseded"
    token = auth.create_stream_token(session["username"], ttl=24 * 3600)
    try:
        result = await asyncio.wait_for(_cast(
            session_key, session["device"]["udn"], item.get("name", ""), item.get("artist", ""), token,
            album=item.get("album", ""), image=item.get("image", ""),
            duration_ms=int(item.get("duration_ms") or 0), queue_index=queue_index,
            username=session["username"], client_device=session["client_device"],
            by=by, expect_generation=expect_gen, recast=recast, from_autoplay=from_autoplay,
            kind=kind,
        ), timeout=CAST_TIMEOUT)
    except CastError:
        result = "failed"       # (logged where it was raised)
    except asyncio.TimeoutError as e:
        logger.warning(f"DLNA: [{session_key}] cast of '{_safe(item.get('name'))}' (by {by}) failed: {_safe(repr(e))}")
        result = "failed"
    if result == "failed" and (_sessions.get(session_key) is not session
                               or session["generation"] != expect_gen + 1):
        return "superseded"     # a timeout/cancel caused by a newer cast or a stop
    return result


async def _advance(session_key: str, session: dict, gen: int) -> None:
    """The current track is over (or dead): cast the next one, unless the client
    has cast something itself since `gen` — then the client wins."""
    for _ in range(DEAD_TRACKS_LIMIT + 1):
        try:
            choice = await _choose_next(session)
        except _QueueNotReadable as e:
            # Never "end of the queue" because a file was mid-write: next tick again.
            logger.warning(f"DLNA: [{session_key}] queue not readable, retrying: {e}")
            if session["generation"] == gen and _sessions.get(session_key) is session:
                session["f"]["pending"] = gen
            return
        if session["generation"] != gen or _sessions.get(session_key) is not session:
            return
        appended = False
        kind = ""
        via = (session.get("last_choice") or {}).get("via") or "queue"
        lost_row = bool((session.get("track") or {}).get("autoplay")) and not session.get("autoplay_seen")
        if choice is None and session.get("repeat", "off") == "off":
            # The saved queue is over. Two things can continue it, in the page's own
            # order (_nextTrackTerminal): a RADIO queue is refilled from the radio
            # service — by us, the page may be frozen; otherwise the picks its
            # recommender handed over in advance are appended one at a time.
            # (`lost_row`: even with no picks left, a row of ours that a stale save
            # erased is put back — rows the user queued behind it are still to play.)
            from app.services import player as _player
            try:
                radio = await _take_radio(session_key, session, gen)
                if radio is not None:
                    choice, kind, via = radio[0], "radio", "radio"
                elif session.get("autoplay") or lost_row:
                    choice, via = await _take_autoplay(session), "autoplay"
            except _player.QueueUnreadable as e:
                # A file mid-write: the next tick tries again (nothing is fetched twice).
                logger.warning(f"DLNA: [{session_key}] queue not readable, retrying: {e!r}")
                if session["generation"] == gen and _sessions.get(session_key) is session:
                    session["f"]["pending"] = gen
                return
            except OSError as e:
                # The file cannot be written (disk full, read-only volume). A few tries,
                # then the queue ends: retrying every 2 s until the idle expiry would
                # put ~900 warnings onto the very disk that is full.
                f = session["f"]
                f["append_fails"] = f.get("append_fails", 0) + 1
                if (f["append_fails"] < APPEND_WRITE_TRIES and session["generation"] == gen
                        and _sessions.get(session_key) is session):
                    if f["append_fails"] == 1:
                        logger.warning(f"DLNA: [{session_key}] queue not writable, retrying: {_safe(repr(e))}")
                    f["pending"] = gen
                    return
                logger.error(f"DLNA: [{session_key}] queue not writable after {f['append_fails']} tries "
                             f"({_safe(repr(e))}) — nothing can be appended, the queue ends here")
                session["radio_batch"] = None
                choice = None
            except Exception as e:
                # Anything else is a fault of ours: end the queue, do not spin on it.
                logger.error(f"DLNA: [{session_key}] continuing past the queue's end failed: {_safe(repr(e))}")
                choice = None
            if choice == "again":
                # The playing row had been saved away and is back in its place, with
                # rows the user queued behind it: the queue is not over — choose again.
                try:
                    choice = await _choose_next(session)
                except _QueueNotReadable:
                    if session["generation"] == gen and _sessions.get(session_key) is session:
                        session["f"]["pending"] = gen
                    return
                if session["generation"] != gen or _sessions.get(session_key) is not session:
                    return
                kind, via = "", "queue"
            else:
                appended = choice is not None
            if session["generation"] != gen or _sessions.get(session_key) is not session:
                if appended:        # the client cast meanwhile: its queue has no such row
                    await asyncio.to_thread(_drop_appended, session["username"],
                                            session["client_device"], choice[0], choice[1],
                                            kind == "radio")
                return
        if choice is None:
            session["queue_ended"] = True
            session["queue_ended_at"] = _now()
            session["f"]["resume_pos"] = None
            info = session.get("last_choice") or {}
            logger.info(f"DLNA: [{session_key}] end of the queue after {_where(session)}: "
                        f"saved queue {info.get('n', '?')} rows, playing row found at {info.get('cur')}, "
                        f"repeat {session.get('repeat', 'off')}, shuffle {bool(session.get('shuffle'))}, "
                        f"autoplay list {len(session.get('autoplay') or [])}, "
                        f"radio {info.get('radio', 'no')}")
            await _persist()
            return
        idx, item, order = choice
        prev_track = dict(session.get("track") or {})
        # The same track again (repeat one): a re-send, so the client's hint stays.
        again = _same_track(item, session.get("track")) and idx == (session.get("track") or {}).get("queue_index")
        # A later row of a radio batch we appended is still a row the page has not seen.
        rf = session.get("radio_from")
        if not appended and not again and isinstance(rf, int) and isinstance(idx, int) and idx >= rf:
            kind = "radio"
        ours = appended or kind == "radio"
        result = await _server_cast(session_key, session, item, idx, gen, recast=again,
                                    from_autoplay=ours, kind=kind)
        if result == "superseded":
            if appended:
                await asyncio.to_thread(_drop_appended, session["username"],
                                        session["client_device"], idx, item, kind == "radio")
            return
        await asyncio.to_thread(_write_queue_position, session["username"],
                                session["client_device"], idx, item, order)
        if result == "ok":
            logger.info(f"DLNA: [{session_key}] advance '{_safe(prev_track.get('name', '?'))}' "
                        f"(row {prev_track.get('queue_index', -1)}) → '{_safe(item.get('name', '?'))}' "
                        f"(row {idx}), via {'repeat one' if again else via}")
            return
        session["dead_tracks"] = session.get("dead_tracks", 0) + 1
        if session["dead_tracks"] >= DEAD_TRACKS_LIMIT:
            name = (session.get("device") or {}).get("name") or "The receiver"
            await _abandon(session_key, session,
                           f"{name} did not start {session['dead_tracks']} tracks in a row — casting ended")
            return
        # The failed one counts as played: the next choice moves past it.
        session["track"] = {**item, "queue_index": idx, "by": "server"}
        if kind:
            session["track"]["kind"] = kind
        if kind == "radio" and session.get("radio_from") is None:
            session["radio_from"] = idx
        if ours:
            session["track"]["autoplay"] = True
            session["autoplay_after"] = {"name": prev_track.get("name", ""), "artist": prev_track.get("artist", "")}
            session["autoplay_seen"] = False
        session["hint"] = None
        gen = session["generation"]


def _radio_plan(username: str, client_device: str, track: dict) -> dict | None:
    """The seed of a radio refill when the device's saved queue is a radio queue
    (`radio_mode`, saved by the page with the queue), else None. Blocking (file)."""
    from app.services import player
    data = player.load_queue(username, client_device, strict=True, fallback=False)
    if not isinstance(data, dict) or not data.get("radio_mode"):
        return None
    rows = [it for it in (data.get("queue") or []) if isinstance(it, dict) and it.get("name")]
    # As the page seeds its refill: the queue's last row, else the radio's own seed.
    seed = rows[-1] if rows else (data.get("radio_seed") if isinstance(data.get("radio_seed"), dict) else None)
    if not seed or not seed.get("name"):
        seed = track
    return {"name": str(seed.get("name") or ""), "artist": str(seed.get("artist") or "")}


async def _take_radio(session_key: str, session: dict, gen: int):
    """End of a RADIO queue: ask the radio service for more (the page's refill, done
    here because the page may be frozen), append the new tracks to the saved queue and
    return ((index, row, order) of the first one,) — (None,) when the service had
    nothing new, ("again",) like _take_autoplay. None when the queue is not a radio
    queue at all. The radio service needs nothing of the user's request context: it
    asks Deezer / Last.fm with the app's own settings."""
    from app.services import radio, settings as app_settings
    track = dict(session.get("track") or {})
    seed = await asyncio.to_thread(_radio_plan, session["username"], session["client_device"], track)
    if seed is None:
        return None
    rows: list[dict] = []
    # One external lookup per queue end: when the append below fails (file mid-write,
    # disk full) the follower comes back on its next tick — with the batch it already
    # has, not with another round of Deezer / Last.fm requests every 2 s.
    kept = session.get("radio_batch")
    if isinstance(kept, dict) and kept.get("seq") == session.get("cast_seq"):
        return await _append_radio(session_key, session, gen, track, seed, kept["rows"])
    session["radio_batch"] = None
    try:
        source = app_settings._settings.get("recommendation_source", "combined")
        found = await asyncio.wait_for(
            radio.get_radio_tracks(source, seed["name"], seed["artist"], "", RADIO_BATCH),
            timeout=RADIO_TIMEOUT)
        rows = _clean_autoplay(found)
        for row in rows:
            row.setdefault("type", "track")
    except asyncio.TimeoutError:
        logger.warning(f"DLNA: [{session_key}] radio refill after '{_safe(seed['name'])}' timed out "
                       f"({RADIO_TIMEOUT:.0f} s)")
    except Exception as e:
        logger.warning(f"DLNA: [{session_key}] radio refill after '{_safe(seed['name'])}' failed: {_safe(repr(e))}")
    session["radio_batch"] = {"seq": session.get("cast_seq"), "rows": rows}
    return await _append_radio(session_key, session, gen, track, seed, rows)


async def _append_radio(session_key: str, session: dict, gen: int, track: dict, seed: dict,
                        rows: list) -> tuple:
    if session["generation"] != gen or _sessions.get(session_key) is not session:
        return (None,)              # the client cast meanwhile: nothing is appended
    if not rows:
        session["radio_batch"] = None
        logger.info(f"DLNA: [{session_key}] radio refill after '{_safe(seed['name'])}': nothing new")
        return (None,)
    restore_after = (session.get("autoplay_after") or {}) if not session.get("autoplay_seen") else None
    used, choice = await asyncio.to_thread(
        _append_autoplay, session["username"], session["client_device"], track, rows,
        bool(session.get("shuffle")), restore_after, True)
    session["radio_batch"] = None       # written (or nothing in it was new): done with it
    if choice is None:
        logger.info(f"DLNA: [{session_key}] radio refill after '{_safe(seed['name'])}': "
                    f"{len(rows)} tracks, none new for this queue")
    return (choice,)


async def _take_autoplay(session: dict):
    """End of the saved queue with an autoplay list: (queue index, item, shuffle order
    or None) of the list's first usable track, now APPENDED to the saved queue — or
    None when the list holds nothing usable, or the playing track is not where the
    saved queue ends. Tracks passed over and the one used leave the session's list."""
    lst = session.get("autoplay") or []
    # A lost row is put back only if the page never showed it knows the row (it slept
    # through it, and its stale save erased it). Once the page has hinted about this
    # track it HAS the row: its absence from the file is then the user's doing (row
    # removed, queue replaced) and the queue ends, as for any removed playing row.
    restore_after = (session.get("autoplay_after") or {}) if not session.get("autoplay_seen") else None
    took = await asyncio.to_thread(
        _append_autoplay, session["username"], session["client_device"],
        dict(session.get("track") or {}), [dict(i) for i in lst], bool(session.get("shuffle")),
        restore_after)
    used, choice = took
    if session.get("autoplay") is lst:
        del lst[:used]
    elif isinstance(choice, tuple):
        # A newer list arrived from the page while the queue was being written.
        session["autoplay"] = [i for i in (session.get("autoplay") or [])
                               if not _same_track(i, choice[1])]
    return choice


def _append_autoplay(username: str, client_device: str, track: dict, items: list,
                     shuffle: bool, restore_after: dict | None = None,
                     take_all: bool = False) -> tuple[int, tuple | str | None]:
    """(how many list items were consumed, (index, row, order) of the appended one or
    None — or "again": a lost row was put back in the MIDDLE of the queue, so the queue
    is not over and the caller chooses anew). One read-modify-write under the queue
    lock (player.update_queue). An item that is the current track, or that the queue
    already holds, is passed over. `take_all` (a radio refill): EVERY usable item is
    appended, as the page appends a whole batch; the first one is the choice.

    Nothing is appended unless the track playing now really is where the saved queue
    ends: the list was made for that moment, not for a queue that changed since. One
    exception: the playing track is itself a row this follower appended and the file no
    longer holds it (a page that woke up saved its older queue over ours): the row is
    put back right after the row it followed (`restore_after`; at the end when that row
    cannot be found, or is the last) — rows the user queued meanwhile stay AHEAD of it.
    `restore_after` None = do not restore (the page knows the row: it was removed).
    The queue is NOT trimmed here: only the page knows where its "Autoplay" tail starts
    (it caps the tail itself when it adopts the row). Only the device's OWN queue file
    is written (fallback=False): a device without one must not get the default
    device's queue plus our row as its own."""
    from app.services import player
    out: dict = {"used": 0, "choice": None}

    def mutate(data: dict):
        queue = data.get("queue")
        if not isinstance(queue, list):
            return False
        n = len(queue)
        cur = _locate([it if isinstance(it, dict) else {} for it in queue], track,
                      data.get("current_index"))
        restored = False
        if (cur is None and restore_after is not None and track.get("autoplay")
                and track.get("name") and n):
            at = n
            if restore_after.get("name"):
                found = [i for i, it in enumerate(queue) if isinstance(it, dict) and _same_track(it, restore_after)]
                if found:
                    at = found[-1] + 1
            queue.insert(at, {key: track[key] for key in ("name", "artist", "album", "image", "duration_ms", "id")
                              if key in track})
            cur, n, restored = at, n + 1, True
            if cur != n - 1 and not shuffle:
                # Rows follow it: only the row and the pointer are written here.
                data["current_index"] = cur
                out["choice"] = "again"
                return True
        shuffled = shuffle and n > 1
        if cur is None or (not shuffled and cur != n - 1):
            return False
        played, tail = _sync_order(data.get("shuffle_order"), cur, n) if shuffled else ([], [])
        if restored:
            tail = []               # every other row was played before the row we lost
        elif tail:
            return False            # shuffle still has rows to play
        for k, item in enumerate(items):
            out["used"] = k + 1
            if _same_track(item, track) or any(
                    isinstance(it, dict) and _same_track(it, item) for it in queue):
                continue
            row = {key: v for key, v in item.items() if key != "queue_index"}
            queue.append(row)
            if out["choice"] is None:
                order = None
                if shuffled:
                    order = _order_after(played, tail, cur, n)
                out["choice"] = (n, row, order)
            if not take_all:
                return True
        # (the lost row is back even when nothing follows it)
        return restored or out["choice"] is not None
    player.update_queue(username, client_device, mutate, fallback=False)
    return out["used"], out["choice"]


def _drop_appended(username: str, client_device: str, idx: int, item: dict,
                   tail: bool = False) -> None:
    """An appended autoplay row whose cast never went out (the client cast something
    itself): take it off again, if it is still the queue's last row and not current.
    `tail`: a radio batch — every row from `idx` on, if the batch still starts there
    and the pointer has not moved into it."""
    from app.services import player

    def mutate(data: dict):
        queue = data.get("queue")
        cur = data.get("current_index")
        if (not isinstance(queue, list) or len(queue) <= idx or not isinstance(queue[idx], dict)
                or not _same_track(queue[idx], item) or (isinstance(cur, int) and cur >= idx)):
            return False
        if not tail and len(queue) != idx + 1:
            return False
        del queue[idx:]
        return True
    try:
        player.update_queue(username, client_device, mutate, fallback=False)
    except Exception as e:
        logger.warning(f"DLNA: could not take the unused autoplay row back: {e!r}")


def _locate(queue: list, track: dict, saved_index) -> int | None:
    qi = track.get("queue_index", -1) if track else -1
    if isinstance(qi, int) and 0 <= qi < len(queue) and _same_track(queue[qi], track):
        return qi
    for i, it in enumerate(queue):
        if _same_track(it, track):
            return i
    return None


def _sync_order(order: dict | None, cur: int | None, n: int) -> tuple[list, list]:
    """The client's _syncShuffleOrder on positions: drop what is out of range or
    repeated, keep the current track out of the tail, and deal every queue position
    that is in neither list into the tail in random order."""
    order = order if isinstance(order, dict) else {}
    seen: set = set()

    def keep(lst):
        out = []
        for i in (lst if isinstance(lst, list) else []):
            if isinstance(i, int) and 0 <= i < n and i not in seen:
                seen.add(i)
                out.append(i)
        return out
    played = keep(order.get("played"))
    if cur is not None:
        seen.add(cur)
    tail = keep(order.get("tail"))
    fresh = [i for i in range(n) if i not in seen]
    random.shuffle(fresh)
    return played, tail + fresh


def _order_after(played: list, tail: list, cur: int | None, new: int) -> dict:
    """The order once `new` follows `cur` — the client's adoptShuffleIndex: the new
    track leaves BOTH lists, the current one goes on top of the played stack."""
    played = [i for i in played if i != new]
    tail = [i for i in tail if i != new]
    if cur is not None and cur != new and (not played or played[-1] != cur):
        played.append(cur)
    return {"played": played, "tail": tail}


class _QueueNotReadable(Exception):
    pass


async def _choose_next(session: dict):
    """_choose_next_any, passing over the rows a receiver cannot be given: a mix that is
    streamed from its site (`mix_url`) has no address but the exact URL, and the cast
    URL is built from title + artist — a title lookup that could land on another
    recording. Such a row is stepped past as if it had been played; it is not a dead
    track and does not count towards DEAD_TRACKS_LIMIT."""
    track = session.get("track")
    try:
        choice = await _choose_next_any(session)
        hops = 0
        while choice is not None and isinstance(choice[1], dict) and choice[1].get("mix_url") and hops < 200:
            hops += 1
            logger.info("DLNA: skipping %r — a mix streamed from its site cannot be cast",
                        str(choice[1].get("name"))[:60])
            session["track"] = {**choice[1], "queue_index": choice[0]}
            session["hint_used"] = True        # a hint that named a mix is spent
            choice = await _choose_next_any(session)
        return choice
    finally:
        session["track"] = track


async def _choose_next_any(session: dict):
    """(queue index, item, shuffle order to save or None) of what plays next, or None
    at the end of the queue. The client's hint first — it knows Smart Queue's pick —
    then the queue saved on the server, read the way the client plays it. Raises
    _QueueNotReadable when the device's queue file cannot be read right now."""
    from app.services import player
    track = session.get("track") or {}
    try:
        data = await asyncio.to_thread(player.load_queue, session["username"],
                                       session["client_device"], True)
    except Exception as e:
        raise _QueueNotReadable(repr(e)) from e
    queue = [it for it in (data.get("queue") or []) if isinstance(it, dict)]
    n = len(queue)
    cur = _locate(queue, track, data.get("current_index"))
    shuffle = bool(session.get("shuffle")) and n > 1
    repeat = session.get("repeat", "off")
    saved_order = data.get("shuffle_order") if shuffle else None
    # What this choice was made from — for the log line of the advance / the end.
    seen = session["last_choice"] = {"n": n, "cur": cur, "via": "queue",
                                     "radio": "yes" if data.get("radio_mode") else "no"}

    # Repeat one comes first: the same track again, whatever the hint names (the hint
    # stays for when repeat is switched off — the replay is a re-send, see _advance).
    if repeat == "one" and track.get("name"):
        if cur is not None:
            return cur, queue[cur], None
        return track.get("queue_index", -1), track, None

    hint = session.get("hint")
    if (hint and not session.get("hint_used") and hint.get("next")
            and hint.get("queue_index") == track.get("queue_index")):
        session["hint_used"] = True
        seen["via"] = "hint"
        nxt = hint["next"]
        qi = nxt.get("queue_index", -1)
        if not (isinstance(qi, int) and 0 <= qi < n and _same_track(queue[qi], nxt)):
            qi = next((i for i, it in enumerate(queue) if _same_track(it, nxt)), -1)
        order = None
        if shuffle and qi >= 0:
            played, tail = _sync_order(saved_order, cur, n)
            order = _order_after(played, tail, cur, qi)
        if qi >= 0 and queue[qi].get("mix_url"):
            nxt = queue[qi]     # the hint does not carry mix_url; the saved row does
        return qi, nxt, order

    if cur is None or not n:
        return None
    if shuffle:
        played, tail = _sync_order(saved_order, cur, n)
        if tail:
            return tail[0], queue[tail[0]], _order_after(played, tail, cur, tail[0])
        if repeat == "all":
            # Exhausted: deal a fresh permutation, as the client does.
            played, tail = _sync_order(None, cur, n)
            return tail[0], queue[tail[0]], _order_after([], tail, cur, tail[0])
        return None
    if cur + 1 < n:
        return cur + 1, queue[cur + 1], None
    if repeat == "all":
        return 0, queue[0], None
    return None


def _write_queue_position(username: str, client_device: str, idx: int, item: dict,
                          order: dict | None) -> bool:
    """After a server advance, move the saved queue's pointer (and shuffle order) so a
    page that wakes up reads where playback really is. Only these fields change, and
    only if the queue still holds that track at that place. Done under the queue lock
    (player.update_queue), so a client PUT is never overwritten by stale contents."""
    from app.services import player

    def mutate(data: dict):
        queue = data.get("queue") or []
        if not (isinstance(idx, int) and 0 <= idx < len(queue)) or not _same_track(queue[idx], item):
            return False
        data["current_index"] = idx
        data["position_seconds"] = 0.0
        if order is not None:
            data["shuffle_order"] = order
        return True
    try:
        return player.update_queue(username, client_device, mutate)
    except Exception as e:
        logger.warning(f"DLNA: could not save the queue position: {e!r}")
        return False


# ── Surviving a restart ──

_persist_seq = 0
_persist_written = 0
_persist_tlock = threading.Lock()


def _snapshot() -> dict:
    out = {}
    wall, mono = time.time(), _now()
    for key, s in _sessions.items():
        dev = s.get("device")
        if not dev or not s.get("dmr") or not s.get("username") or not s.get("follow"):
            continue
        f = s["f"]
        out[key] = {
            "username": s["username"],
            "client_device": s["client_device"],
            "device": {k: dev.get(k) for k in ("udn", "location", "name", "ip")},
            "track": s.get("track"),
            "hint": s.get("hint"),
            "hint_used": s.get("hint_used", False),
            "autoplay": list(s.get("autoplay") or []),
            "autoplay_after": s.get("autoplay_after"),
            "autoplay_seen": bool(s.get("autoplay_seen")),
            "radio_from": s.get("radio_from"),
            "repeat": s.get("repeat", "off"),
            "shuffle": s.get("shuffle", False),
            "cast_seq": s.get("cast_seq", 0),
            "duration_seconds": s.get("duration_seconds", 0),
            "queue_ended": s.get("queue_ended", False),
            "dead_tracks": s.get("dead_tracks", 0),
            "saved_wall": wall,
            "session_id": s.get("session_id"),
            # When it stopped PLAYING (None: playing at save time).
            "idle_wall": (wall - (mono - s["idle_since"])) if s.get("idle_since") is not None else None,
            "queue_ended_wall": ((wall - (mono - s["queue_ended_at"]))
                                 if s.get("queue_ended_at") is not None else None),
            "renderer_dur": f.get("renderer_dur", 0),
            "played": f["played"],
            "started": f["started"],
            "start_pos": f["start_pos"],
            "last_pos": f["last_pos"],
            "last_pos_wall": wall - (mono - f["last_pos_at"]),
            "last_playing": f["last_playing"],
            "max_pos": f["max_pos"],
            "play_time": f["play_time"],
        }
    return out


def _write_sessions(seq: int, snap: dict) -> None:
    global _persist_written
    with _persist_tlock:
        if seq < _persist_written:
            return          # a newer snapshot is already on disk
        path = Path(SESSIONS_FILE)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(snap))
            os.replace(tmp, path)
            _persist_written = seq
        except OSError as e:
            logger.warning(f"DLNA: could not save cast sessions: {e!r}")


async def _persist() -> None:
    global _persist_seq
    _persist_seq += 1
    await asyncio.to_thread(_write_sessions, _persist_seq, _snapshot())


def _read_sessions() -> dict:
    try:
        data = json.loads(Path(SESSIONS_FILE).read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# While resume_sessions runs, a status for a session it may still bring back says
# "resuming" instead of "inactive": the page would otherwise end the cast on its side.
_resume_pending = False            # before the saved file has been read: every key
_resuming: set[str] = set()        # read, not finished yet


def mark_resume_pending() -> None:
    """Called at startup before resume_sessions is scheduled, so not even the first
    request after a restart can see a bare "inactive"."""
    global _resume_pending
    _resume_pending = True


def is_resuming(session_key: str) -> bool:
    return _resume_pending or session_key in _resuming


async def resume_sessions() -> int:
    """After a restart: reconnect to the renderers of the casts that were active and
    follow them again. A renderer that does not answer drops its session."""
    global _resume_pending
    _resume_pending = True
    try:
        saved = await asyncio.to_thread(_read_sessions)
        _resuming.update(saved.keys())
    finally:
        _resume_pending = False
    resumed = 0
    for key, e in saved.items():
        try:
            if await _resume_one(key, e):
                resumed += 1
        except Exception as ex:
            logger.warning(f"DLNA: could not resume cast {key}: {ex!r}")
        finally:
            _resuming.discard(key)
    if saved:
        logger.info(f"DLNA: resumed {resumed} of {len(saved)} cast session(s)")
        await _persist()
    return resumed


async def _resume_one(key: str, e: dict) -> bool:
    if key in _sessions or not isinstance(e, dict):
        return False
    dev = e.get("device") or {}
    udn, location = dev.get("udn"), dev.get("location")
    if not udn or not location or not e.get("username"):
        return False
    stale = _resume_too_late(e)
    if stale:
        logger.info(f"DLNA: not resuming the cast to {dev.get('name') or location}: {stale}")
        return False
    known = _find_device(udn)
    if known:
        location = known["location"]
    if not _is_safe_renderer_url(location):
        return False
    from async_upnp_client.profiles.dlna import DmrDevice
    factory = await _get_factory()
    if not factory:
        return False
    try:
        upnp_device = await asyncio.wait_for(factory.async_create_device(location),
                                             timeout=RESUME_CONNECT_TIMEOUT)
    except Exception as ex:
        logger.info(f"DLNA: {dev.get('name') or location} not reachable, dropping its cast: {ex!r}")
        return False
    if (getattr(upnp_device, "udn", None) or udn) != udn:
        logger.info(f"DLNA: another renderer answers at {location}, dropping the cast")
        return False
    # The connect took a while: a client may have cast meanwhile — to this session or,
    # from another device, to this renderer. Its state is newer than the saved one.
    if key in _sessions or any((s.get("device") or {}).get("udn") == udn for s in _sessions.values()):
        logger.info(f"DLNA: a new cast came in while resuming {key}, keeping that one")
        return False
    device = known or _register_device(location, upnp_device)
    session = _get_session(key)
    session.update({
        "dmr": DmrDevice(upnp_device, None),
        "device": device,
        "username": e["username"],
        "client_device": e.get("client_device") or "default",
        "track": e.get("track"),
        "hint": e.get("hint"),
        "hint_used": bool(e.get("hint_used")),
        "autoplay": _clean_autoplay(e.get("autoplay")),
        "autoplay_after": ({"name": str(e["autoplay_after"].get("name") or "")[:500],
                            "artist": str(e["autoplay_after"].get("artist") or "")[:500]}
                           if isinstance(e.get("autoplay_after"), dict) else None),
        "autoplay_seen": bool(e.get("autoplay_seen")),
        "radio_from": e.get("radio_from") if isinstance(e.get("radio_from"), int) else None,
        "repeat": _norm_repeat(e.get("repeat")),
        "shuffle": bool(e.get("shuffle")),
        "cast_seq": int(e.get("cast_seq") or 0),
        "duration_seconds": e.get("duration_seconds") or 0,
        "queue_ended": bool(e.get("queue_ended")),
        "dead_tracks": int(e.get("dead_tracks") or 0),
        "follow": True,
    })
    now = _now()
    f = _fresh_follow(now)
    f["played"] = bool(e.get("played"))
    f["started"] = bool(e.get("started", e.get("played")))
    f["start_pos"] = float(e.get("start_pos") or 0)
    f["last_pos"] = float(e.get("last_pos") or 0)
    # The restart gap is carried over: a track that was playing and ended while we
    # were down is seen as ended, not as stopped half-way.
    f["last_pos_at"] = now - max(0.0, time.time() - float(e.get("last_pos_wall") or time.time()))
    f["last_playing"] = bool(e.get("last_playing"))
    f["max_pos"] = float(e.get("max_pos") or 0)
    f["play_time"] = float(e.get("play_time") or 0)
    f["reset_at"] = now - 1.0
    session["f"] = f
    session["last_pos"] = f["last_pos"]
    f["renderer_dur"] = float(e.get("renderer_dur") or 0)
    wall = time.time()
    if e.get("session_id"):
        session["session_id"] = str(e["session_id"])
    session["last_ok_at"] = now
    iw = e.get("idle_wall") if "idle_wall" in e else (None if e.get("last_playing") else e.get("saved_wall"))
    session["idle_since"] = (now - max(0.0, wall - float(iw))) if iw is not None else None
    qw = e.get("queue_ended_wall")
    session["queue_ended_at"] = ((now - max(0.0, wall - float(qw))) if qw is not None
                                 else (now if session["queue_ended"] else None))
    if not session["queue_ended"]:
        _ensure_follower(key, session)
    return True


def _resume_too_late(e: dict) -> str | None:
    """Why a saved session must not be followed again after this long a restart, or
    None. A track that was playing can only have ended within its remaining length;
    a far longer gap means the receiver has long since moved on (another input, off),
    and casting the next track there would be a surprise, not a continuation."""
    wall = time.time()
    try:
        dur = float(e.get("duration_seconds") or 0)
        last_pos = float(e.get("last_pos") or 0)
        pos_wall = float(e.get("last_pos_wall") or wall)
        saved_wall = float(e.get("saved_wall") or pos_wall)
    except (TypeError, ValueError):
        return "unreadable entry"
    was_playing = (e.get("idle_wall") is None and bool(e.get("played"))) if "idle_wall" in e \
        else bool(e.get("played") and e.get("last_playing"))
    if was_playing:
        limit = (max(0.0, dur - last_pos) if dur > 0 else 0.0) + RESUME_END_SLACK
        if wall - pos_wall > limit:
            return f"down {wall - pos_wall:.0f} s, longer than the rest of the track"
        return None
    # Not playing at save time (paused, stopped, queue played out, not started yet):
    # only a session idle for less than IDLE_EXPIRE comes back.
    try:
        idle_wall = float(e.get("idle_wall") or saved_wall)
    except (TypeError, ValueError):
        return "unreadable entry"
    if wall - idle_wall >= IDLE_EXPIRE:
        return f"idle for {wall - idle_wall:.0f} s"
    if not e.get("started", e.get("played")) and wall - saved_wall > RESUME_END_SLACK:
        return f"down {wall - saved_wall:.0f} s before the track had started"
    return None


def _build_didl_metadata(title: str, artist: str, album: str, image: str,
                          duration_ms: int, stream_url: str, mime: str = "audio/flac") -> str:
    dur_str = ""
    if duration_ms > 0:
        s = duration_ms // 1000
        dur_str = f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"

    from xml.sax.saxutils import escape
    meta = f'''<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="0" restricted="1">
    <dc:title>{escape(title)}</dc:title>
    <dc:creator>{escape(artist)}</dc:creator>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <upnp:artist>{escape(artist)}</upnp:artist>
    <upnp:album>{escape(album)}</upnp:album>
    {f'<upnp:albumArtURI>{escape(image)}</upnp:albumArtURI>' if image else ''}
    <res protocolInfo="http-get:*:{mime}:*"{f' duration="{dur_str}"' if dur_str else ''}>{escape(stream_url)}</res>
  </item>
</DIDL-Lite>'''
    return meta
