"""Playing a mix straight from its site, without downloading it into the library.

A search result can be played at once: `GET /api/player/mix-stream?url=` builds a CACHE
file (never the library: not under the music folder, never tagged, never in mixes.json,
never scanned by Navidrome, never analysed for BPM) and the deck follows it while it
grows (player.follow_build, the same machinery a not-yet-transcoded Navidrome song uses).

How the file is made: `yt-dlp -o -` writes the best stream (AAC before Opus, the same
selector as a download) to a pipe; the first chunk is probed with ffprobe to learn the
codec, then ffmpeg COPIES the stream into a container that can be read while it is being
written — fragmented MP4 for AAC, Ogg for Opus/Vorbis, MP3 for MP3. Nothing is
re-encoded unless the codec is something else (then MP3 192k). Most sites serve HLS, so a
plain proxy of one URL could not work, and yt-dlp's own `-x` only produces a file at the
very end.

Guards (what this protects, and from what):
 - the URL is parsed by mixes.canonical — only Mixcloud / SoundCloud / hearthis.at /
   YouTube watch links, rebuilt from their parts — and goes to yt-dlp after `--`;
 - ONE build per URL however many requests ask (two decks, Range requests, a second tab);
 - at most USER_BUILDS builds per user, GLOBAL_BUILDS in all, else 429 at once;
 - a URL that failed is answered 502 at once for FAIL_TTL, so the player's retry and
   auto-advance cannot become a request storm; a YouTube refusal parks the YouTube arm
   through the same latch the player uses (player.note_youtube_rate_limit);
 - a download that was cut short (yt-dlp failed, or ffmpeg encoded less than the input
   declared) is never cached;
 - the cache is bounded (MAX_CACHE_BYTES, oldest first, never a file being sent or
   touched in the last 5 minutes) and so is one file (MAX_FILE_BYTES);
 - nothing is held in memory: bytes go pipe to pipe to disk, and the page cache the
   file fills is given back every PAGECACHE_EVERY bytes (the container is limited to
   2 GiB and counts page cache — it was OOM-killed twice by file work).
"""
import asyncio
import glob
import hashlib
import logging
import os
import re
import signal
import tempfile
import time
import weakref

from app.services import mixes, player

logger = logging.getLogger("musicseeker.mixstream")

# Under the music root, hidden like .mix-dl (a dot-directory: the library globs and Navidrome
# never see it) and on the same btrfs volume: on the container's overlay /tmp
# POSIX_FADV_DONTNEED gave back only a third of the page cache it filled (measured), and
# the 2 GiB memory limit counts that cache.
CACHE_DIR = os.path.join(str(player.MUSIC_DIR), ".mix-stream")
MAX_CACHE_BYTES = 600 * 1024 * 1024      # finished files AND files being built
MAX_FILE_BYTES = 400 * 1024 * 1024       # one set (a 3 h AAC 192 set is ~250 MB)
BUILD_TIMEOUT = 60 * 60
PROBE_BYTES = 128 * 1024
PROBE_TIMEOUT = 20
FORMAT_TIMEOUT = 40          # how long a request waits for the build to learn the codec
REQUEST_BUDGET = 45          # one request never waits longer in all (nginx cuts at 60 s)
CANCEL_GRACE = 20.0          # a build nobody listens to any more is cancelled after this
KEEP_AFTER_503 = 65.0        # a request that was told "still building" will come back: keep the build for it
NONPROG_WAIT = 1.5           # a request that cannot be answered progressively waits this long at most (WebKit's Range probe: the page then waits visibly, not in silence)
INFO_TIMEOUT = 30            # the server's own look at the mix's length
DROP_FRAG_AFTER = 5.0        # the fragmented copy goes this long after the remux (followers keep their descriptor)
MIN_BYTES = 16 * 1024        # anything smaller is a header, not a mix
SHORT_RATIO = 0.85           # a result clearly shorter than the search said is a cut download
MAX_DURATION = 6 * 3600      # yt-dlp --match-filter: no ten-hour videos
FAIL_TTL = 120.0             # a URL that failed is not tried again for this long
FAIL_MAX = 200
USER_BUILDS = 2
GLOBAL_BUILDS = 4
PAGECACHE_EVERY = 32 * 1024 * 1024

