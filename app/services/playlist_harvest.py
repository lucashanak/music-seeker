"""Harvest a *whole* public Spotify playlist by driving a headless browser.

Why this exists: `playlist_import` tops out at 100 tracks because that is all the
public embed page carries. The real page (`open.spotify.com/playlist/<id>`) shows
the full list to a logged-out visitor — the web player pulls it from a private,
TOTP-guarded endpoint that we deliberately do NOT call ourselves. So instead of
imitating that endpoint we let a real browser load the public page and scroll it,
exactly like a human visitor's browser does, and read the rendered DOM.

The browser is a separate container (`zenika/alpine-chrome`, ~78 MB idle) spoken
to over the DevTools protocol; `BROWSER_CDP_URL` points at it. When it is absent
this whole module raises `HarvestUnavailable` and the caller falls back to the
manual paste helper — the feature degrades, it never 500s.

Two CDP facts worth keeping in mind before editing:

* Chrome answers **HTTP 500** to any DevTools HTTP or WebSocket request whose
  `Host` header is not localhost/a bare IP. Every call here has to claim to be
  talking to `localhost:9222`, hence `_CDP_HEADERS` on literally all of them.
* The `webSocketDebuggerUrl` it hands back therefore also says `localhost:9222`,
  so the host is rewritten to the sidecar's before connecting.

Because this hits a third party from one shared server IP (and repeat runs have
already earned 429s from Spotify), every call goes through: a per-URL result
cache, a process-wide single-flight lock, and a process-wide hourly rate limit.
"""

import asyncio
import json
import logging
import os
import time
from urllib.parse import quote, urlsplit

import httpx
import websockets

from app.services import playlist_import

logger = logging.getLogger(__name__)

CDP_URL = os.environ.get("BROWSER_CDP_URL", "http://chromium:9222")

# See the module docstring: without this every DevTools call is a 500.
_CDP_HEADERS = {"Host": "localhost:9222"}
# The DevTools HTTP endpoints are local and instant; only the evaluate is slow.
_HTTP_TIMEOUT = 10
_HEALTH_TIMEOUT = 4
_EVAL_TIMEOUT = 240
# A 165-track payload is ~30 KB, but the default 1 MiB frame cap is not worth
# risking on a playlist ten times that size.
_WS_MAX_SIZE = 32 * 1024 * 1024

_CACHE_TTL = 6 * 3600.0
_CACHE_MAX = 32           # bound memory: each entry is a full track list
_RATE_WINDOW = 3600.0
_RATE_MAX = 6             # harvests per hour, process-wide

_MANUAL_HINT = ("You can still paste the playlist's track links to import them "
                "(Import → paste links).")

# One harvest at a time, process-wide: two headless tabs scrolling Spotify from
# the same IP is how you get rate-limited.
_lock = asyncio.Lock()
# {canonical url: (result, stored_at)}
_cache: dict[str, tuple[dict, float]] = {}
# Start timestamps of recent harvests, for the hourly limit.
_runs: list[float] = []


class HarvestError(RuntimeError):
    """Base for everything this module raises. `str(exc)` is safe to show a user."""


class HarvestUnavailable(HarvestError):
    """No reachable browser sidecar. The manual helper is the way out."""


class HarvestBusy(HarvestError):
    """Another harvest is already running (single-flight)."""


class HarvestRateLimited(HarvestError):
    """The hourly harvest budget is spent."""


class HarvestFailed(HarvestError):
    """The browser was reachable but the page didn't yield a track list."""


