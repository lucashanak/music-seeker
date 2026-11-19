"""What a receiver is sent when it plays a track (cast review 2026-11-19, findings 12 and 15).

12 — a Navidrome song asked for as `quality=lossless` (every cast does) is stored and
     served in its OWN format. It used to be written to <id>.flac and answered as
     audio/flac whatever it was, so an m4a/mp3/opus song reached the receiver with a
     wrong type.
15 — a cache file a response is still sending is not evicted. A receiver reads a
     two-hour mix through one GET; the sweep used to unlink it 5 minutes in, and the
     next seek waited for a full re-download.
"""
import asyncio
import os
import tempfile
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import _stream_auth
from app.routers import player as player_router
from app.services import library, player


@pytest.fixture
def tmp(tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    player._serving.clear()
    yield tmp_path
    player._serving.clear()


# ── 12: the original's own format ────────────────────────────────────────────
def test_resolution_carries_the_songs_own_format(monkeypatch):
    async def find_song(name, artist):
        return {"id": "s1", "suffix": "M4A", "bitRate": 850}         # ALAC: no raw_ext
    monkeypatch.setattr(library, "find_song", find_song)
    res = asyncio.run(player._resolve_navidrome("t", "a"))
    assert res == {"source": "navidrome", "song_id": "s1", "ext": "m4a"}


def test_a_suffix_that_is_not_a_plain_extension_is_ignored():
    assert player.nav_ext({"suffix": "../x"}) is None
    assert player.nav_ext({"suffix": "flac"}) == "flac"
    assert player.nav_ext({}) is None


@pytest.mark.parametrize("ext,path_end,mime", [
    ("m4a", "s1.raw.m4a", "audio/mp4"),
    ("mp3", "s1.raw.mp3", "audio/mpeg"),
    ("opus", "s1.raw.opus", "audio/ogg"),
    ("aac", "s1.raw.aac", "audio/aac"),
])
def test_lossless_of_a_non_flac_song_is_its_original(tmp, monkeypatch, ext, path_end, mime):
    monkeypatch.setattr(library, "_params", lambda **kw: kw)
    path, params = player.nav_cache_target("s1", True, None, ext)
    assert path.endswith(path_end) and params == {"id": "s1", "format": "raw"}
    assert player.navidrome_stream_mime({"song_id": "s1", "ext": ext}, lossless=True) == mime


@pytest.mark.parametrize("ext", ["flac", None, "dsf"])
def test_lossless_of_a_flac_or_unknown_song_stays_flac(tmp, monkeypatch, ext):
    monkeypatch.setattr(library, "_params", lambda **kw: kw)
    path, params = player.nav_cache_target("s1", True, None, ext)
    assert path.endswith("s1.flac") and "format" not in params
    assert player.navidrome_stream_mime({"song_id": "s1", "ext": ext}, lossless=True) == "audio/flac"


def test_the_deck_path_is_untouched_by_the_original_format(tmp, monkeypatch):
    """ALAC in m4a (raw_ext None) must still reach a browser deck as MP3 — only a
    lossless request reads `ext`."""
    monkeypatch.setattr(library, "_params", lambda **kw: kw)
    assert player.nav_cache_target("s1", False, None, "m4a")[0].endswith("s1.mp3")
    assert player.nav_cache_target("s1", False, "m4a", "m4a")[0].endswith("s1.raw.m4a")


class _Resp:
    def __init__(self, ctype, body):
        self.headers = {"content-type": ctype}
        self._body = body

    def raise_for_status(self):
        pass

    async def aiter_bytes(self, n):
        yield self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


@pytest.fixture
def client(tmp, monkeypatch):
    """The real stream router over a stubbed Navidrome that answers an m4a song."""
    asked = []

    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, params=None):
            asked.append(params)
            return _Resp("audio/mp4", b"M4A!" * 1000)
    monkeypatch.setattr(player.httpx, "AsyncClient", Client)
    monkeypatch.setattr(library, "_params", lambda **kw: dict(kw))

    async def resolve(name, artist):
        return {"source": "navidrome", "song_id": "s9", "raw_ext": "m4a", "ext": "m4a"}
    monkeypatch.setattr(player, "resolve_stream", resolve)
    app = FastAPI()
    app.include_router(player_router.router)
    app.dependency_overrides[_stream_auth] = lambda: {"username": "t"}
    return TestClient(app), asked