SELECTOR = mixes.FORMAT_SELECTOR   # the download's: AAC before Opus, never a 30 s preview

# codec name (ffprobe) -> (extension, mime, ffmpeg output args)
# frag_keyframe cuts fragments only at VIDEO keyframes: with audio alone ffmpeg held the
# whole set in memory and wrote nothing until its input ended (measured: 28 bytes for the
# entire fetch). -frag_duration makes a fragment every 2 s. aac_adtstoasc: raw ADTS (HLS
# over TS) needs it for mp4; an AAC stream that already has its config passes through.
# delay_moov, NOT empty_moov: the decoder config of an ADTS stream is only known from its
# first packet, and empty_moov writes the header before that — an MP4 with an empty config.
# Chromium decodes it anyway; AVFoundation (the macOS app, iOS) refuses the file outright
# (MediaError 4, `afinfo`: AudioFileOpenURL failed), and the faststart remux copies the
# hole. Every Mixcloud HQ / SoundCloud HLS set was built that way until 2026-11-23.
_MP4_ARGS = ["-c:a", "copy", "-bsf:a", "aac_adtstoasc", "-f", "mp4",
             "-movflags", "frag_keyframe+delay_moov+default_base_moof", "-frag_duration", "2000000"]
_FORMATS = {
    "aac": ("frag", "audio/mp4", _MP4_ARGS),     # fragmented while building; remuxed to a plain .m4a at the end
    "opus": ("opus", "audio/ogg", ["-c:a", "copy", "-f", "ogg"]),
    "vorbis": ("ogg", "audio/ogg", ["-c:a", "copy", "-f", "ogg"]),
    "mp3": ("mp3", "audio/mpeg", ["-c:a", "copy", "-f", "mp3"]),
}
_FALLBACK = ("mp3", "audio/mpeg", ["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"])   # a codec we know nothing of
# Finished files, best first: the plain MP4 (moov up front, a real duration) before the
# fragmented one a failed remux leaves.
_EXTS = ["m4a", "frag", "opus", "ogg", "mp3"]


_FF_TIME = re.compile(r"time=\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)")


class MixStreamError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _release(build: "Build", state: list) -> None:
    if state[0]:
        state[0] = False
        build._left()


class _Lease:
    """One listener's hold on a build. release() is idempotent — it also runs when the
    lease is garbage collected without ever having been released (a response that never
    started because the client left before its first byte)."""
    def __init__(self, build: "Build"):
        self.build = build
        self.state = [True]
        build.listeners += 1
        build._cancel_cancel()
        weakref.finalize(self, _release, build, self.state)

    def release(self) -> None:
        _release(self.build, self.state)


class Build:
    """One build of one URL, shared by every request for it."""
    def __init__(self, base: str, user: str):
        self.base = base                      # cache path without extension
        self.user = user
        self.fmt: asyncio.Future = asyncio.get_running_loop().create_future()   # (ext, mime, path)
        self.task: asyncio.Task | None = None
        self.listeners = 0
        self._grace: asyncio.TimerHandle | None = None
        self.hold_until = 0.0
        self.bytes = 0                        # source bytes fed to ffmpeg so far
        self.media_seconds = 0.0              # audio ffmpeg has written (its own `time=`)
        self.expected = 0.0                   # the length the SERVER learned (yt-dlp info), 0 = unknown
        self.started = time.monotonic()
        self._loop = asyncio.get_running_loop()
        self.fmt.add_done_callback(lambda f: f.cancelled() or f.exception())   # never 'not retrieved'

    def lease(self) -> _Lease:
        return _Lease(self)

    def _cancel_cancel(self) -> None:
        if self._grace is not None:
            self._grace.cancel()
            self._grace = None

    def _left(self) -> None:
        self.listeners -= 1
        if self.listeners <= 0 and self.task is not None and not self.task.done():
            self._cancel_cancel()
            self._grace = self._loop.call_later(CANCEL_GRACE, self._abandon)

    def keep(self, seconds: float) -> None:
        """Somebody is about to come back (a request told "still building", a client polling
        the status): do not cancel the build for at least this long."""
        self.hold_until = max(self.hold_until, time.monotonic() + seconds)

    def _abandon(self) -> None:
        self._grace = None
        if self.listeners <= 0 and self.task is not None and not self.task.done():
            left = self.hold_until - time.monotonic()
            if left > 0:
                self._grace = self._loop.call_later(left + 1, self._abandon)
                return
            logger.info("mix stream abandoned: nobody is listening, cancelling the build")
            self.task.cancel()


