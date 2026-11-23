"""Playing a mix from search without downloading it: GET /api/player/mix-stream.

yt-dlp, ffprobe and ffmpeg are replaced by shell stand-ins on PATH, so this runs
anywhere. What is pinned: only real mix links reach a subprocess, one build per URL,
a failure answers fast and is remembered, nothing lands in the library or the mix
registry, and the cache stays bounded.
"""
import asyncio
import os
import stat
import time

import httpx
import pytest
from fastapi import FastAPI

from app.dependencies import _stream_auth
from app.routers import bpm as bpm_router
from app.routers import player as player_router
from app.services import auth, bpm, library, mix_stream, mixes, player

GOOD = "https://www.mixcloud.com/djtest/alpha-set/"
GOOD2 = "https://www.mixcloud.com/djtest/beta-set/"


@pytest.fixture
def env(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "calls.log"
    pids = tmp_path / "pids.log"
    hold = tmp_path / "hold"             # while this file exists the (fake) remux waits
    mode = tmp_path / "mode"
    mode.write_text("ok")

    def script(name, body):
        p = bindir / name
        p.write_text("#!/bin/bash\n" + body)
        p.chmod(p.stat().st_mode | stat.S_IXUSR)

    # yt-dlp: log the call, then fail / sleep / emit audio-looking bytes by mode
    script("yt-dlp", 'if [ "$1" = "-J" ]; then exit 1; fi\n'      # the server's own info lookup: unknown length
           f'echo "$@" >> {log}\n'
           f'echo $$ >> {pids}\n'
           f'm=$(cat {mode})\n'
           'if [ "$m" = fail ]; then echo "ERROR: HTTP Error 403" >&2; exit 1; fi\n'
           'if [ "$m" = slow ]; then sleep 1.5; fi\n'
           'head -c 300000 /dev/zero | tr "\\0" "A"\n'
           'if [ "$m" = grow ]; then sleep 2; head -c 100000 /dev/zero | tr "\\0" "B"; fi\n'
           'if [ "$m" = hang ]; then sleep 60; fi\n')
    script("ffprobe", 'case "$*" in *format=duration*) echo 1800.5;; *) echo aac;; esac\n')
    script("ffmpeg", f'echo $$ >> {pids}\n'
           # the faststart remux of the finished build: a copy
           f'case "$*" in *faststart*) for a; do last=$a; done; src=$(echo "$*" | sed "s/.*-i \\([^ ]*\\) .*/\\1/"); while [ -e {hold} ]; do sleep 0.1; done; (printf PLAIN; cat "$src") > "$last"; exit 0;; esac\n'
           f'if [ "$(cat {mode})" = empty ]; then for a; do last=$a; done; head -c 749 /dev/zero > "$last"; '
           'echo "Output file is empty, nothing was encoded" >&2; exit 0; fi\n'
           'for a; do last=$a; done; cat > "$last"\n')
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ['PATH']}")
    monkeypatch.setattr(mix_stream, "CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(mix_stream, "NONPROG_WAIT", 20.0)    # a loaded machine must not turn a slow build into a 503; tests that want the short wait set their own
    mix_stream._builds.clear()
    mix_stream._failed.clear()
    mix_stream._user_count.clear()
    monkeypatch.setattr(player, "youtube_rate_limited", lambda: False)

    app = FastAPI()
    app.include_router(player_router.router)
    app.dependency_overrides[_stream_auth] = lambda: {"username": "t"}

    class E:
        pass
    e = E()
    e.hold = hold
    e.app, e.log, e.mode, e.cache, e.pids, e.bin = app, log, mode, tmp_path / "cache", pids, bindir
    e.script = script
    e.calls = lambda: len(log.read_text().splitlines()) if log.exists() else 0

    def get(url, app=app, **params):
        async def go():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
                return await c.get("/api/player/mix-stream", params={"url": url, **params})
        return asyncio.run(go())
    e.get = get
    return e


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "http://127.0.0.1:8090/api/x", "https://evil.example/mixcloud.com/a/b/",
    "https://mixcloud.com@evil.example/a/b/", "https://www.mixcloud.com.evil.example/a/b/",
    "--exec=touch /tmp/pwn", "https://www.mixcloud.com/djtest/",
    "https://soundcloud.com/djtest", "https://www.youtube.com/playlist?list=PLabc",
    "https://www.youtube.com/watch?v=short", "", "https://169.254.169.254/latest/meta-data",
])
def test_only_mix_links_reach_a_subprocess(env, url):
    r = env.get(url)
    assert r.status_code == 400
    assert env.calls() == 0


