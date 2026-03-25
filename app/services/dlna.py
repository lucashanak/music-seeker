"""DLNA/UPnP service: discover renderers on LAN and control playback."""

import asyncio
import logging
import os
import socket
from urllib.parse import quote

logger = logging.getLogger("musicseeker.dlna")

# ── State ──
_devices: dict[str, dict] = {}  # location_url -> {name, ip, location, udn, ...}
_active_device: dict | None = None  # currently casting to
_dmr = None  # DmrDevice instance
_listener_task = None

# Server URL for DLNA renderer to fetch audio from
DLNA_SERVER_URL = os.environ.get("DLNA_SERVER_URL", "")


def _get_server_url() -> str:
    """Get the base URL that DLNA renderers can reach this server at."""
    if DLNA_SERVER_URL:
        return DLNA_SERVER_URL.rstrip("/")
    # Auto-detect: get local IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return f"http://{ip}:8090"
    except Exception:
        return "http://localhost:8090"


def get_devices() -> list[dict]:
    """Return list of discovered DLNA renderers."""
    return [
        {"id": d["udn"], "name": d["name"], "ip": d.get("ip", ""), "location": d["location"]}
        for d in _devices.values()
    ]


async def start_discovery():
    """Start SSDP discovery or use manual renderer URL from settings."""
    global _listener_task
    if _listener_task:
        return

    # Check for manual renderer URL in settings
    from app.services import settings as app_settings
    manual_url = app_settings._settings.get("dlna_renderer_url", "")
    if manual_url:
        await _add_manual_renderer(manual_url)
    else:
        _listener_task = asyncio.create_task(_run_discovery())
    logger.info("DLNA discovery started")


async def _add_manual_renderer(url: str):
    """Add a renderer from a manually configured description URL."""
    try:
        from async_upnp_client.aiohttp import AiohttpRequester
        from async_upnp_client.client_factory import UpnpFactory

        requester = AiohttpRequester()
        factory = UpnpFactory(requester)
        device = await factory.async_create_device(url)
        _devices[url] = {
            "name": device.friendly_name or url,
            "location": url,
            "udn": device.udn or url,
            "ip": url.split("//")[1].split(":")[0] if "//" in url else "",
        }
        logger.info(f"DLNA: manual renderer added: {device.friendly_name}")
    except Exception as e:
        logger.warning(f"DLNA: failed to add manual renderer {url}: {e}")


async def _run_discovery():
    """Run SSDP discovery loop."""
    try:
        from async_upnp_client.search import async_search
        from async_upnp_client.aiohttp import AiohttpRequester

        while True:
            try:
                requester = AiohttpRequester()
                devices_found = await async_search(
                    search_target="urn:schemas-upnp-org:device:MediaRenderer:1",
                    timeout=10,
                )
                new_devices = {}
                for entry in devices_found:
                    location = entry.get("location", "")
                    if not location:
                        continue
                    udn = entry.get("usn", location)
                    # Extract friendly name from headers or use default
                    name = entry.get("_host", "") or location
                    new_devices[location] = {
                        "name": name,
                        "location": location,
                        "udn": udn,
                        "ip": entry.get("_host", ""),
                    }

                # Try to get friendly names from device descriptions
                for loc, dev in new_devices.items():
                    if dev["name"] == loc or not dev["name"]:
                        try:
                            from async_upnp_client.client_factory import UpnpFactory
                            factory = UpnpFactory(requester)
                            device = await factory.async_create_device(loc)
                            dev["name"] = device.friendly_name or loc
                            dev["udn"] = device.udn or dev["udn"]
                        except Exception:
                            pass

                _devices.clear()
                _devices.update(new_devices)
                if new_devices:
                    logger.info(f"DLNA: found {len(new_devices)} renderer(s): {[d['name'] for d in new_devices.values()]}")
            except Exception as e:
                logger.warning(f"DLNA discovery error: {e}")

            await asyncio.sleep(30)  # re-scan every 30s
    except ImportError:
        logger.warning("async-upnp-client not installed, DLNA disabled")
    except asyncio.CancelledError:
        pass


async def cast_to_device(device_id: str, name: str, artist: str, token: str,
                          album: str = "", image: str = "", duration_ms: int = 0) -> bool:
    """Send a track to a DLNA renderer and start playback."""
    global _active_device, _dmr

    # Find device
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

        requester = AiohttpRequester()
        factory = UpnpFactory(requester)
        upnp_device = await factory.async_create_device(device["location"])
        _dmr = DmrDevice(upnp_device, None)

        # Build stream URL
        base = _get_server_url()
        stream_url = f"{base}/api/player/stream?name={quote(name)}&artist={quote(artist)}&token={quote(token)}"

        # Build DIDL-Lite metadata
        metadata = _build_didl_metadata(name, artist, album, image, duration_ms, stream_url)

        # Set URI and play
        await _dmr.async_set_transport_uri(stream_url, metadata)
        await _dmr.async_play()

        _active_device = device
        logger.info(f"DLNA: casting '{artist} - {name}' to {device['name']}")
        return True
    except Exception as e:
        logger.error(f"DLNA cast error: {e}")
        _dmr = None
        _active_device = None
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
        await _dmr.async_seek_rel_time(target)
        return True
    except Exception:
        return False


async def set_volume(volume: int) -> bool:
    if not _dmr:
        return False
    try:
        await _dmr.async_set_volume_level(volume / 100.0)
        return True
    except Exception:
        return False


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
        # Transport info
        try:
            state = _dmr.transport_state
            info["state"] = state or "unknown"
        except Exception:
            pass
        # Position
        try:
            pos = _dmr.media_position
            if pos is not None:
                info["position_seconds"] = pos.total_seconds() if hasattr(pos, 'total_seconds') else float(pos)
        except Exception:
            pass
        # Duration
        try:
            dur = _dmr.media_duration
            if dur is not None:
                info["duration_seconds"] = dur.total_seconds() if hasattr(dur, 'total_seconds') else float(dur)
        except Exception:
            pass
        # Volume
        try:
            vol = _dmr.volume_level
            if vol is not None:
                info["volume"] = int(vol * 100)
        except Exception:
            pass
        return info
    except Exception:
        return None


def _build_didl_metadata(title: str, artist: str, album: str, image: str,
                          duration_ms: int, stream_url: str) -> str:
    """Build DIDL-Lite XML metadata for DLNA renderer."""
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
    <upnp:artist>{escape(artist)}</upnp:artist>
    <upnp:album>{escape(album)}</upnp:album>
    {f'<upnp:albumArtURI>{escape(image)}</upnp:albumArtURI>' if image else ''}
    <res protocolInfo="http-get:*:audio/mpeg:*"{f' duration="{dur_str}"' if dur_str else ''}>{escape(stream_url)}</res>
  </item>
</DIDL-Lite>'''
    return meta