_builds: dict[str, Build] = {}        # canonical url -> running build
_failed: dict[str, float] = {}        # canonical url -> when it failed
_user_count: dict[str, int] = {}
_canon_memo: dict[str, tuple[str, str]] = {}
_swept = False
_frag_pending: set[str] = set()      # fragmented files with a drop already scheduled (their followers are finishing)


def cache_base(curl: str) -> str:
    return os.path.join(CACHE_DIR, hashlib.sha1(curl.encode()).hexdigest()[:20])


def cached_file(curl: str) -> str | None:
    """The finished cache file for this URL, if there is one.

    One URL, one representation: while the build runs — which includes the remux of the
    fragmented file into the plain MP4 — NOTHING is finished, whatever is on disk (the
    fragmented file is visible once renamed, and its bytes differ from the plain file's from
    offset 12: a player that began on one and Range-requested the other broke). The fragmented
    file is a finished file only when it is the sole copy (the remux failed or was cancelled)."""
    building = curl in _builds
    for ext in _EXTS:
        if building and ext == "frag":
            continue
        p = f"{cache_base(curl)}.{ext}"
        try:
            if os.path.getsize(p) > 0:
                return p
        except OSError:
            continue
    return None


def _recently_failed(curl: str) -> bool:
    t = _failed.get(curl)
    if t is None:
        return False
    if time.monotonic() - t > FAIL_TTL:
        _failed.pop(curl, None)
        return False
    return True


def _note_failure(curl: str) -> None:
    if len(_failed) >= FAIL_MAX:
        _failed.clear()
    _failed[curl] = time.monotonic()


def _dir_total() -> int:
    """Bytes in the cache directory: finished files AND the ones being built. A fragmented file
    with its plain MP4 beside it is doomed (dropped seconds after the remux) and not counted."""
    total = 0
    try:
        with os.scandir(CACHE_DIR) as it:
            for e in it:
                try:
                    if e.is_file(follow_symlinks=False):
                        if e.name.endswith(".frag") and os.path.exists(e.path[:-5] + ".m4a"):
                            continue
                        total += e.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
    except OSError:
        pass
    return total


def sweep_stale() -> None:
    """Nothing is being built when the process starts: every .tmp and probe file left in
    the cache directory by a killed process is garbage (cf. mixes._drop_stale_scratch)."""
    try:
        with os.scandir(CACHE_DIR) as it:
            for e in it:
                doomed = e.name.endswith(".frag") and os.path.exists(e.path[:-5] + ".m4a")
                if e.name.endswith(".tmp") or e.name.startswith("probe-") or doomed:
                    try:
                        os.unlink(e.path)
                    except OSError:
                        pass
    except OSError:
        pass


def _ensure_dir() -> None:
    global _swept
    os.makedirs(CACHE_DIR, exist_ok=True)
    try:
        os.chmod(CACHE_DIR, 0o700)
    except OSError:
        pass
    if not _swept:
        _swept = True
        sweep_stale()


async def _kill(proc) -> None:
    """Kill the process AND its children: both are started as session leaders, because
    yt-dlp may run an ffmpeg of its own and an orphan of that would keep the pipe (and the
    download) alive after yt-dlp itself is gone."""
    if proc is not None and proc.returncode is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    if proc is not None:
        try:
            await asyncio.wait_for(proc.wait(), timeout=10)
        except Exception:
            pass