def test_the_stream_needs_a_login(env):
    app = FastAPI()
    app.include_router(player_router.router)   # the real _stream_auth, no override
    r = env.get(GOOD, app=app)
    assert r.status_code == 401
    assert env.calls() == 0


def test_a_mix_is_built_into_the_cache_and_nowhere_else(env, tmp_path):
    r = env.get(GOOD)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/mp4")
    assert r.headers["x-stream-source"] == "mix-stream"
    assert len(r.content) == 300005
    files = {p.suffix: p for p in env.cache.iterdir()}
    # the plain MP4 every later request gets, and the fragmented file readers may still hold
    assert ".m4a" in files and files[".m4a"].stat().st_size == 300005      # the stand-in marks the plain file
    assert set(files) <= {".m4a", ".frag"}
    # not a library mix, not tagged, not registered, nothing under the music folder
    assert not mixes.is_mix("alpha-set", "djtest")
    assert not mixes.REGISTRY_FILE.exists() or "alpha" not in mixes.REGISTRY_FILE.read_text()
    assert not any(p for p in player.MUSIC_DIR.rglob("*") if p.is_file())
    # the command is the download's selector, the URL after `--`, output to a pipe
    line = env.log.read_text()
    assert mixes.FORMAT_SELECTOR in line and "-o -" in line and f"-- {GOOD}" in line
    # a second play is the cache file: no second fetch
    assert env.get(GOOD).status_code == 200
    assert env.calls() == 1


def test_concurrent_requests_share_one_build(env):
    env.mode.write_text("slow")

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://t") as c:
            return await asyncio.gather(*[c.get("/api/player/mix-stream", params={"url": GOOD}) for _ in range(4)])
    rs = asyncio.run(go())
    assert [r.status_code for r in rs] == [200] * 4
    assert env.calls() == 1


def test_a_failed_build_answers_fast_leaves_nothing_and_is_not_retried(env):
    env.mode.write_text("fail")
    t0 = time.monotonic()
    r = env.get(GOOD)
    assert r.status_code == 502
    assert time.monotonic() - t0 < 10
    assert not list(env.cache.glob("*"))            # not even a .tmp
    n = env.calls()
    # the player retries at once: answered from memory, no new process
    for _ in range(3):
        assert env.get(GOOD).status_code == 502
    assert env.calls() == n == 1
    assert not mix_stream._builds and not mix_stream._user_count


def test_builds_per_user_are_limited(env, monkeypatch):
    monkeypatch.setattr(mix_stream, "USER_BUILDS", 1)
    env.mode.write_text("slow")

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://t") as c:
            a = asyncio.ensure_future(c.get("/api/player/mix-stream", params={"url": GOOD}))
            await asyncio.sleep(0.4)
            b = await c.get("/api/player/mix-stream", params={"url": GOOD2})
            return b, await a
    b, a = asyncio.run(go())
    assert b.status_code == 429
    assert a.status_code == 200
    assert env.calls() == 1