# The scroll loop, run as ONE `Runtime.evaluate` with `awaitPromise`.
#
# Tuning (measured, do not "simplify" without re-measuring): the first server run
# used step 0.85, sleep 550, stagnation 8 and stopped 10 tracks short of what the
# same page yields with a gentler scroll. Spotify's tracklist is virtualised, so
# rows that are skipped over are never rendered and are simply lost — the fix is
# overlap: a smaller step, a longer settle, and a stagnation threshold generous
# enough to survive a slow fetch of the next window. The trailing passes catch the
# last window, which often lands after the loop's final grab.
_HARVEST_JS = r"""
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const t of ['Accept','Agree','Accept cookies']) {
    const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim().toLowerCase().startsWith(t.toLowerCase()));
    if (b) { b.click(); await sleep(800); break; }
  }
  const seen = new Map();
  const grab = () => {
    document.querySelectorAll('[data-testid="tracklist-row"]').forEach(r => {
      const a = r.querySelector('a[href*="/track/"]');
      const m = (a && a.getAttribute('href') || '').match(/\/track\/([A-Za-z0-9]{22})/);
      const name = (r.querySelector('[data-testid="internal-track-link"]')?.innerText || '').trim();
      const art = [...r.querySelectorAll('a[href*="/artist/"]')].map(x => x.innerText.trim()).join(', ');
      // Each row carries its album art as a 64px thumbnail; the CDN encodes the
      // size in the path, so ask for the 300px variant instead of shipping a
      // thumbnail into a 200px card grid. Costs nothing — no extra request.
      const img = (r.querySelector('img')?.getAttribute('src') || '')
        .replace('/ab67616d00004851', '/ab67616d00001e02');
      if (m && name) seen.set(m[1], {id: m[1], name, artist: art, image: img});
    });
    window.__msHarvestCount = seen.size;
  };
  const scroller = () => [...document.querySelectorAll('*')]
    .filter(e => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 200)
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  grab();
  let stagnant = 0, prev = 0;
  for (let i = 0; i < 400 && stagnant < 12; i++) {
    const el = scroller();
    if (el) el.scrollTop += el.clientHeight * 0.5; else window.scrollBy(0, 500);
    await sleep(700);
    grab();
    if (seen.size === prev) stagnant++; else stagnant = 0;
    prev = seen.size;
  }
  for (let i = 0; i < 3; i++) { await sleep(900); grab(); }
  const meta = p => document.querySelector('meta[property="' + p + '"]')?.getAttribute('content') || '';
  const title = meta('og:title') || (document.querySelector('h1')?.innerText || '').trim()
    || document.title.replace(/\s*\|\s*Spotify\s*$/, '').trim();
  return JSON.stringify({count: seen.size, tracks: [...seen.values()], name: title, image: meta('og:image')});
})()
"""

# Poll of the counter the loop above publishes, so a 2-minute harvest can report
# progress instead of looking hung. Cheap: CDP multiplexes on message id, and JS
# is single-threaded so this only runs while the loop is in its sleep().
_PROGRESS_JS = "window.__msHarvestCount || 0"


def _canonical_url(url: str) -> str:
    """`https://open.spotify.com/<kind>/<id>` for a Spotify playlist/album link.

    Reuses `playlist_import.parse_import_url` (it already knows about the
    `/intl-xx/` locale segment share links carry) and doubles as the cache key, so
    the same playlist pasted in three link shapes is harvested once. Deezer is
    rejected: every selector in `_HARVEST_JS` is Spotify's DOM.
    """
    parsed = playlist_import.parse_import_url(url)
    if not parsed or parsed[0] != "spotify":
        raise ValueError("Full harvesting only works on a Spotify playlist or album link")
    _, kind, item_id = parsed
    return f"https://open.spotify.com/{kind}/{item_id}"


def _cache_get(key: str) -> dict | None:
    entry = _cache.get(key)
    if not entry:
        return None
    result, stored_at = entry
    if time.time() - stored_at > _CACHE_TTL:
        _cache.pop(key, None)
        return None
    return result


def _cache_put(key: str, result: dict):
    now = time.time()
    for k in [k for k, (_, at) in _cache.items() if now - at > _CACHE_TTL]:
        _cache.pop(k, None)
    if key not in _cache and len(_cache) >= _CACHE_MAX:
        _cache.pop(min(_cache, key=lambda k: _cache[k][1]), None)
    _cache[key] = (result, now)