async def _probe_codec(first: bytes) -> str | None:
    """ffprobe's codec name for the audio in the first bytes of the stream. The bytes go
    through a small file, not ffprobe's stdin: it leaves as soon as it has what it needs,
    and a write into the closed pipe leaves an "exception never retrieved" behind."""
    probe = os.path.join(CACHE_DIR, f"probe-{os.getpid()}-{time.monotonic_ns()}.bin")
    try:
        with open(probe, "wb") as f:
            f.write(first)
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=codec_name", "-of", "csv=p=0", probe,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    except Exception:
        return None
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=PROBE_TIMEOUT)
    except Exception:
        await _kill(proc)
        return None
    finally:
        try:
            os.unlink(probe)
        except OSError:
            pass
    name = (out or b"").decode("utf-8", "replace").strip().splitlines()
    return name[0].strip().lower() if name else None


async def file_duration(path: str) -> float | None:
    """Seconds, read by ffprobe from the finished file (a pipe reports a bogus length)."""
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=PROBE_TIMEOUT)
        v = float((out or b"").decode().strip().splitlines()[0])
        return v if v > 0 else None
    except Exception:
        return None
    finally:
        await _kill(proc)             # a timed-out ffprobe is killed and reaped, not left running


async def _faststart(src: str, dst: str) -> bool:
    """Remux the fragmented file into a plain MP4 — moov up front, a real duration — without
    re-encoding. A fragmented MP4 with no index is what a browser has to scan to learn its
    length; WebKit (the macOS app's WKWebView, Safari) reads its duration off the fragments it
    has parsed so far and fires `ended` there. The plain file is what every player expects."""
    proc = None
    ok = False
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", src, "-c:a", "copy",
            "-movflags", "+faststart", "-f", "mp4", "-y", dst,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True)
        await asyncio.wait_for(proc.wait(), timeout=300)
        ok = proc.returncode == 0 and os.path.getsize(dst) > MIN_BYTES
    except Exception:
        ok = False
    finally:
        # A cancel lands here too (CancelledError is not an Exception): kill ffmpeg and never
        # leave a half-written .tmp behind.
        try:
            await _kill(proc)
        finally:
            if not ok:
                try:
                    os.unlink(dst)
                except OSError:
                    pass
    return ok


def _drop_fragmented(path: str) -> None:
    """The fragmented file of a build whose plain MP4 exists. A progressive response still
    following it holds an open descriptor: unlinking is safe and only the path goes. Its page
    cache is handed back first (it was read twice: followed, then remuxed)."""
    _frag_pending.discard(path)
    plain = path[:-len(".frag")] + ".m4a" if path.endswith(".frag") else ""
    if plain and os.path.exists(plain):
        mixes.release_page_cache(path)
        try:
            os.unlink(path)
        except OSError:
            pass


def _drop_doomed() -> None:
    """A fragmented file with its plain MP4 beside it is never kept (a restart loses the
    timer; eviction may have taken only one of the pair)."""
    try:
        for name in os.listdir(CACHE_DIR):
            path = os.path.join(CACHE_DIR, name)
            if name.endswith(".frag") and path not in _frag_pending:   # not one whose followers are still finishing
                _drop_fragmented(path)
    except OSError:
        pass


def _evict() -> None:
    """player.evict_cache_dir, saying which files went."""
    _drop_doomed()
    try:
        before = set(os.listdir(CACHE_DIR))
    except OSError:
        before = set()
    player.evict_cache_dir(CACHE_DIR, MAX_CACHE_BYTES)
    try:
        gone = before - set(os.listdir(CACHE_DIR))
    except OSError:
        gone = set()
    for name in sorted(gone):
        logger.info("mix stream evicted %s", name)


async def _expected_duration(curl: str) -> float:
    """What the SERVER knows of the mix's length (yt-dlp's own info; hearthis' API): the
    only thing a download may be judged short against. The length the client sent decides
    nothing — it is one user's input and the build is shared."""
    try:
        info = await asyncio.wait_for(mixes.fetch_info(curl), timeout=INFO_TIMEOUT)
        d = float(info.get("duration") or 0)
        return d if 0 < d <= 86400 else 0.0
    except Exception:
        return 0.0


def _ytdlp_cmd(curl: str) -> list[str]:
    return ["yt-dlp", "-f", SELECTOR, "--no-playlist", "--no-part", "--quiet", "--no-warnings",
            "--concurrent-fragments", "4", "--abort-on-unavailable-fragments",
            "--match-filter", f"!is_live & duration <? {MAX_DURATION}",
            "--max-filesize", str(MAX_FILE_BYTES), "-o", "-", "--", curl]