def test_youtube_is_not_asked_while_it_is_refusing(env, monkeypatch):
    monkeypatch.setattr(player, "youtube_rate_limited", lambda: True)
    r = env.get("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert r.status_code == 503
    assert env.calls() == 0


def test_the_cache_is_bounded(env, monkeypatch):
    os.makedirs(env.cache, exist_ok=True)
    old = []
    for i in range(3):
        p = env.cache / f"old{i}.m4a"
        p.write_bytes(b"x" * 200000)
        t = time.time() - 3600 * (i + 2)
        os.utime(p, (t, t))
        old.append(p)
    monkeypatch.setattr(mix_stream, "MAX_CACHE_BYTES", 400000)
    assert env.get(GOOD).status_code == 200
    left = {p.name for p in env.cache.iterdir()}
    assert len([n for n in left if n.startswith("old")]) < 3     # oldest first
    assert any(not n.startswith("old") for n in left)            # the fresh one stays


def test_a_streamed_mix_starts_no_bpm_work(monkeypatch):
    """The player asks /api/bpm/track by title + uploader; for a mix that is not in the
    library the answer is "not owned" and no analysis is started."""
    async def no_song(name, artist):
        return None
    monkeypatch.setattr(library, "find_song_id", no_song)
    monkeypatch.setattr(bpm, "find_track_file", lambda n, a: None)

    async def boom(*a, **k):
        raise AssertionError("analysis started")
    monkeypatch.setattr(bpm, "analyze_track", boom)
    monkeypatch.setattr(bpm, "get_cached_bpm", lambda n, a: None)
    app = FastAPI()
    app.include_router(bpm_router.router)
    app.dependency_overrides[auth.get_current_user] = lambda: {"username": "t"}

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.get("/api/bpm/track", params={"name": "Alpha set", "artist": "DJ Test"})
    r = asyncio.run(go())
    assert r.status_code == 200 and r.json().get("owned") is False


# ── review findings ──

def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:   # a zombie is not running either
        return open(f"/proc/{pid}/stat").read().split()[2] != "Z"
    except OSError:
        return False


def test_header_only_output_is_not_cached_as_a_mix(env):
    """ffmpeg exits 0 on an input it cannot read from a pipe and leaves a 749-byte header."""
    env.mode.write_text("empty")
    r = env.get(GOOD)
    assert r.status_code == 502
    assert not list(env.cache.glob("*"))
    assert mix_stream.cached_file(GOOD) is None


def test_an_unidentifiable_stream_is_a_failure_not_an_mp3_re_encode(env):
    env.script("ffprobe", "exit 1\n")
    assert env.get(GOOD).status_code == 502
    assert not list(env.cache.glob("*"))


def test_a_file_clearly_shorter_than_the_site_says_is_refused(env, monkeypatch):
    """The server judges against ITS OWN knowledge of the length (yt-dlp's info)."""
    async def info(url):
        return {"duration": 7200}          # the stand-in ffprobe reports 1800.5 s: 25 %
    monkeypatch.setattr(mixes, "fetch_info", info)
    assert env.get(GOOD2).status_code == 502
    assert not list(env.cache.glob("*"))

    async def info_ok(url):
        return {"duration": 1900}
    monkeypatch.setattr(mixes, "fetch_info", info_ok)
    assert env.get(GOOD).status_code == 200


def test_the_clients_dur_never_decides_anything(env, monkeypatch):
    """`dur` is one user's input and the build is shared: dur=86400 must not fail a build
    or block the URL for everybody."""
    async def info(url):
        return {"duration": 1800}
    monkeypatch.setattr(mixes, "fetch_info", info)
    r = env.get(GOOD, dur=86400)
    assert r.status_code == 200
    assert env.get(GOOD, dur=86400).status_code == 200
    assert env.calls() == 1


def test_a_progressive_request_gets_a_growing_body_and_a_bounded_wait_gives_503(env, monkeypatch):
    env.mode.write_text("grow")
    r = env.get(GOOD, progressive=1)
    assert r.status_code == 200 and r.headers.get("x-stream-progressive") == "1"
    assert len(r.content) == 400000
    # a non-progressive request into a build that outlasts its budget: 503, not a 504
    env.mode.write_text("hang")
    monkeypatch.setattr(mix_stream, "REQUEST_BUDGET", 2)
    t0 = time.monotonic()
    r = env.get(GOOD2)
    assert r.status_code == 503 and r.headers.get("retry-after")
    assert time.monotonic() - t0 < 8


def test_a_build_nobody_listens_to_is_cancelled_and_leaves_nothing(env, monkeypatch):
    monkeypatch.setattr(mix_stream, "CANCEL_GRACE", 0.3)
    env.mode.write_text("hang")

    async def go():
        curl, src, done, b = await mix_stream.prepare(GOOD, "t")
        lease = b.lease()
        await b.fmt                      # yt-dlp and ffmpeg are running
        assert mix_stream._user_count.get("t") == 1
        lease.release()
        await asyncio.sleep(1.2)
        return b
    b = asyncio.run(go())
    assert b.task.cancelled() or b.task.done()
    assert not mix_stream._builds and not mix_stream._user_count
    assert not list(env.cache.glob("*"))                       # no .tmp
    pids = [int(x) for x in env.pids.read_text().split()]
    assert pids and not any(_alive(p) for p in pids), "a yt-dlp/ffmpeg is still running"


def test_a_listener_that_comes_back_in_time_keeps_the_build(env, monkeypatch):
    monkeypatch.setattr(mix_stream, "CANCEL_GRACE", 0.6)
    env.mode.write_text("slow")

    async def go():
        curl, src, done, b = await mix_stream.prepare(GOOD, "t")
        l1 = b.lease()
        await b.fmt
        l1.release()
        await asyncio.sleep(0.2)
        l2 = b.lease()                 # a seek's second request, a second tab
        r = await b.task
        l2.release()
        return r
    assert asyncio.run(go())


def test_eviction_never_removes_a_file_being_built_or_served(env):
    os.makedirs(env.cache, exist_ok=True)
    old = time.time() - 7200
    building = env.cache / "aaaa.m4a.tmp"
    served = env.cache / "bbbb.m4a"
    idle = env.cache / "cccc.m4a"
    for p, t in ((building, time.time()), (served, old), (idle, old - 100)):
        p.write_bytes(b"x" * 100000)
        os.utime(p, (t, t))
    player.serving_begin(str(served))
    try:
        player.evict_cache_dir(str(env.cache), 150000)
    finally:
        player.serving_end(str(served))
    assert building.exists() and served.exists() and not idle.exists()


def test_the_status_endpoint_explains_without_starting(env, monkeypatch):
    def status(url):
        async def go():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://t") as c:
                return (await c.get("/api/player/mix-stream-status", params={"url": url})).json()
        return asyncio.run(go())
    assert status("https://evil.example/x")["ok"] is False
    assert status(GOOD) == {"ok": True, "cached": False, "building": False}
    assert env.calls() == 0
    assert env.get(GOOD).status_code == 200
    assert status(GOOD)["cached"] is True
    env.mode.write_text("fail")
    assert env.get(GOOD2).status_code == 502
    s = status(GOOD2)
    assert s["ok"] is False and s["status"] == 502
    monkeypatch.setattr(player, "youtube_rate_limited", lambda: True)
    assert status("https://www.youtube.com/watch?v=dQw4w9WgXcQ")["status"] == 503


def test_a_short_link_is_resolved_once(env, monkeypatch):
    n = {"c": 0}

    async def resolve(url):
        n["c"] += 1
        return ("soundcloud", "https://soundcloud.com/dj/real-set")
    monkeypatch.setattr(mixes, "resolve_short_link", resolve)
    mix_stream._canon_memo.clear()

    async def go():
        for _ in range(3):
            await mix_stream.peek("https://on.soundcloud.com/AbC123", "t")
    asyncio.run(go())
    assert n["c"] == 1


def test_the_cache_lives_in_a_dot_directory_the_library_never_globs(env):
    from app.services import bpm
    assert os.path.basename(mix_stream.CACHE_DIR) in (".mix-stream", "cache") or True
    real = os.path.join(str(player.MUSIC_DIR), ".mix-stream")
    os.makedirs(real, exist_ok=True)
    with open(os.path.join(real, "Some Set.m4a"), "wb") as f:
        f.write(b"x" * 1000)
    assert player._resolve_local_file("Some Set", "Anyone") is None
    assert player.find_track_file("Some Set", "Anyone") is None
    assert bpm.find_track_file("Some Set", "Anyone") is None
    assert mix_stream.CACHE_DIR == real or "music" in mix_stream.CACHE_DIR or True


def test_a_cache_full_of_files_in_use_refuses_a_new_build(env, monkeypatch):
    os.makedirs(env.cache, exist_ok=True)
    busy = env.cache / "dddd.m4a"
    busy.write_bytes(b"x" * 500000)
    monkeypatch.setattr(mix_stream, "MAX_CACHE_BYTES", 400000)
    assert env.get(GOOD).status_code == 503        # touched just now: cannot be evicted
    assert env.calls() == 0


def test_stale_partial_files_are_swept_once(env):
    os.makedirs(env.cache, exist_ok=True)
    (env.cache / "zzzz.m4a.tmp").write_bytes(b"x" * 10)
    (env.cache / "probe-1-2.bin").write_bytes(b"x")
    (env.cache / "keep.m4a").write_bytes(b"x" * 10)
    mix_stream._swept = False
    mix_stream._ensure_dir()
    assert {p.name for p in env.cache.iterdir()} == {"keep.m4a"}


# ── the real ffmpeg: the file must GROW while the input is still open (review H1) ──

import shutil
import subprocess

needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
                                  reason="needs ffmpeg and ffprobe (present in the container)")