def _rate_check_and_record():
    now = time.time()
    _runs[:] = [t for t in _runs if now - t < _RATE_WINDOW]
    if len(_runs) >= _RATE_MAX:
        wait_min = int((_RATE_WINDOW - (now - _runs[0])) / 60) + 1
        raise HarvestRateLimited(
            f"Full-playlist harvesting is limited to {_RATE_MAX} runs per hour "
            f"(Spotify rate-limits repeat visits). Try again in ~{wait_min} min. "
            + _MANUAL_HINT)
    _runs.append(now)


def cached_result(url: str) -> dict | None:
    """The cached harvest for `url`, if one is still fresh. Raises ValueError on a
    link this module can't harvest, so callers can validate and read in one step."""
    return _cache_get(_canonical_url(url))


def is_busy() -> bool:
    return _lock.locked()


def rate_limited() -> bool:
    now = time.time()
    return len([t for t in _runs if now - t < _RATE_WINDOW]) >= _RATE_MAX


async def sidecar_available() -> bool:
    """Cheap reachability probe, so a caller can answer 503 up front instead of
    accepting a job that is guaranteed to fail two seconds later."""
    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT) as client:
            r = await client.get(f"{CDP_URL}/json/version", headers=_CDP_HEADERS)
            r.raise_for_status()
        return True
    except Exception as e:
        logger.info("Browser sidecar at %s not reachable: %s", CDP_URL, e)
        return False


# ── CDP plumbing ────────────────────────────────────────────────────

class _CdpSession:
    """Minimal request/response wrapper over one DevTools WebSocket.

    CDP replies are matched by message id and may arrive interleaved with events,
    so a reader task demuxes them into futures. That is also what lets the
    progress poll run while the harvest evaluate is still outstanding.
    """

    def __init__(self, ws):
        self._ws = ws
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                fut = self._pending.pop(msg.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(msg)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._fail_pending(HarvestFailed(f"Browser connection dropped: {e}"))

    def _fail_pending(self, exc: Exception):
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    async def call(self, method: str, params: dict, timeout: float) -> dict:
        self._next_id += 1
        msg_id = self._next_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        await self._ws.send(json.dumps({"id": msg_id, "method": method, "params": params}))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)

    async def evaluate(self, expression: str, timeout: float):
        msg = await self.call("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
        }, timeout)
        if msg.get("error"):
            raise HarvestFailed(f"Browser rejected the page script: {msg['error'].get('message')}")
        result = msg.get("result", {})
        details = result.get("exceptionDetails")
        if details:
            raise HarvestFailed(f"Page script failed: {details.get('text', 'unknown error')}")
        return result.get("result", {}).get("value")

    async def close(self):
        self._reader.cancel()
        try:
            await self._reader
        except (asyncio.CancelledError, Exception):
            pass


def _ws_url(target: dict) -> str:
    """The target's debugger URL with the host swapped to the sidecar's.

    Chrome always reports `localhost:9222` there (it has no idea it is being
    reached over a docker network), which would connect us back to ourselves.
    """
    raw = target.get("webSocketDebuggerUrl") or ""
    target_id = target.get("id") or ""
    host = urlsplit(CDP_URL).netloc
    if raw:
        path = urlsplit(raw).path
        scheme = "wss" if CDP_URL.startswith("https") else "ws"
        return f"{scheme}://{host}{path}"
    if not target_id:
        raise HarvestFailed("The browser opened a tab but reported no debugger URL.")
    return f"ws://{host}/devtools/page/{target_id}"


async def _open_target(client: httpx.AsyncClient, url: str) -> dict:
    """`PUT /json/new?<url>` — creates a tab AND navigates it in one call.

    (The sidecar is started without a URL argument on purpose: headless shell dies
    with "Multiple targets are not supported" if it was given one.)
    """
    r = await client.put(f"{CDP_URL}/json/new?{quote(url, safe='')}", headers=_CDP_HEADERS)
    r.raise_for_status()
    target = r.json()
    if not target.get("id"):
        raise HarvestFailed("The browser didn't return a usable tab.")
    return target