async def _run(curl: str, source: str, build: Build) -> str | None:
    """Fetch `curl` into build.base + ext. Returns the finished path or None."""
    ytdlp = ffmpeg = None
    tmp = None
    pump_task = None
    info_task = None
    try:
        _ensure_dir()
        info_task = asyncio.ensure_future(_expected_duration(curl))
        info_task.add_done_callback(lambda t: setattr(build, "expected", t.result() if not t.cancelled() and not t.exception() else 0.0))
        ytdlp = await asyncio.create_subprocess_exec(
            *_ytdlp_cmd(curl), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True)
        err_lines: list[str] = []

        async def _drain_err():
            while True:
                line = await ytdlp.stderr.readline()
                if not line:
                    return
                err_lines.append(line.decode("utf-8", "replace").strip())
                del err_lines[:-20]
        err_task = asyncio.ensure_future(_drain_err())

        first = b""
        while len(first) < PROBE_BYTES:
            chunk = await asyncio.wait_for(ytdlp.stdout.read(65536), timeout=90)
            if not chunk:
                break
            first += chunk
        if not first:
            await asyncio.sleep(0.2)          # let the stderr reader catch up: say WHY
            tail = " | ".join(err_lines[-4:])
            if source == "youtube":
                mixes._note_youtube_stderr(f"mix stream {curl[-11:]}", tail)
            raise RuntimeError(f"no data from yt-dlp (exit {ytdlp.returncode}): {tail[-300:]}")
        codec = await _probe_codec(first)
        if not codec:
            # Do not guess: an input ffprobe cannot identify from its first bytes (an mp4 with
            # its index at the end cannot be read from a pipe at all) is not re-encoded into
            # something that "works" — it is a failure, remembered for FAIL_TTL.
            raise RuntimeError("unidentifiable stream (not readable from a pipe)")
        ext, mime, out_args = _FORMATS.get(codec, _FALLBACK)
        logger.info("mix stream %s: codec %s, building a .%s (format learned after %.1fs)", curl, codec, ext, time.monotonic() - build.started)
        final = f"{build.base}.{ext}"
        tmp = final + ".tmp"
        player._fresh_tmp(tmp)
        ffmpeg = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "info", "-i", "pipe:0", "-vn", *out_args,
            "-y", tmp,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE, start_new_session=True)
        ff_err: list[bytes] = []

        async def _ff_drain():
            head, tailb = b"", b""
            while True:
                chunk = await ffmpeg.stderr.read(4096)
                if not chunk:
                    break
                if len(head) < 3000:
                    head += chunk
                tailb = (tailb + chunk)[-12000:]
                m = _FF_TIME.findall(chunk.decode("utf-8", "replace"))
                if m:
                    h, mi, sec = m[-1]
                    build.media_seconds = int(h) * 3600 + int(mi) * 60 + float(sec)
            ff_err.append(head[:3000] + tailb)
        ff_task = asyncio.ensure_future(_ff_drain())
        if not build.fmt.done():
            build.fmt.set_result((ext, mime, final))

        async def _pump():
            sent = 0
            since_drop = 0
            data = first
            try:
                while True:
                    ffmpeg.stdin.write(data)
                    await ffmpeg.stdin.drain()
                    sent += len(data)
                    build.bytes = sent
                    since_drop += len(data)
                    if sent > MAX_FILE_BYTES:
                        raise RuntimeError("mix too large")
                    if since_drop >= PAGECACHE_EVERY:
                        since_drop = 0
                        await asyncio.to_thread(mixes.release_page_cache, tmp)
                        if _dir_total() > MAX_CACHE_BYTES + MAX_FILE_BYTES:
                            raise RuntimeError("cache directory over its bound")
                    data = await ytdlp.stdout.read(65536)
                    if not data:
                        break
            finally:
                try:
                    ffmpeg.stdin.close()
                except Exception:
                    pass
        pump_task = asyncio.ensure_future(_pump())
        await asyncio.wait_for(pump_task, timeout=BUILD_TIMEOUT)
        await asyncio.wait_for(asyncio.gather(ffmpeg.wait(), ytdlp.wait(), ff_task, err_task),
                               timeout=120)
        ff_text = (ff_err[0] if ff_err else b"").decode("utf-8", "replace").replace("\r", "\n")
        if ytdlp.returncode != 0 or ffmpeg.returncode != 0:
            tail = "\n".join(err_lines[-6:] + [l for l in ff_text.splitlines() if l.strip()][-4:])
            if source == "youtube":
                mixes._note_youtube_stderr(f"mix stream {curl[-11:]}", tail)
            raise RuntimeError(f"fetch failed (yt-dlp {ytdlp.returncode}, ffmpeg {ffmpeg.returncode}): {tail[-300:]}")
        # ffmpeg exits 0 on an input it could not read: "Output file is empty, nothing was
        # encoded" leaves a header of a few hundred bytes. That is not a mix.
        if "output file is empty" in ff_text.lower() or "nothing was encoded" in ff_text.lower():
            raise RuntimeError("ffmpeg encoded nothing")
        size = os.path.getsize(tmp)
        if size < MIN_BYTES:
            raise RuntimeError(f"output of {size} bytes")
        dur = await file_duration(tmp)
        if not dur:
            raise RuntimeError("the finished file has no readable duration")
        expected = await info_task
        if expected > 60 and dur < expected * SHORT_RATIO:
            raise RuntimeError(f"cut short: {dur:.0f}s of the {expected:.0f}s the site says")
        await asyncio.to_thread(mixes.release_page_cache, tmp)
        os.rename(tmp, final)          # same inode: a follower keeps reading across it
        tmp = None
        info = f"{size / 1e6:.1f} MB, {dur:.0f}s of audio in {time.monotonic() - build.started:.0f}s"
        if ext == "frag":
            # Followers hold the fragmented file's inode (the `final` path is what they are told
            # to compare); the plain MP4 that every later request gets is made beside it.
            plain = f"{build.base}.m4a"
            if await _faststart(final, plain + ".tmp"):
                # The plain file becomes visible only now — and cached_file ignores the
                # fragmented one while this build is registered, so no request ever met two
                # representations of the URL.
                await asyncio.to_thread(mixes.release_page_cache, plain + ".tmp")
                os.rename(plain + ".tmp", plain)
                await asyncio.to_thread(mixes.release_page_cache, final)
                info += ", remuxed to a plain MP4"
                _frag_pending.add(final)
                asyncio.get_running_loop().call_later(DROP_FRAG_AFTER, _drop_fragmented, final)
            else:
                info += ", REMUX FAILED (the fragmented file stays)"
        logger.info("mix stream finished %s: %s", curl, info)
        _evict()
        return final
    except asyncio.CancelledError:
        logger.info("mix stream %s cancelled after %.0fs (%.1f MB fetched)", curl, time.monotonic() - build.started, build.bytes / 1e6)
        raise
    except Exception as e:
        logger.warning("mix stream of %s failed: %s", curl, str(e)[:400])
        _note_failure(curl)
        return None
    finally:
        # The partial file goes FIRST and synchronously: once the build is out of _builds a
        # new build of the same URL may start and _fresh_tmp its own .tmp — which a later
        # unlink of ours would delete. Then the bookkeeping, then the awaiting clean-up (a
        # cancelled task must not leave a build registered that no longer exists).
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        _builds.pop(curl, None)
        n = _user_count.get(build.user, 1) - 1
        if n > 0:
            _user_count[build.user] = n
        else:
            _user_count.pop(build.user, None)
        build._cancel_cancel()
        if not build.fmt.done():
            build.fmt.set_exception(MixStreamError(502, "Could not fetch this mix"))
        if info_task is not None and not info_task.done():
            info_task.cancel()
        if pump_task is not None:
            if not pump_task.done():
                pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)   # retrieved: no log noise
        await _kill(ffmpeg)
        await _kill(ytdlp)


