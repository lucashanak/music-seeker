"""Cache hygiene in the player: error bodies are not audio, a killed build leaves no
ffmpeg behind, a dead resolution is forgotten, and serving a file counts as using it."""
import asyncio
import os
import tempfile
import time

import pytest

from app.services import player


class _Resp:
    def __init__(self, ctype, body=b"x" * 64, status=200):
        self.headers = {"content-type": ctype} if ctype is not None else {}
        self._body = body

    def raise_for_status(self):
        pass

    async def aiter_bytes(self, n):
        yield self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _stub_httpx(monkeypatch, resp):
    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, *a, **k):
            return resp

    monkeypatch.setattr(player.httpx, "AsyncClient", Client)


@pytest.fixture
def tmp(tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    return tmp_path


@pytest.mark.parametrize("ctype", ["application/json", "text/xml;charset=utf-8", None])
def test_navidrome_error_body_is_not_cached(tmp, monkeypatch, ctype):
    _stub_httpx(monkeypatch, _Resp(ctype, b'{"subsonic-response":{"status":"failed"}}'))
    assert asyncio.run(player.cache_navidrome_stream("abc")) is None
    assert not (tmp / "ms-nav-cache" / "abc.mp3").exists()
    assert not (tmp / "ms-nav-cache" / "abc.mp3.tmp").exists()


@pytest.mark.parametrize("ctype", ["audio/mpeg", "audio/mpeg; charset=x", "application/octet-stream"])
def test_navidrome_audio_is_cached(tmp, monkeypatch, ctype):
    _stub_httpx(monkeypatch, _Resp(ctype))
    path = asyncio.run(player.cache_navidrome_stream("abc"))
    assert path and os.path.getsize(path) == 64


def test_bpm_flac_download_rejects_error_body(tmp, monkeypatch):
    from app.services import bpm
    monkeypatch.setattr(bpm.library, "NAVIDROME_PASSWORD", "x")
    monkeypatch.setattr(bpm, "find_track_file", lambda n, a: None)

    async def no_shared(*a, **k):
        return None
    monkeypatch.setattr(bpm, "cache_navidrome_stream", no_shared)
    _stub_httpx(monkeypatch, _Resp("application/json", b"{}"))
    monkeypatch.setattr(bpm.httpx, "AsyncClient", player.httpx.AsyncClient)
    assert asyncio.run(bpm._get_audio_file("abc", "n", "a")) is None
    assert not (tmp / "ms-bpm-cache" / "abc.flac").exists()


def test_get_audio_file_walks_the_tree_off_the_loop(monkeypatch):
    from app.services import bpm
    import threading
    seen = {}

    def fake_find(n, a):
        seen["thread"] = threading.current_thread()
        return "/x.flac"
    monkeypatch.setattr(bpm, "find_track_file", fake_find)
    assert asyncio.run(bpm._get_audio_file("id", "n", "a")) == "/x.flac"
    assert seen["thread"] is not threading.main_thread()


class _Proc:
    def __init__(self):
        self.returncode = None
        self.killed = False

    async def wait(self):
        if self.killed:
            self.returncode = -9
            return -9
        await asyncio.sleep(3600)

    def kill(self):
        self.killed = True


def test_youtube_timeout_kills_ffmpeg_and_removes_tmp(tmp, monkeypatch):
    proc = _Proc()

    async def fake_exec(*args, **kw):
        # the real ffmpeg would have started writing the .tmp file
        open(args[-1], "wb").write(b"partial")
        return proc
    monkeypatch.setattr(player.asyncio, "create_subprocess_exec", fake_exec)
    real_wait_for = asyncio.wait_for

    async def quick_wait_for(aw, timeout):
        return await real_wait_for(aw, 0.01)
    monkeypatch.setattr(player.asyncio, "wait_for", quick_wait_for)

    assert asyncio.run(player.cache_youtube_stream("http://u", "n", "a")) is None
    assert proc.killed
    assert os.listdir(tmp / "ms-yt-cache") == []


def test_invalidate_cache_forgets_a_resolution():
    key = player._cache_key(player.nfc("Divoká"), "a")
    player._cache_put(key, {"source": "local", "path": "/gone"})
    player.invalidate_cache("Divoká", "a")
    assert key not in player._url_cache


def test_touch_cache_file_bumps_atime_only(tmp):
    f = tmp / "c.mp3"
    f.write_bytes(b"x")
    old = time.time() - 3600
    os.utime(f, (old, old))
    st0 = os.stat(f)
    player.touch_cache_file(str(f))
    st1 = os.stat(f)
    assert st1.st_atime > st0.st_atime + 3000
    assert st1.st_mtime == st0.st_mtime


def test_touch_cache_file_ignores_missing(tmp):
    player.touch_cache_file(str(tmp / "nope.mp3"))  # must not raise