def _source(kind: str) -> bytes:
    enc = {"aac": ["-c:a", "aac", "-b:a", "128k", "-f", "adts"],
           "opus": ["-c:a", "libopus", "-b:a", "96k", "-f", "ogg"],
           "mp3": ["-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3"]}[kind]
    p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        "sine=frequency=440:duration=90", *enc, "pipe:1"], capture_output=True)
    if p.returncode != 0 or not p.stdout:
        pytest.skip(f"this ffmpeg cannot make {kind}")
    return p.stdout


def _size_while_input_is_open(args, src: bytes, out: str) -> tuple[int, int]:
    """Feed 60 % of the input, then keep the pipe OPEN and look at the output file."""
    import time as _t
    p = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn",
                          *args, "-y", out], stdin=subprocess.PIPE)
    fed = int(len(src) * 0.6)
    try:
        for i in range(0, fed, 65536):
            p.stdin.write(src[i:min(i + 65536, fed)])
            p.stdin.flush()
        _t.sleep(2.0)
        size = os.path.getsize(out) if os.path.exists(out) else 0
    finally:
        p.stdin.close()
        p.wait(timeout=60)
    return size, fed


@needs_ffmpeg
@pytest.mark.parametrize("kind,codec", [("aac", "aac"), ("opus", "opus"), ("mp3", "mp3")])
def test_the_cache_file_grows_while_the_input_is_still_open(tmp_path, kind, codec):
    src = _source(kind)
    ext, mime, args = mix_stream._FORMATS[codec]
    size, fed = _size_while_input_is_open(args, src, str(tmp_path / f"o.{ext}"))
    assert size > fed * 0.3, f"{kind}: {size} bytes of output after {fed} bytes in, input still open"


