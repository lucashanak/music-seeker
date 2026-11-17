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

    async def communicate(self):
        await self.wait()
        return b"", b""


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


# ── A YouTube download that was dropped half-way is not a track ──────────────
_FF_OK = """Input #0, matroska,webm, from 'https://x':
  Duration: 00:03:45.12, start: 0.000000, bitrate: 128 kb/s
size=    1024kB time=00:01:00.00 bitrate= 192.0kbits/s speed=40x
size=    5273kB time=00:03:45.09 bitrate= 192.0kbits/s speed=41x
"""
_FF_CUT = _FF_OK.replace("time=00:03:45.09", "time=00:01:58.40") + "https @ 0x1: HTTP error 403 Forbidden\n"


def test_ffmpeg_cut_short_reads_ffmpegs_own_numbers():
    assert player.ffmpeg_cut_short(_FF_OK) is None
    declared, encoded = player.ffmpeg_cut_short(_FF_CUT)
    assert round(declared) == 225 and round(encoded) == 118
    assert player.ffmpeg_cut_short("") is None                      # nothing to go on → no verdict
    assert player.ffmpeg_cut_short("Duration: N/A, bitrate: N/A\ntime=00:00:10.00") is None


class _DoneProc:
    def __init__(self, err):
        self.returncode = 0
        self._err = err.encode()

    async def communicate(self):
        return b"", self._err

    async def wait(self):
        return 0

    def kill(self):
        pass


def _run_yt(monkeypatch, err):
    async def fake_exec(*args, **kw):
        open(args[-1], "wb").write(b"x" * 50000)
        return _DoneProc(err)
    monkeypatch.setattr(player.asyncio, "create_subprocess_exec", fake_exec)
    return asyncio.run(player.cache_youtube_stream("http://u", "Song", "Artist"))


def test_truncated_youtube_download_is_not_cached(tmp, monkeypatch):
    player._yt_failed.clear()
    assert _run_yt(monkeypatch, _FF_CUT) is None         # ffmpeg exited 0 — and still no file
    assert os.listdir(tmp / "ms-yt-cache") == []
    # ...and the track is left alone for a while instead of re-asking YouTube at once.
    assert player._yt_recently_failed(player._cache_key(player.nfc("Song"), player.nfc("Artist")))


def test_complete_youtube_download_is_cached(tmp, monkeypatch):
    path = _run_yt(monkeypatch, _FF_OK)
    assert path and os.path.getsize(path) == 50000


# ── Compact local files are served as they are ───────────────────────────────
def test_only_bulky_local_formats_are_transcoded():
    assert player.wants_local_transcode("/m/a.flac")
    assert player.wants_local_transcode("/m/a.wav")
    assert player.wants_local_transcode("/m/a.opus")        # Safari cannot be trusted with it
    for ext in ("mp3", "m4a", "aac", "MP3", "M4A"):
        assert not player.wants_local_transcode(f"/m/Mixes/hour-long.{ext}")


def test_transcode_timeout_grows_with_the_file(tmp):
    small, big = tmp / "s.flac", tmp / "b.flac"
    small.write_bytes(b"x" * 1_000_000)
    with open(big, "wb") as f:
        f.truncate(200_000_000)                              # sparse: no disk used
    assert 20 <= player.local_transcode_timeout(str(small)) < 22
    assert player.local_transcode_timeout(str(big)) > 150
    assert player.local_transcode_timeout(str(tmp / "missing.flac")) == 20


# ── A cache file can be served while it is still being built ─────────────────
def test_follow_build_streams_the_file_as_it_grows_and_across_the_rename(tmp):
    final = str(tmp / "song.mp3")
    parts = [bytes([i]) * 40000 for i in range(1, 6)]

    async def run():
        async def build():
            with open(final + ".tmp", "wb") as f:
                for p in parts:
                    f.write(p)
                    f.flush()
                    await asyncio.sleep(0.05)
            os.rename(final + ".tmp", final)       # same inode: the reader keeps its place
            return final
        task = asyncio.create_task(build())
        got, first_at = b"", None
        async for chunk in player.follow_build(task, final):
            if first_at is None:
                first_at = task.done()
            got += chunk
        return got, first_at

    got, build_done_at_first_byte = asyncio.run(run())
    assert got == b"".join(parts)                    # every byte, once, in order
    assert build_done_at_first_byte is False         # ...and the first ones BEFORE the build ended


