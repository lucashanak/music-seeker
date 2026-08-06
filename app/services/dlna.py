"""DLNA/UPnP service: discover renderers on LAN and control playback."""

import asyncio
import ipaddress
import logging
import os
import socket
from urllib.parse import quote, urlparse

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


_EXT_MIME = {"flac": "audio/flac", "mp3": "audio/mpeg", "opus": "audio/ogg",
             "m4a": "audio/mp4", "wav": "audio/wav", "aiff": "audio/aiff", "aac": "audio/aac"}


async def _resolve_cast_mime(name: str, artist: str) -> str:
    """Best-effort MIME for the DIDL protocolInfo so renderers (Onkyo) don't reject a
    stream whose advertised type doesn't match the bytes. Falls back to audio/flac.
    Capped so a slow yt-dlp resolve can't starve the cast's Play-retry budget."""
    try:
        from app.services import player
        res = await asyncio.wait_for(player.resolve_stream(name, artist), timeout=8)
        if not res:
            return "audio/flac"
        if res["source"] == "local":
            ext = res["path"].rsplit(".", 1)[-1].lower() if "." in res["path"] else ""
            return _EXT_MIME.get(ext, "audio/flac")
        if res["source"] == "navidrome":
            return "audio/flac"   # cast uses quality=lossless → Navidrome serves FLAC
        return "audio/mpeg"       # YouTube source is transcoded to MP3
    except Exception:
        return "audio/flac"

# ── State ──
_devices: dict[str, dict] = {}  # location_url -> {name, ip, location, udn, upnp_device}
_listener_task = None
_requester = None
_factory = None

# Per-session cast state (keyed by "{username}:{device_id}")
_sessions: dict[str, dict] = {}  # Each: {dmr, device, lock, generation, transitioning}

# Server URL for DLNA renderer to fetch audio from
DLNA_SERVER_URL = os.environ.get("DLNA_SERVER_URL", "")


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
        # Non-blocking: add renderer in background
        asyncio.create_task(_add_manual_renderer(manual_url))
    else:
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
        _devices[url] = {
            "name": device.friendly_name or url,
            "location": url,
            "udn": device.udn or url,
            "ip": url.split("//")[1].split(":")[0] if "//" in url else "",
            "upnp_device": device,
        }
        logger.info(f"DLNA: manual renderer added: {device.friendly_name}")
    except Exception as e:
        logger.warning(f"DLNA: failed to add manual renderer {url}: {e}")


async def _run_discovery():
    try:
        while True:
            try:
                factory = await _get_factory()
                if not factory:
                    break
                from async_upnp_client.search import async_search
                devices_found = await async_search(
                    search_target="urn:schemas-upnp-org:device:MediaRenderer:1",
                    timeout=10,
                )
                for entry in devices_found:
                    location = entry.get("location", "")
                    if not location or location in _devices:
                        continue
                    try:
                        device = await factory.async_create_device(location)
                        _devices[location] = {
                            "name": device.friendly_name or location,
                            "location": location,
                            "udn": device.udn or location,
                            "ip": location.split("//")[1].split(":")[0] if "//" in location else "",
                            "upnp_device": device,
                        }
                    except Exception:
                        pass
                if _devices:
                    logger.info(f"DLNA: {len(_devices)} renderer(s): {[d['name'] for d in _devices.values()]}")
            except Exception as e:
                logger.warning(f"DLNA discovery error: {e}")
            await asyncio.sleep(30)
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
        if url in _devices:
            found.append(_devices[url])
            continue
        try:
            if factory:
                device = await asyncio.wait_for(factory.async_create_device(url), timeout=5)
                dev = {
                    "name": device.friendly_name or url,
                    "location": url,
                    "udn": device.udn or url,
                    "ip": url.split("//")[1].split(":")[0],
                    "upnp_device": device,
                }
                _devices[url] = dev
                found.append(dev)
        except Exception:
            found.append({"name": url, "location": url, "udn": url, "ip": url.split("//")[1].split(":")[0]})

    return found