async def _canonical(url: str) -> tuple[str, str] | None:
    """mixes.canonical, with an on.soundcloud.com short link resolved once (each
    resolution is an outgoing request, and every stream request would repeat it)."""
    parsed = mixes.parse_mix_url(url)
    if parsed and parsed[0] == "soundcloud-short":
        hit = _canon_memo.get(parsed[1])
        if hit:
            return hit
        res = await mixes.resolve_short_link(parsed[1])
        if res:
            if len(_canon_memo) > 200:
                _canon_memo.clear()
            _canon_memo[parsed[1]] = res
        return res
    return parsed


def _gate(curl: str, source: str, username: str) -> None:
    """Raise the MixStreamError a NEW build would meet (not for a cached or running one)."""
    if _recently_failed(curl):
        raise MixStreamError(502, "This mix could not be fetched a moment ago — try again later")
    if source == "youtube" and player.youtube_rate_limited():
        raise MixStreamError(503, "YouTube is rate-limiting us — try again in a few minutes")
    if _user_count.get(username, 0) >= USER_BUILDS or len(_builds) >= GLOBAL_BUILDS:
        raise MixStreamError(429, "Too many mixes are being prepared — wait a moment")


async def prepare(url: str, username: str) -> tuple[str, str, str | None, Build | None]:
    """Validate `url` and make sure its file exists or is being built.

    Returns (canonical url, source, finished_path_or_None, running_build_or_None).
    The caller takes a lease on the build at once. Raises MixStreamError."""
    parsed = await _canonical(url)
    if not parsed or parsed[0] not in ("mixcloud", "soundcloud", "hearthis", "youtube"):
        raise MixStreamError(400, mixes.NOT_A_MIX)
    source, curl = parsed
    b = _builds.get(curl)
    if b is not None:
        return curl, source, None, b          # building until the remux is over, then finished
    done = cached_file(curl)
    if done:
        return curl, source, done, None
    _gate(curl, source, username)
    _ensure_dir()
    _evict()
    if _dir_total() > MAX_CACHE_BYTES:
        # What is left cannot be evicted (being built, being played, touched a moment ago).
        raise MixStreamError(503, "The mix cache is full — try again in a few minutes")
    b = Build(cache_base(curl), username)
    _builds[curl] = b
    _user_count[username] = _user_count.get(username, 0) + 1
    logger.info("mix stream started: user=%s source=%s %s", username, source, curl)
    b.task = asyncio.ensure_future(_run(curl, source, b))
    return curl, source, None, b