def test_follow_build_cuts_the_connection_when_the_build_fails(tmp):
    final = str(tmp / "bad.mp3")

    async def run():
        async def build():
            with open(final + ".tmp", "wb") as f:
                f.write(b"x" * 1000)
            await asyncio.sleep(0.05)
            os.unlink(final + ".tmp")
            return None                              # what the cache builders return on failure
        task = asyncio.create_task(build())
        async for _ in player.follow_build(task, final):
            pass

    with pytest.raises(RuntimeError):                # not a clean end: the client must see an error
        asyncio.run(run())


def test_audio_duration_of_a_missing_or_non_audio_file_is_none(tmp):
    junk = tmp / "junk.mp3"
    junk.write_bytes(b"not audio at all")
    assert player.audio_duration(str(junk)) is None
    assert player.audio_duration(str(tmp / "nope.mp3")) is None


def test_follow_build_refuses_a_file_that_was_replaced_under_it(tmp):
    """The build we latched onto fails and a second one succeeds: our descriptor is the
    first one's unlinked .tmp. Ending cleanly there would be half a song."""
    final = str(tmp / "song.mp3")

    async def run():
        with open(final + ".tmp", "wb") as f:      # the first build's partial file
            f.write(b"a" * 65536)

        async def second_build():
            await asyncio.sleep(0.1)
            player._fresh_tmp(final + ".tmp")       # what every builder now does first
            with open(final + ".tmp", "wb") as f:
                f.write(b"b" * 163840)
            os.rename(final + ".tmp", final)
            return final
        task = asyncio.create_task(second_build())
        async for _ in player.follow_build(task, final):
            pass

    with pytest.raises(RuntimeError):
        asyncio.run(run())


def test_cached_resolution_never_resolves(monkeypatch):
    async def boom(*a, **k):
        raise AssertionError("a duration poll must not start a lookup")
    monkeypatch.setattr(player, "_resolve_youtube", boom)
    monkeypatch.setattr(player, "_resolve_navidrome", boom)
    assert player.cached_resolution("Never Seen", "Nobody") is None
    player._cache_put(player._cache_key(player.nfc("Seen"), "a"), {"source": "navidrome", "song_id": "7"})
    assert player.cached_resolution("Seen", "a")["song_id"] == "7"


def test_youtube_refusing_after_a_cut_download(tmp, monkeypatch):
    player._yt_failed.clear()
    assert not player.youtube_refusing("Song", "Artist")
    assert _run_yt(monkeypatch, _FF_CUT) is None
    assert player.youtube_refusing("Song", "Artist")   # → the router answers 502, no live re-download


# ── A compact Navidrome song is fetched as it is, not as a 320k MP3 ──────────
def test_nav_raw_ext_only_for_compact_lossy_files():
    assert player.nav_raw_ext({"suffix": "m4a", "bitRate": 160}) == "m4a"
    assert player.nav_raw_ext({"suffix": "MP3", "bitRate": 320}) == "mp3"
    assert player.nav_raw_ext({"suffix": "flac", "bitRate": 900}) is None
    assert player.nav_raw_ext({"suffix": "m4a", "bitRate": 850}) is None     # ALAC
    assert player.nav_raw_ext({"suffix": "opus", "bitRate": 128}) is None    # Safari
    assert player.nav_raw_ext({}) is None


def test_nav_target_asks_navidrome_for_the_raw_file(tmp, monkeypatch):
    monkeypatch.setattr(player.library, "_params", lambda **kw: kw)
    path, params = player.nav_cache_target("abc", False, "m4a")
    assert path.endswith("abc.raw.m4a") and params == {"id": "abc", "format": "raw"}
    path, params = player.nav_cache_target("abc", False, None)               # unknown suffix: as before
    assert path.endswith("abc.mp3") and params["format"] == "mp3"
    path, params = player.nav_cache_target("abc", True, "m4a")               # lossless request: original
    assert path.endswith("abc.flac") and "format" not in params


def test_nav_target_sticks_to_the_representation_already_on_disk(tmp, monkeypatch):
    """BPM analysis builds <id>.mp3 for the same song on its own schedule. A stream URL
    must not change which bytes it serves because the other file appeared."""
    monkeypatch.setattr(player.library, "_params", lambda **kw: kw)
    d = tmp / "ms-nav-cache"
    d.mkdir(exist_ok=True)
    (d / "s1.mp3").write_bytes(b"x" * 10)                                    # MP3 was there first
    assert player.nav_cache_target("s1", False, "m4a")[0].endswith("s1.mp3")
    (d / "s2.raw.m4a").write_bytes(b"x" * 10)                                # raw was there first...
    (d / "s2.mp3").write_bytes(b"x" * 10)                                    # ...then BPM built the MP3
    assert player.nav_cache_target("s2", False, "m4a")[0].endswith("s2.raw.m4a")
    assert player.navidrome_cache_path("s2", False, "m4a").endswith("s2.raw.m4a")