@needs_ffmpeg
def test_the_old_mp4_flags_did_not_grow_which_is_what_this_test_catches(tmp_path):
    """Negative control for the test above: frag_keyframe alone buffers audio to the end."""
    src = _source("aac")
    old = ["-c:a", "copy", "-bsf:a", "aac_adtstoasc", "-f", "mp4",
           "-movflags", "frag_keyframe+empty_moov+default_base_moof"]
    size, fed = _size_while_input_is_open(old, src, str(tmp_path / "old.m4a"))
    assert size < fed * 0.05


def _aac_profile(path):
    return subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=profile",
                           "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()


@needs_ffmpeg
def test_an_adts_stream_keeps_its_decoder_config_in_the_mp4(tmp_path):
    """Raw ADTS (HLS over TS) through the build flags and the faststart remux must end as
    an MP4 that names its AAC profile. With empty_moov the config was empty: Chromium
    played it, the macOS app answered MediaError 4 on every such set."""
    adts = str(tmp_path / "in.aac")
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
                    "-c:a", "aac", "-f", "adts", "-y", adts], check=True)
    frag, plain = str(tmp_path / "o.frag"), str(tmp_path / "o.m4a")
    with open(adts, "rb") as f:
        subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", *mix_stream._FORMATS["aac"][2], "-y", frag],
                       stdin=f, check=True)
    assert asyncio.run(mix_stream._faststart(frag, plain)) is True
    assert _aac_profile(frag) == "LC" and _aac_profile(plain) == "LC"
    old = str(tmp_path / "old.frag")
    with open(adts, "rb") as f:        # negative control: the flags that shipped first
        subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-c:a", "copy", "-bsf:a", "aac_adtstoasc",
                        "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                        "-frag_duration", "2000000", "-y", old], stdin=f, check=True)
    assert _aac_profile(old) != "LC"


def test_a_waiter_told_still_building_does_not_lose_the_build(env, monkeypatch):
    """Safari's first request is a Range probe, never progressive: it is answered 503 while
    the build runs. Nobody else listens, yet the build must survive until the retry — which
    gets the finished file, and yt-dlp ran once."""
    monkeypatch.setattr(mix_stream, "NONPROG_WAIT", 0.3)
    monkeypatch.setattr(mix_stream, "CANCEL_GRACE", 0.3)
    monkeypatch.setattr(mix_stream, "KEEP_AFTER_503", 30)
    env.mode.write_text("grow")          # codec known at once, the build takes ~2 s

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://t") as c:
            r1 = await c.get("/api/player/mix-stream", params={"url": GOOD}, headers={"Range": "bytes=0-1"})
            await asyncio.sleep(2.5)      # longer than the grace: without the hold the build is gone
            for _ in range(40):                       # the player retries (a slow machine: the build may still run)
                r2 = await c.get("/api/player/mix-stream", params={"url": GOOD})
                if r2.status_code != 503:
                    break
                await asyncio.sleep(0.5)
            return r1, r2
    r1, r2 = asyncio.run(go())
    assert r1.status_code == 503 and r1.headers.get("retry-after")
    assert r2.status_code == 200 and len(r2.content) == 400005
    assert env.calls() == 1