def _get_session(session_key: str) -> dict:
    """Get or create a per-device cast session."""
    if session_key not in _sessions:
        # Bound the map — evict the oldest-inserted session if at the cap.
        if len(_sessions) >= _MAX_SESSIONS:
            _sessions.pop(next(iter(_sessions)), None)
        _sessions[session_key] = {
            "dmr": None,
            "device": None,
            "lock": asyncio.Lock(),
            "generation": 0,
            "transitioning": False,
        }
    return _sessions[session_key]


async def cast_to_device(session_key: str, device_id: str, name: str, artist: str, token: str,
                          album: str = "", image: str = "", duration_ms: int = 0) -> bool:
    session = _get_session(session_key)

    # Find device
    device = None
    for d in _devices.values():
        if d["udn"] == device_id:
            device = d
            break
    if not device:
        return False

    # Increment generation — any older cast in progress will abort
    session["generation"] += 1
    my_gen = session["generation"]
    session["transitioning"] = True
    # Remember the client-provided duration — renderers (Onkyo) often report
    # TrackDuration=0/NOT_IMPLEMENTED, so get_status falls back to this.
    session["duration_seconds"] = (duration_ms / 1000) if duration_ms else 0

    async with session["lock"]:
        if my_gen != session["generation"]:
            logger.info(f"DLNA: cast '{name}' superseded, skipping")
            return False

        try:
            from async_upnp_client.profiles.dlna import DmrDevice

            # Reuse DMR for same device, create fresh only if device changed.
            # Use the shared factory/requester (was creating a new AiohttpRequester per
            # cast → leaked an aiohttp ClientSession on every device change).
            if not session["dmr"] or session["device"] != device:
                factory = await _get_factory()
                upnp_device = await asyncio.wait_for(
                    factory.async_create_device(device["location"]), timeout=10
                )
                session["dmr"] = DmrDevice(upnp_device, None)

            if my_gen != session["generation"]:
                session["transitioning"] = False
                return False

            base = _get_server_url()
            mime = await _resolve_cast_mime(name, artist)
            stream_url = f"{base}/api/player/stream?name={quote(name)}&artist={quote(artist)}&token={quote(token)}&quality=lossless"
            metadata = _build_didl_metadata(name, artist, album, image, duration_ms, stream_url, mime)

            # Per UPnP spec: SetAVTransportURI works in any state (including PLAYING)
            # No need to Stop first — the renderer handles the transition internally
            await asyncio.wait_for(
                session["dmr"].async_set_transport_uri(stream_url, metadata), timeout=15
            )

            if my_gen != session["generation"]:
                session["transitioning"] = False
                return False

            # Retry Play with increasing delays — Onkyo needs time after SetAVTransportURI
            played = False
            for attempt in range(5):
                if my_gen != session["generation"]:
                    session["transitioning"] = False
                    return False
                await asyncio.sleep(1 + attempt * 0.5)  # 1s, 1.5s, 2s, 2.5s, 3s
                try:
                    await asyncio.wait_for(session["dmr"].async_play(), timeout=5)
                    played = True
                    break
                except Exception as e:
                    if "701" in str(e) and attempt < 4:
                        logger.debug(f"DLNA: Play attempt {attempt+1} failed (701), retrying...")
                        continue
                    raise
            if not played:
                raise RuntimeError("Play failed after retries")

            session["device"] = device
            session["transitioning"] = False
            logger.info(f"DLNA: [{session_key}] casting '{artist} - {name}' to {device['name']}")
            return True
        except Exception as e:
            import traceback
            logger.error(f"DLNA cast error: {e}\n{traceback.format_exc()}")
            return False
        finally:
            # Never leave the session wedged in TRANSITIONING (e.g. on task cancellation).
            if session.get("generation") == my_gen:
                session["transitioning"] = False


async def play(session_key: str) -> bool:
    session = _sessions.get(session_key)
    if not session or not session["dmr"]:
        return False
    try:
        await session["dmr"].async_play()
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
        return True
    except Exception as e:
        logger.warning(f"DLNA pause error: {e}")
        return False


async def stop(session_key: str) -> bool:
    session = _sessions.get(session_key)
    if not session or not session["dmr"]:
        return False
    try:
        session["transitioning"] = False
        await session["dmr"].async_stop()
        session["device"] = None
        session["dmr"] = None
        _sessions.pop(session_key, None)  # evict — don't accumulate dead sessions
        return True
    except Exception as e:
        logger.warning(f"DLNA stop error: {e}")
        return False