_dur_memo: dict[tuple, float] = {}


async def _finished_duration(path: str) -> float | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_size, st.st_mtime_ns)
    if key not in _dur_memo:
        d = await file_duration(path)
        if d:
            if len(_dur_memo) > 200:
                _dur_memo.clear()
            _dur_memo[key] = d
    return _dur_memo.get(key)


async def peek(url: str, username: str) -> dict:
    """What a stream request for `url` would meet, without starting anything: lets the
    client explain a refusal (the audio element only sees "error"), learn whether the
    finished file exists and how long it really is, and — by asking now and then — keeps
    what it is playing alive: a cached file is touched (eviction spares what was touched
    in the last minutes) and a running build is not cancelled for a minute."""
    parsed = await _canonical(url)
    if not parsed or parsed[0] not in ("mixcloud", "soundcloud", "hearthis", "youtube"):
        return {"ok": False, "status": 400, "message": mixes.NOT_A_MIX, "cached": False, "building": False}
    source, curl = parsed
    b = _builds.get(curl)
    if b is None:
        done = cached_file(curl)
        if done:
            player.touch_cache_file(done)
            return {"ok": True, "cached": True, "building": False, "duration": await _finished_duration(done)}
    else:
        b.keep(60)
        frac = None
        if b.expected > 60 and b.media_seconds > 0:
            frac = round(min(0.99, b.media_seconds / b.expected), 3)
        return {"ok": True, "cached": False, "building": True, "bytes": b.bytes, "progress": frac}
    try:
        _gate(curl, source, username)
    except MixStreamError as e:
        return {"ok": False, "status": e.status, "message": e.message, "cached": False, "building": False}
    return {"ok": True, "cached": False, "building": False}


def mime_of(path: str) -> str:
    return "audio/mp4" if path.endswith(".frag") else player.mime_for_path(path)