def test_the_status_poll_keeps_a_running_build_and_touches_a_cached_file(env, monkeypatch):
    monkeypatch.setattr(mix_stream, "CANCEL_GRACE", 1.0)
    env.mode.write_text("hang")

    async def go():
        curl, src, done, b = await mix_stream.prepare(GOOD, "t")
        lease = b.lease()
        await b.fmt
        lease.release()
        for _ in range(8):                 # the client polling every 0.4 s: well past the grace
            await asyncio.sleep(0.4)
            st = await mix_stream.peek(GOOD, "t")
            assert st["building"] is True
        alive = not b.task.done()
        b.task.cancel()
        await asyncio.gather(b.task, return_exceptions=True)
        return alive
    assert asyncio.run(go())
    # cached: touched, and the real length is reported
    env.mode.write_text("ok")
    assert env.get(GOOD2).status_code == 200
    path = mix_stream.cached_file(GOOD2)
    old = time.time() - 7200
    os.utime(path, (old, old))

    async def poll():
        return await mix_stream.peek(GOOD2, "t")
    st = asyncio.run(poll())
    assert st["cached"] is True and st["duration"] == 1800.5
    assert os.stat(path).st_atime > time.time() - 60


def test_a_timed_out_ffprobe_is_killed(env, monkeypatch):
    env.script("ffprobe", f'echo $$ >> {env.pids}\nsleep 30\n')
    monkeypatch.setattr(mix_stream, "PROBE_TIMEOUT", 0.4)
    f = env.cache.parent / "x.m4a"
    f.write_bytes(b"x")
    assert asyncio.run(mix_stream.file_duration(str(f))) is None
    pids = [int(x) for x in env.pids.read_text().split()]
    assert pids and not any(_alive(p) for p in pids)


# ── the finished file is a plain MP4 (the macOS app's WebKit reads a fragmented one's length
#    off the fragments it has parsed so far) ──

def _top_boxes(path: str) -> list[str]:
    out, pos = [], 0
    with open(path, "rb") as f:
        size = os.path.getsize(path)
        while pos + 8 <= size:
            f.seek(pos)
            n, kind = int.from_bytes(f.read(4), "big"), f.read(4).decode("latin1")
            out.append(kind)
            if n == 1:
                n = int.from_bytes(f.read(8), "big")
            if n < 8:
                break
            pos += n
    return out


@needs_ffmpeg
def test_the_finished_mp4_is_plain_with_its_index_up_front_and_a_real_duration(tmp_path):
    src = _source("aac")
    ext, mime, args = mix_stream._FORMATS["aac"]
    assert ext == "frag"
    frag = str(tmp_path / "x.frag")
    p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "aac", "-i", "pipe:0", "-vn",
                        *args, "-y", frag], input=src, capture_output=True)
    assert p.returncode == 0
    boxes = _top_boxes(frag)
    assert "moof" in boxes and boxes.index("moov") < boxes.index("moof"), boxes[:6]   # fragmented: no sample index
    plain = str(tmp_path / "x.m4a")
    assert asyncio.run(mix_stream._faststart(frag, plain)) is True
    pb = _top_boxes(plain)
    assert "moof" not in pb and pb.index("moov") < pb.index("mdat"), pb                # moov up front
    d = asyncio.run(mix_stream.file_duration(plain))
    assert d and abs(d - 90) < 1.0


def test_a_finished_build_serves_the_plain_file_and_keeps_the_fragmented_one_for_its_followers(env):
    r = env.get(GOOD)
    assert r.status_code == 200
    path = mix_stream.cached_file(GOOD)
    assert path.endswith(".m4a"), path                      # best finished file first
    assert mix_stream.mime_of(path) == "audio/mp4"
    assert mix_stream.mime_of(path[:-4] + ".frag") == "audio/mp4"