async def seek(session_key: str, position_seconds: float) -> bool:
    session = _sessions.get(session_key)
    if not session or not session["dmr"]:
        return False
    dmr = session["dmr"]
    try:
        h = int(position_seconds // 3600)
        m = int((position_seconds % 3600) // 60)
        s = int(position_seconds % 60)
        target = f"{h:02d}:{m:02d}:{s:02d}"
        # Try absolute seek first, then relative
        try:
            await dmr.async_seek_abs_time(target)
        except Exception:
            try:
                await dmr.async_seek_rel_time(target)
            except Exception:
                # Direct action call as fallback
                srv = dmr.device.services.get("urn:schemas-upnp-org:service:AVTransport:2") or \
                      dmr.device.services.get("urn:schemas-upnp-org:service:AVTransport:1")
                if srv:
                    action = srv.action("Seek")
                    try:
                        await action.async_call(InstanceID=0, Unit="ABS_TIME", Target=target)
                    except Exception:
                        await action.async_call(InstanceID=0, Unit="REL_TIME", Target=target)
                else:
                    return False
        return True
    except Exception as e:
        logger.warning(f"DLNA seek error: {e}")
        return False


async def set_volume(session_key: str, volume: int) -> bool:
    session = _sessions.get(session_key)
    if not session or not session["dmr"]:
        return False
    try:
        await session["dmr"].async_set_volume_level(volume / 100.0)
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


async def get_status(session_key: str) -> dict | None:
    session = _sessions.get(session_key)
    if not session or not session["dmr"] or not session["device"]:
        if session and session["transitioning"]:
            return {"device": "transitioning", "state": "TRANSITIONING",
                    "position_seconds": 0, "duration_seconds": 0, "volume": 0}
        return None
    dmr = session["dmr"]
    sess_dur = session.get("duration_seconds", 0)
    try:
        info = {
            "device": session["device"]["name"],
            "state": "unknown",
            "transport_status": "",
            "position_seconds": 0,
            "duration_seconds": 0,
            "volume": 0,
        }
        # Query transport info directly via UPnP actions
        av_srv = dmr.device.services.get("urn:schemas-upnp-org:service:AVTransport:2") or \
                 dmr.device.services.get("urn:schemas-upnp-org:service:AVTransport:1")
        rc_srv = dmr.device.services.get("urn:schemas-upnp-org:service:RenderingControl:2") or \
                 dmr.device.services.get("urn:schemas-upnp-org:service:RenderingControl:1")

        if av_srv:
            try:
                ti = av_srv.action("GetTransportInfo")
                result = await asyncio.wait_for(ti.async_call(InstanceID=0), timeout=3)
                info["state"] = result.get("CurrentTransportState", "unknown")
                info["transport_status"] = result.get("CurrentTransportStatus", "")
            except Exception:
                pass
            try:
                pi = av_srv.action("GetPositionInfo")
                result = await asyncio.wait_for(pi.async_call(InstanceID=0), timeout=3)
                info["position_seconds"] = _parse_time(result.get("RelTime", "0:00:00"))
                info["duration_seconds"] = _parse_time(result.get("TrackDuration", "0:00:00"))
            except Exception:
                pass

        if rc_srv:
            try:
                gv = rc_srv.action("GetVolume")
                result = await asyncio.wait_for(gv.async_call(InstanceID=0, Channel="Master"), timeout=3)
                info["volume"] = int(result.get("CurrentVolume", 0))
            except Exception:
                pass

        # Fall back to the client-provided duration when the renderer reports none.
        if not info["duration_seconds"] and sess_dur:
            info["duration_seconds"] = sess_dur
        session["stale_count"] = 0
        return info
    except Exception:
        # Transient query failure — keep the session ALIVE for a few ticks (returning
        # None makes the frontend tear the cast down mid-playlist). But after sustained
        # failure (renderer powered off / crashed) allow teardown so the UI recovers.
        session["stale_count"] = session.get("stale_count", 0) + 1
        if session["stale_count"] >= 5:
            return None
        return {"device": session["device"]["name"], "state": "unknown",
                "transport_status": "", "position_seconds": 0,
                "duration_seconds": sess_dur, "volume": 0, "stale": True}


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
