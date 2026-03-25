"""DLNA/UPnP service: discover renderers on LAN and control playback."""

import asyncio
import logging
import os
import socket
from urllib.parse import quote

logger = logging.getLogger("musicseeker.dlna")

# ── State ──
_devices: dict[str, dict] = {}  # location_url -> {name, ip, location, udn, upnp_device}
_active_device: dict | None = None  # currently casting to
_dmr = None  # DmrDevice instance
_listener_task = None
_requester = None
_factory = None

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
    sem = asyncio.Semaphore(50)  # High concurrency — probes are fast TCP connects

    async def probe(ip: str, port: int, path: str):
        url = f"http://{ip}:{port}{path}"
        async with sem:
            try:
                async with httpx.AsyncClient(timeout=0.8) as client:
                    resp = await client.get(url)
                    if resp.status_code == 200 and "MediaRenderer" in resp.text:
                        return url
            except Exception:
                pass
        return None

    # Probe IPs 1-254 on all port/path combos
    tasks = []
    for i in range(1, 255):
        ip = f"{gateway_ip}.{i}"
        for port in ports:
            for path in paths:
                tasks.append(probe(ip, port, path))

    results = await asyncio.gather(*tasks)
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


async def cast_to_device(device_id: str, name: str, artist: str, token: str,
                          album: str = "", image: str = "", duration_ms: int = 0) -> bool:
    global _active_device, _dmr

    # Find device with cached upnp_device
    device = None
    for d in _devices.values():
        if d["udn"] == device_id:
            device = d
            break
    if not device:
        return False

    try:
        from async_upnp_client.aiohttp import AiohttpRequester
        from async_upnp_client.client_factory import UpnpFactory
        from async_upnp_client.profiles.dlna import DmrDevice

        # Reuse existing DMR if same device, otherwise create new
        if not _dmr or _active_device != device:
            requester = AiohttpRequester()
            factory = UpnpFactory(requester)
            upnp_device = await asyncio.wait_for(
                factory.async_create_device(device["location"]), timeout=10
            )
            _dmr = DmrDevice(upnp_device, None)

        base = _get_server_url()
        stream_url = f"{base}/api/player/stream?name={quote(name)}&artist={quote(artist)}&token={quote(token)}"
        metadata = _build_didl_metadata(name, artist, album, image, duration_ms, stream_url)

        # Stop current playback first (avoids 701 Transition not available)
        try:
            await asyncio.wait_for(_dmr.async_stop(), timeout=3)
        except Exception:
            pass
        await asyncio.sleep(1)

        await asyncio.wait_for(
            _dmr.async_set_transport_uri(stream_url, metadata), timeout=15
        )
        await asyncio.sleep(1)  # Onkyo needs time to process URI before Play

        # Retry Play up to 3 times (Onkyo can be slow to transition)
        for attempt in range(3):
            try:
                await asyncio.wait_for(_dmr.async_play(), timeout=5)
                break
            except Exception:
                if attempt < 2:
                    await asyncio.sleep(1)
                else:
                    raise

        _active_device = device
        logger.info(f"DLNA: casting '{artist} - {name}' to {device['name']}")
        return True
    except Exception as e:
        import traceback
        logger.error(f"DLNA cast error: {e}\n{traceback.format_exc()}")
        return False


async def play() -> bool:
    if not _dmr:
        return False
    try:
        await _dmr.async_play()
        return True
    except Exception:
        return False


async def pause() -> bool:
    if not _dmr:
        return False
    try:
        await _dmr.async_pause()
        return True
    except Exception:
        return False


async def stop() -> bool:
    global _active_device, _dmr
    if not _dmr:
        return False
    try:
        await _dmr.async_stop()
        _active_device = None
        _dmr = None
        return True
    except Exception:
        return False


async def seek(position_seconds: float) -> bool:
    if not _dmr:
        return False
    try:
        h = int(position_seconds // 3600)
        m = int((position_seconds % 3600) // 60)
        s = int(position_seconds % 60)
        target = f"{h:02d}:{m:02d}:{s:02d}"
        # Try absolute seek first, then relative
        try:
            await _dmr.async_seek_abs_time(target)
        except Exception:
            try:
                await _dmr.async_seek_rel_time(target)
            except Exception:
                # Direct action call as fallback
                srv = _dmr.device.services.get("urn:schemas-upnp-org:service:AVTransport:2") or \
                      _dmr.device.services.get("urn:schemas-upnp-org:service:AVTransport:1")
                if srv:
                    action = srv.action("Seek")
                    await action.async_call(InstanceID=0, Unit="ABS_TIME", Target=target)
                else:
                    return False
        return True
    except Exception as e:
        logger.warning(f"DLNA seek error: {e}")
        return False


async def set_volume(volume: int) -> bool:
    if not _dmr:
        return False
    try:
        await _dmr.async_set_volume_level(volume / 100.0)
        return True
    except Exception:
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


async def get_status() -> dict | None:
    if not _dmr or not _active_device:
        return None
    try:
        info = {
            "device": _active_device["name"],
            "state": "unknown",
            "position_seconds": 0,
            "duration_seconds": 0,
            "volume": 0,
        }
        # Query transport info directly via UPnP actions
        av_srv = _dmr.device.services.get("urn:schemas-upnp-org:service:AVTransport:2") or \
                 _dmr.device.services.get("urn:schemas-upnp-org:service:AVTransport:1")
        rc_srv = _dmr.device.services.get("urn:schemas-upnp-org:service:RenderingControl:2") or \
                 _dmr.device.services.get("urn:schemas-upnp-org:service:RenderingControl:1")

        if av_srv:
            try:
                ti = av_srv.action("GetTransportInfo")
                result = await ti.async_call(InstanceID=0)
                info["state"] = result.get("CurrentTransportState", "unknown")
            except Exception:
                pass
            try:
                pi = av_srv.action("GetPositionInfo")
                result = await pi.async_call(InstanceID=0)
                info["position_seconds"] = _parse_time(result.get("RelTime", "0:00:00"))
                info["duration_seconds"] = _parse_time(result.get("TrackDuration", "0:00:00"))
            except Exception:
                pass

        if rc_srv:
            try:
                gv = rc_srv.action("GetVolume")
                result = await gv.async_call(InstanceID=0, Channel="Master")
                info["volume"] = int(result.get("CurrentVolume", 0))
            except Exception:
                pass

        return info
    except Exception:
        return None


def _build_didl_metadata(title: str, artist: str, album: str, image: str,
                          duration_ms: int, stream_url: str) -> str:
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
    <res protocolInfo="http-get:*:audio/mpeg:*"{f' duration="{dur_str}"' if dur_str else ''}>{escape(stream_url)}</res>
  </item>
</DIDL-Lite>'''
    return meta