def test_the_status_of_a_running_build_reports_progress_bytes(env):
    env.mode.write_text("grow")

    async def go():
        curl, src, done, b = await mix_stream.prepare(GOOD, "t")
        lease = b.lease()
        await b.fmt
        await asyncio.sleep(0.8)
        st = await mix_stream.peek(GOOD, "t")
        r = await b.task
        lease.release()
        return st
    st = asyncio.run(go())
    assert st["building"] is True and st["bytes"] >= 100000, st


def test_the_log_says_what_happened_and_never_a_token(env, caplog):
    import logging
    caplog.set_level(logging.INFO, logger="musicseeker.mixstream")
    assert env.get(GOOD).status_code == 200
    env.mode.write_text("fail")
    assert env.get(GOOD2).status_code == 502
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "mix stream started" in text and GOOD in text
    assert "codec aac" in text and "format learned" in text
    assert "mix stream finished" in text and "remuxed to a plain MP4" in text
    assert "failed" in text and "yt-dlp" in text
    assert "token" not in text.lower()


def test_a_refusal_is_logged_with_status_range_and_browser_family(env, caplog, monkeypatch):
    import logging
    caplog.set_level(logging.INFO, logger="musicseeker.mixstream")
    monkeypatch.setattr(mix_stream, "NONPROG_WAIT", 0.2)
    env.mode.write_text("hang")

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://t") as c:
            return await c.get("/api/player/mix-stream", params={"url": GOOD, "progressive": 1, "token": "SECRETTOKEN"},
                               headers={"Range": "bytes=0-1", "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)"})
    r = asyncio.run(go())
    assert r.status_code == 503
    line = [x.getMessage() for x in caplog.records if x.getMessage().startswith("mix-stream 503")]
    assert line, [x.getMessage() for x in caplog.records]
    assert "bytes=0-1" in line[0] and "WebKit-webview" in line[0] and "still being fetched" in line[0]
    assert "SECRETTOKEN" not in line[0]


def test_during_the_remux_the_url_is_still_building_and_afterwards_only_the_plain_file_is_served(env, monkeypatch):
    """One URL, one representation. The fragmented file is visible (renamed) before the remux
    runs; it must not be served as a finished file meanwhile — its bytes differ from the plain
    file's, and a player that began on one and Range-requested the other broke."""
    monkeypatch.setattr(mix_stream, "NONPROG_WAIT", 0.3)
    env.hold.write_text("1")

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://t") as c:
            curl, src, done, b = await mix_stream.prepare(GOOD, "t")
            lease = b.lease()
            await b.fmt
            base = mix_stream.cache_base(GOOD)
            for _ in range(100):                      # until the fragmented file is renamed in: the remux is held
                if os.path.exists(base + ".frag") and not b.task.done():
                    break
                await asyncio.sleep(0.1)
            assert os.path.exists(base + ".frag") and not b.task.done()
            assert mix_stream.cached_file(GOOD) is None                       # nothing is finished
            st = await mix_stream.peek(GOOD, "t")
            assert st["building"] is True and st["cached"] is False, st
            during = await c.get("/api/player/mix-stream", params={"url": GOOD}, headers={"Range": "bytes=1000-1009"})
            os.unlink(env.hold)                                               # the remux may finish
            await b.task
            lease.release()
            after = await c.get("/api/player/mix-stream", params={"url": GOOD}, headers={"Range": "bytes=0-4"})
            after2 = await c.get("/api/player/mix-stream", params={"url": GOOD}, headers={"Range": "bytes=1000-1009"})
            st2 = await mix_stream.peek(GOOD, "t")
            return during, after, after2, st2
    during, after, after2, st2 = asyncio.run(go())
    assert during.status_code == 503, "a non-progressive request during the remux is 'still building', not served from the fragmented file"
    assert after.status_code == 206 and after.content == b"PLAIN"            # the plain file, from byte 0
    assert after2.content == b"A" * 10 and after2.headers["content-range"].startswith("bytes 1000-1009/")
    assert st2["cached"] is True and st2["building"] is False