async def _close_target(client: httpx.AsyncClient, target_id: str):
    """Always called: a leaked tab keeps ~100 MB of the sidecar's RAM forever."""
    try:
        r = await client.get(f"{CDP_URL}/json/close/{target_id}", headers=_CDP_HEADERS)
        r.raise_for_status()
    except Exception as e:
        logger.warning("Failed to close browser tab %s: %s", target_id, e)


async def _poll_progress(session: _CdpSession, on_progress):
    """Report the row count the page script publishes, every few seconds."""
    while True:
        await asyncio.sleep(5)
        try:
            count = await session.evaluate(_PROGRESS_JS, 10)
        except Exception:
            return
        try:
            on_progress(int(count or 0))
        except Exception:
            logger.debug("harvest progress callback failed", exc_info=True)


async def _run_harvest(url: str, on_progress=None) -> dict:
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        try:
            r = await client.get(f"{CDP_URL}/json/version", headers=_CDP_HEADERS)
            r.raise_for_status()
        except Exception as e:
            raise HarvestUnavailable(
                f"The browser helper isn't running, so the full playlist can't be "
                f"fetched. {_MANUAL_HINT}") from e

        target = await _open_target(client, url)
        target_id = target["id"]
        session = None
        try:
            ws = await websockets.connect(
                _ws_url(target), additional_headers=_CDP_HEADERS, max_size=_WS_MAX_SIZE)
            session = _CdpSession(ws)
            poller = asyncio.create_task(_poll_progress(session, on_progress)) \
                if on_progress else None
            try:
                raw = await asyncio.wait_for(
                    session.evaluate(_HARVEST_JS, _EVAL_TIMEOUT), _EVAL_TIMEOUT + 10)
            finally:
                if poller:
                    poller.cancel()
            await session.close()
            await ws.close()
        except (HarvestError, asyncio.TimeoutError):
            if session:
                await session.close()
            raise
        except Exception as e:
            if session:
                await session.close()
            raise HarvestUnavailable(
                f"The browser helper couldn't be driven ({e}). {_MANUAL_HINT}") from e
        finally:
            await _close_target(client, target_id)

    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (TypeError, ValueError) as e:
        raise HarvestFailed("The playlist page returned something unreadable.") from e

    tracks = [t for t in (data.get("tracks") or []) if t.get("name")]
    if not tracks:
        raise HarvestFailed(
            "The playlist page loaded but showed no tracks — it may be private, "
            "empty, or Spotify changed its page.")
    name = (data.get("name") or "").replace(" | Spotify", "").strip()
    # A row whose thumbnail hadn't loaded when we scrolled past yields no art;
    # the playlist cover beats a blank tile in the card grid.
    cover = data.get("image") or ""
    for t in tracks:
        if not t.get("image"):
            t["image"] = cover
    # Never log the payload itself, only its shape.
    logger.info("Harvested %d tracks from %s", len(tracks), url)
    return {
        "name": name,
        "image": data.get("image") or "",
        "tracks": tracks,
        "count": len(tracks),
        "via": "browser",
    }


async def harvest_collection(url: str, on_progress=None) -> dict:
    """`{name, image, tracks: [{name, artist, id, image}], count, via}` for a public
    Spotify playlist/album, read from a real browser's rendered DOM.

    Raises ValueError for an unsupported link and a `HarvestError` subclass for
    everything else — no path here should surface as a 500.
    """
    key = _canonical_url(url)

    cached = _cache_get(key)
    if cached:
        return cached
    if _lock.locked():
        raise HarvestBusy(
            "Another full-playlist fetch is already running — it takes a couple of "
            "minutes. Try again once it finishes.")

    async with _lock:
        # The lock may have been held by a run of this very URL.
        cached = _cache_get(key)
        if cached:
            return cached
        _rate_check_and_record()
        result = await _run_harvest(key, on_progress=on_progress)
        _cache_put(key, result)
        return result