def test_a_cast_of_an_m4a_song_is_served_as_m4a(client, tmp):
    c, asked = client
    r = c.get("/api/player/stream", params={"name": "Mix", "artist": "DJ", "quality": "lossless"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mp4"
    assert r.content == b"M4A!" * 1000
    assert asked == [{"id": "s9", "format": "raw"}]
    assert (tmp / "ms-nav-cache" / "s9.raw.m4a").exists()
    assert not (tmp / "ms-nav-cache" / "s9.flac").exists()
    h = c.head("/api/player/stream", params={"name": "Mix", "artist": "DJ", "quality": "lossless"})
    assert h.headers["content-type"] == "audio/mp4"                    # HEAD and GET agree
    assert h.headers["content-length"] == str(4000)
    assert len(asked) == 1                                             # one copy, shared


def test_the_stream_endpoint_registers_what_it_sends(client, tmp, monkeypatch):
    c, _ = client
    begun, ended = [], []
    real_begin, real_end = player.serving_begin, player.serving_end
    monkeypatch.setattr(player, "serving_begin", lambda p: (begun.append(p), real_begin(p)))
    monkeypatch.setattr(player, "serving_end", lambda p: (ended.append(p), real_end(p)))
    c.get("/api/player/stream", params={"name": "Mix", "artist": "DJ", "quality": "lossless"})
    want = str(tmp / "ms-nav-cache" / "s9.raw.m4a")
    assert begun == [want] and ended == [want]
    assert not player.being_served(want)


def test_a_seek_in_the_cast_gets_the_same_bytes(client, tmp):
    c, _ = client
    q = {"name": "Mix", "artist": "DJ", "quality": "lossless"}
    c.get("/api/player/stream", params=q)
    r = c.get("/api/player/stream", params=q, headers={"Range": "bytes=2000-"})
    assert r.status_code == 206 and r.headers["content-type"] == "audio/mp4"
    assert r.content == (b"M4A!" * 1000)[2000:]


# ── 15: a file still being sent is not evicted ───────────────────────────────
def _old_cache(tmp, names, size=1000, age=3600):
    d = tmp / "ms-nav-cache"
    d.mkdir(exist_ok=True)
    past = time.time() - age
    for n in names:
        f = d / n
        f.write_bytes(b"x" * size)
        os.utime(f, (past, past))
    return d


def test_eviction_spares_a_file_a_response_is_sending(tmp):
    d = _old_cache(tmp, ["mix.raw.m4a", "other.mp3"])
    player.serving_begin(str(d / "mix.raw.m4a"))
    player.evict_cache_dir(str(d), 0)                                  # over the cap: sweep all
    assert (d / "mix.raw.m4a").exists()
    assert not (d / "other.mp3").exists()


def test_the_end_of_a_response_counts_as_a_touch(tmp):
    d = _old_cache(tmp, ["mix.raw.m4a"])
    f = str(d / "mix.raw.m4a")
    player.serving_begin(f)
    player.serving_begin(f)                                            # two receivers / a seek
    player.serving_end(f)
    assert player.being_served(f)                                      # one still sending
    player.serving_end(f)
    assert not player.being_served(f)
    assert time.time() - os.stat(f).st_atime < 60                      # a pause right after keeps it
    past = time.time() - 3600
    os.utime(f, (past, past))
    player.evict_cache_dir(str(d), 0)
    assert not os.path.exists(f)                                       # and nothing pins it forever


def test_a_file_response_holds_its_file_until_the_last_byte(tmp):
    """Run the router's response class the way uvicorn does, and sweep the cache in the
    middle of sending it — the moment a long cast is exposed."""
    d = _old_cache(tmp, ["mix.raw.m4a"], size=3 * 64 * 1024)
    f = str(d / "mix.raw.m4a")
    seen = {"mid": None, "chunks": 0}

    async def run():
        resp = player_router._ServedFile(f, media_type="audio/mp4")
        resp.chunk_size = 64 * 1024

        async def receive():
            await asyncio.Event().wait()

        async def send(msg):
            if msg["type"] == "http.response.body" and msg.get("body"):
                seen["chunks"] += 1
                if seen["chunks"] == 1:
                    past = time.time() - 3600
                    os.utime(f, (past, past))                          # its request touch lapsed long ago
                    player.evict_cache_dir(str(d), 0)
                    seen["mid"] = os.path.exists(f)
        scope = {"type": "http", "method": "GET", "headers": [], "path": "/", "query_string": b""}
        await resp(scope, receive, send)

    asyncio.run(run())
    assert seen["chunks"] == 3
    assert seen["mid"] is True
    assert not player.being_served(f)


def test_a_response_that_breaks_off_releases_its_file(tmp):
    d = _old_cache(tmp, ["mix.raw.m4a"], size=3 * 64 * 1024)
    f = str(d / "mix.raw.m4a")

    async def run():
        resp = player_router._ServedFile(f, media_type="audio/mp4")
        resp.chunk_size = 64 * 1024

        async def receive():
            await asyncio.Event().wait()

        async def send(msg):
            if msg["type"] == "http.response.body":
                raise OSError("client went away")
        scope = {"type": "http", "method": "GET", "headers": [], "path": "/", "query_string": b""}
        await resp(scope, receive, send)

    with pytest.raises(OSError):
        asyncio.run(run())
    assert not player.being_served(f)


def test_a_deck_following_a_build_holds_the_file(tmp):
    final = str(tmp / "ms-nav-cache" / "song.mp3")
    os.makedirs(os.path.dirname(final), exist_ok=True)

    async def run():
        async def build():
            with open(final + ".tmp", "wb") as fh:
                fh.write(b"y" * 1000)
            os.rename(final + ".tmp", final)
            return final
        task = asyncio.create_task(build())
        held = []
        async for _ in player.follow_build(task, final):
            held.append(player.being_served(final))
        return held

    held = asyncio.run(run())
    assert held and all(held)
    assert not player.being_served(final)