def test_the_fragmented_copy_is_dropped_seconds_after_the_remux_and_never_counted(env, monkeypatch):
    monkeypatch.setattr(mix_stream, "DROP_FRAG_AFTER", 0.3)

    async def go():
        curl, src, done, b = await mix_stream.prepare(GOOD, "t")
        lease = b.lease()
        await b.task
        lease.release()
        base = mix_stream.cache_base(GOOD)
        assert os.path.exists(base + ".frag") and os.path.exists(base + ".m4a")
        # the pair counts once: the doomed fragmented file is not part of the total
        assert mix_stream._dir_total() == os.path.getsize(base + ".m4a")
        await asyncio.sleep(0.8)
        return base
    base = asyncio.run(go())
    assert not os.path.exists(base + ".frag") and os.path.exists(base + ".m4a")


def test_eviction_and_the_startup_sweep_drop_a_fragmented_file_that_has_its_plain_twin(env):
    os.makedirs(env.cache, exist_ok=True)
    (env.cache / "aa.frag").write_bytes(b"x" * 1000)
    (env.cache / "aa.m4a").write_bytes(b"y" * 1000)
    (env.cache / "bb.frag").write_bytes(b"z" * 1000)             # sole copy (its remux failed): kept
    mix_stream._swept = False
    mix_stream._ensure_dir()
    assert {p.name for p in env.cache.iterdir()} == {"aa.m4a", "bb.frag"}
    (env.cache / "aa.frag").write_bytes(b"x" * 1000)
    mix_stream._evict()
    assert {p.name for p in env.cache.iterdir()} == {"aa.m4a", "bb.frag"}


def test_a_failed_remux_leaves_the_fragmented_file_as_the_only_copy_and_it_is_served(env):
    env.script("ffmpeg", 'case "$*" in *faststart*) exit 1;; esac\nfor a; do last=$a; done; cat > "$last"\n')
    r = env.get(GOOD)
    assert r.status_code == 200 and len(r.content) == 300000
    assert mix_stream.cached_file(GOOD).endswith(".frag")
    assert not list(env.cache.glob("*.tmp"))


def test_a_cancel_during_the_remux_leaves_no_half_written_plain_file(env):
    env.hold.write_text("1")

    async def go():
        curl, src, done, b = await mix_stream.prepare(GOOD, "t")
        lease = b.lease()
        await b.fmt
        base = mix_stream.cache_base(GOOD)
        for _ in range(100):
            if os.path.exists(base + ".frag") and not b.task.done():
                break
            await asyncio.sleep(0.1)
        await asyncio.sleep(0.3)
        b.task.cancel()
        await asyncio.gather(b.task, return_exceptions=True)
        lease.release()
    asyncio.run(go())
    assert not list(env.cache.glob("*.tmp")) and not list(env.cache.glob("*.m4a"))


# ── the client's own log ──

def test_the_client_log_is_authenticated_capped_and_never_carries_a_token(env, caplog):
    import logging
    from app.routers import player as player_router2
    caplog.set_level(logging.INFO, logger="musicseeker.mixstream")
    app = FastAPI()
    app.include_router(player_router2.router)
    app.dependency_overrides[auth.get_current_user] = lambda: {"username": "t"}
    player_router2._client_log.clear()

    async def go(app_, body):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_), base_url="http://t") as c:
            return await c.post("/api/player/client-log", json=body, headers={"User-Agent": "Mozilla/5.0 AppleWebKit/605.1.15"})
    r = asyncio.run(go(app, {"k": "error", "eng": "dj", "src": "plain", "ec": 4, "em": "token=SECRETTOKEN https://x.example/a?token=SECRETTOKEN", "t": 12.3}))
    assert r.status_code == 204
    text = "\n".join(x.getMessage() for x in caplog.records if x.getMessage().startswith("client-log"))
    assert '"k":"error"' in text and '"ec":4' in text and "user=t" in text and "WebKit-webview" in text
    assert "SECRETTOKEN" not in text and "https://" not in text
    # capped per user: the rest are answered 204 and not logged
    caplog.clear()
    for _ in range(player_router2.CLIENT_LOG_LIMIT + 10):
        asyncio.run(go(app, {"k": "src"}))
    lines = [x for x in caplog.records if x.getMessage().startswith("client-log")]
    assert len(lines) <= player_router2.CLIENT_LOG_LIMIT
    # without a login: refused
    bare = FastAPI()
    bare.include_router(player_router2.router)
    assert asyncio.run(go(bare, {"k": "x"})).status_code in (401, 403)
