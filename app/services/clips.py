"""Clips: cut a passage out of a downloaded DJ set and keep it as an ordinary
library track at <user>/<artist>/Clips/<title>.flac.

A clip is a normal track on purpose — it is NOT put in the mixes registry, so the
BPM analysis (which skips mixes) can still measure it, and the player finds it
through its usual local-file lookup. What marks it as a clip is its COMMENT tag,
`msclip|<source title>|<source artist>|<start>|<end>|<source quality>|<dj folder>|<file>`.
The last two say WHICH set it came from: two sets can share a title, and the title in
the tags is not the name on disk. Older clips end after the quality; they still parse.
"""

import asyncio
import base64
import hashlib
import json
import logging
import math
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import unquote

import numpy as np

from app.services import mixes, player

logger = logging.getLogger("musicseeker.clips")

CLIPS_ALBUM = "Clips"
MARKER = "msclip|"
SCRATCH_ROOT = ".clip-dl"
TRACK_DJ = "@track"        # the `dj` of a clip cut from an ordinary library track (it has no DJ folder)
SCAN_LIMIT = 2000          # files looked at when a tag scan has to find a track
MEMO_MAX = 500

MIN_LEN, MAX_LEN = 10.0, 1200.0
END_SLACK = 0.5            # tags round the duration; a client's "to the very end" may overshoot a hair
FADE = 0.005               # 5 ms: removes the click of cutting mid-waveform

PEAK_RATE = 10             # buckets per second
WAVE_SR = 8000
BUCKET_SAMPLES = WAVE_SR // PEAK_RATE
READ_CHUNK = 64 * 1024     # the decoded set is reduced piece by piece, never held whole
WAVE_TIMEOUT = 300
CUT_TIMEOUT = 120
BEATS_TIMEOUT = 60
BEATS_SR = 22050
BEATS_HALF_WINDOW = 15.0
COVER_MAX_BYTES = 4 * 1024 * 1024

# A 2.5 h set decodes for minutes and librosa holds a window in memory: a few users
# opening editors at once must queue instead of starving the box.
_BEATS_SEM = asyncio.Semaphore(2)
_WAVE_SEM = asyncio.Semaphore(1)

# ".flac" must still fit in a 255-byte file name; a cut-off name is one the
# player's lookup cannot find, so a too-long title is refused instead.
NAME_MAX_BYTES = 255 - len(".flac")


class ClipError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


# ── ffmpeg plumbing ──

async def _kill(proc) -> None:
    if proc.returncode is None:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        try:
            await proc.wait()
        except Exception:
            pass


def _read_meta(path: str) -> dict:
    """The one place that asks mixes for a file's tags (it is private there)."""
    return mixes._read_file_meta(path)


def _duration_of(path: str) -> float:
    """Exact length. _read_file_meta truncates to whole seconds, which would refuse
    a clip that ends at the true end of the set."""
    try:
        import mutagen
        f = mutagen.File(path)
        return float(f.info.length)
    except Exception:
        return float(_read_meta(path)["duration"])


# ── Waveform ──

class PeakReducer:
    """Max absolute amplitude per 1/10 s bucket from s16le PCM that arrives in
    pieces of any size (a piece may end in the middle of a sample or of a bucket)."""

    def __init__(self):
        self._odd = b""
        self._done: list[np.ndarray] = []
        self._cur_max = 0
        self._cur_n = 0
        self.samples = 0

    def feed(self, data: bytes) -> None:
        data = self._odd + data
        keep = len(data) % 2
        self._odd = data[len(data) - keep:] if keep else b""
        if keep:
            data = data[:-1]
        if not data:
            return
        a = np.abs(np.frombuffer(data, dtype="<i2").astype(np.int32))
        self.samples += len(a)
        if self._cur_n:
            need = BUCKET_SAMPLES - self._cur_n
            head = a[:need]
            self._cur_max = max(self._cur_max, int(head.max()))
            self._cur_n += len(head)
            a = a[need:]
            if self._cur_n == BUCKET_SAMPLES:
                self._done.append(np.array([self._cur_max], dtype=np.int32))
                self._cur_max, self._cur_n = 0, 0
        full = len(a) // BUCKET_SAMPLES
        if full:
            self._done.append(a[:full * BUCKET_SAMPLES].reshape(full, BUCKET_SAMPLES).max(axis=1))
        tail = a[full * BUCKET_SAMPLES:]
        if len(tail):
            self._cur_max, self._cur_n = int(tail.max()), len(tail)

    def result(self) -> tuple[float, bytes]:
        parts = list(self._done)
        if self._cur_n:
            parts.append(np.array([self._cur_max], dtype=np.int32))
        peaks = np.concatenate(parts) if parts else np.zeros(0, dtype=np.int32)
        top = int(peaks.max()) if len(peaks) else 0
        # The loudest bucket of the file is 255; the rest keep their ratio to it.
        scaled = np.rint(peaks * (255.0 / top)).astype(np.uint8) if top else np.zeros(len(peaks), dtype=np.uint8)
        return self.samples / WAVE_SR, scaled.tobytes()


async def _decode_peaks(path: str) -> dict:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-nostdin", "-v", "error", "-i", path, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", str(WAVE_SR),
        "-f", "s16le", "pipe:1",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    reducer = PeakReducer()

    async def pump():
        while True:
            chunk = await proc.stdout.read(READ_CHUNK)
            if not chunk:
                break
            reducer.feed(chunk)
        await proc.wait()

    try:
        await asyncio.wait_for(pump(), WAVE_TIMEOUT)
    except asyncio.TimeoutError:
        raise ClipError(502, "Decoding the mix took too long")
    finally:
        await _kill(proc)
    if proc.returncode != 0 or reducer.samples == 0:
        raise ClipError(502, "Could not decode the mix")
    duration, peaks = reducer.result()
    return {"duration": round(duration, 3), "rate": PEAK_RATE, "peaks": base64.b64encode(peaks).decode("ascii")}


# cache path -> the build running for it. A build is its OWN task, not the request's:
# nginx drops a request after 60 s, a long set takes longer, and a build tied to the
# request was killed with it — so every reopen started from zero, forever.
_wave_tasks: dict[str, asyncio.Task] = {}


def _waveform_cache_path(path: str) -> str:
    st = os.stat(path)
    key = hashlib.sha1(f"{os.path.realpath(path)}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()
    return os.path.join(str(mixes.DATA_DIR), "waveforms", key + ".json")


def _cache_read(cache: str) -> dict | None:
    try:
        with open(cache) as f:
            d = json.load(f)
        return d if isinstance(d, dict) and "peaks" in d else None
    except (OSError, ValueError):
        return None


def _wave_done(cache: str, task: asyncio.Task) -> None:
    if _wave_tasks.get(cache) is task:
        del _wave_tasks[cache]
    if not task.cancelled():
        task.exception()   # retrieved: a build nobody awaits any more must not log "never retrieved"


async def _build_waveform(path: str, cache: str) -> dict:
    async with _WAVE_SEM:
        hit = _cache_read(cache)
        if hit:
            return hit
        wave = await _decode_peaks(path)
    try:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        tmp = f"{cache}.{secrets.token_hex(4)}.tmp"
        with open(tmp, "w") as f:
            json.dump(wave, f)
        os.replace(tmp, cache)
    except OSError as e:
        logger.warning("Could not cache waveform: %s", e)
    return wave


async def get_waveform(path: str) -> dict:
    cache = _waveform_cache_path(path)
    hit = _cache_read(cache)
    if hit:
        return hit
    # One build per file; a request arriving meanwhile joins it. shield: a dropped
    # request cancels only its own wait, never the build.
    task = _wave_tasks.get(cache)
    if task is None:
        task = asyncio.create_task(_build_waveform(path, cache))
        _wave_tasks[cache] = task
        task.add_done_callback(lambda t, c=cache: _wave_done(c, t))
    return await asyncio.shield(task)


# ── Beats ──

def _track_beats(raw: bytes, offset: float) -> dict:
    import librosa
    y = np.frombuffer(raw[:len(raw) - len(raw) % 4], dtype="<f4")
    if len(y) < BEATS_SR:
        return {"bpm": None, "beats": []}
    env = librosa.onset.onset_strength(y=y, sr=BEATS_SR)
    tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=BEATS_SR)
    times = librosa.frames_to_time(frames, sr=BEATS_SR) + offset
    bpm = float(np.atleast_1d(tempo)[0])
    strengths = [float(env[f]) if 0 <= f < len(env) else 0.0 for f in frames]
    bpm, beats = fold_beats(bpm, [float(t) for t in times], strengths)
    return {"bpm": round(bpm, 2) if bpm > 0 else None, "beats": [round(t, 3) for t in beats]}


def fold_beats(bpm: float, times: list[float], strengths: list[float]) -> tuple[float, list[float]]:
    """Bring a double-time answer back to the tempo the rest of the app works in.

    The tracker locks onto eighth notes as readily as onto beats: on a zouk set whose
    track analysis says 84.5 BPM it reported 161–172 (measured 2026-11-17). Snapping a
    cut to THAT grid lands on the off-beat half the time, and a clip that starts half a
    beat late cannot be beat-matched. The analysis folds tempo into 58–116
    (bpm.py); above that range every second tick is dropped here, keeping the half that
    carries more onset energy — the beats, not the "and"s between them."""
    while bpm > 116 and len(times) >= 4:
        even, odd = times[0::2], times[1::2]
        se = sum(strengths[0::2]) / max(1, len(even))
        so = sum(strengths[1::2]) / max(1, len(odd))
        if so > se:
            times, strengths = odd, strengths[1::2]
        else:
            times, strengths = even, strengths[0::2]
        bpm /= 2
    return bpm, times


async def get_beats(path: str, t: float) -> dict:
    empty = {"bpm": None, "beats": []}
    proc = None
    try:
        if not math.isfinite(t):
            return empty
        a = max(0.0, t - BEATS_HALF_WINDOW)
        async with _BEATS_SEM:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-nostdin", "-v", "error", "-ss", f"{a:.3f}", "-t", f"{2 * BEATS_HALF_WINDOW:.3f}",
                "-i", path, "-vn", "-ac", "1", "-ar", str(BEATS_SR), "-f", "f32le", "pipe:1",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            raw, _ = await asyncio.wait_for(proc.communicate(), BEATS_TIMEOUT)
            if proc.returncode != 0 or not raw:
                return empty
            return await asyncio.to_thread(_track_beats, raw, a)
    except Exception as e:
        logger.info("Beat tracking failed: %s", e)
        return empty
    finally:
        if proc is not None:
            await _kill(proc)


# ── Source: a downloaded set, or any track in the user's own library ──

@dataclass(frozen=True)
class SourceRef:
    path: str   # absolute, proven inside the caller's own folder
    dj: str     # with `file`: the stable key clips are matched to their source by
    file: str


# (user, folded name, folded artist) -> path relative to the user's root. A long set is
# asked for by waveform, beats (many windows) and audio; each must not rescan a NAS.
_track_memo: dict[tuple, str] = {}
# The same key -> (expiry, message) for a lookup that found nothing. A miss is as
# expensive as a hit is cheap (it walks the whole folder), and the editor, the menu's
# pre-check and a retry all ask again within seconds.
_miss_memo: dict[tuple, tuple[float, str]] = {}
MISS_TTL = 60.0
# One lock for every read-modify-write of both memos (resolution runs in worker threads),
# and one lock per key so concurrent identical resolves share a single scan.
_memo_lock = threading.Lock()
_flights: dict[tuple, threading.Lock] = {}
_now = time.monotonic       # a name, so tests can move the clock
NOT_OWNED = "Only a track stored in your own library can be cut"
IS_CLIP = "A clip cannot be cut again"
_TITLE_SEPARATORS = re.compile(r'[/\\:*?"<>|]')


def _fold(s: str) -> str:
    return " ".join(player.nfc(s or "").casefold().split())


def _is_clip(path: str) -> bool:
    """A clip of ours: cutting one would make a clip of a clip."""
    return (os.path.basename(os.path.dirname(path)) == CLIPS_ALBUM and path.lower().endswith(".flac")
            and _clip_meta(path) is not None)


def _accept_track(root: str, path: str, clips_seen: list | None = None) -> str | None:
    """`path` relative to `root` (POSIX) if it is an audio file really inside the user's
    own folder, not hidden and not one of our clips; else None. `root` is a realpath.
    A refused clip is noted in `clips_seen`, so the caller can say WHY nothing was found."""
    try:
        real = os.path.realpath(path)
        if os.path.commonpath([root, real]) != root or real == root:
            return None
    except ValueError:
        return None
    parts = os.path.relpath(real, root).split(os.sep)
    if any(p.startswith(".") or not p for p in parts):
        return None
    if parts[-1].rsplit(".", 1)[-1].lower() not in mixes.AUDIO_EXTS or "." not in parts[-1]:
        return None
    if not os.path.isfile(real):
        return None
    if _is_clip(real):
        if clips_seen is not None:
            clips_seen.append(real)
        return None
    return "/".join(parts)


def _walk_files(top: str):
    """Visible files under `top`, sorted so the answer does not depend on the disk's
    order, stopping after SCAN_LIMIT of them: a NAS walk must have an end."""
    seen = 0
    for dirpath, dirnames, filenames in os.walk(top):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for fn in sorted(filenames):
            if fn.startswith("."):
                continue
            seen += 1
            if seen > SCAN_LIMIT:
                return
            yield os.path.join(dirpath, fn), fn


def _file_names(name: str) -> set[str]:
    """The file names the player's lookup would try for this title: the sanitised one
    and the older spaces-instead-of-underscores one, in every audio extension."""
    safe = player._sanitize(name)
    alt = re.sub(r"\s+", " ", _TITLE_SEPARATORS.sub(" ", name).strip().rstrip("."))
    return {f"{t}.{ext}" for t in (safe, alt) if t for ext in mixes.AUDIO_EXTS}


def _tag_artists(path: str) -> list[str]:
    """ARTIST and ALBUMARTIST of a file (a compilation's tracks carry the former)."""
    try:
        import mutagen
        f = mutagen.File(path, easy=True)
        tags = (f.tags if f is not None else None) or {}
        return [_fold(str(v)) for k in ("artist", "albumartist") for v in (tags.get(k) or [])]
    except Exception:
        return []


def _scan_artist_folder(root: str, artist_dir: str, want_name: str, want_artist: str,
                        clips_seen: list | None = None) -> str | None:
    """The file under the user's own artist folder whose TITLE and ARTIST tags are the
    wanted ones — a set's file name is often not its title. Bounded: a NAS walk."""
    for path, _ in _walk_files(artist_dir):
        rel = _accept_track(root, path, clips_seen)
        if not rel:
            continue
        meta = _read_meta(path)
        if _fold(meta["title"]) == want_name and _fold(meta["artist"]) == want_artist:
            return rel
    return None


def _by_file_name(root: str, top: str, name: str, want_artist: str, clips_seen: list) -> str | None:
    """A file under `top` named like the title. Inside the artist's folder the folder is
    the artist; anywhere else the tags must agree (`want_artist` set), or a same-titled
    track of someone else would be cut."""
    names = _file_names(name)
    for path, fn in _walk_files(top):
        if fn not in names:
            continue
        rel = _accept_track(root, path, clips_seen)
        if rel and (not want_artist or want_artist in _tag_artists(path)):
            return rel
    return None


def _locate(root: str, name: str, artist: str, want_name: str, want_artist: str) -> str | None:
    """Find the caller's own copy. Only inside `root`: the player's lookup walks every
    user's folders and returns the FIRST hit, which may be someone else's copy while the
    caller's own sits under another artist folder. Raises ClipError when the only
    candidates were our own clips."""
    clips_seen: list = []
    rel = None
    folder = player._sanitize(artist) if artist.strip() else ""
    if folder:
        try:
            mixes._one_component(folder)
        except mixes.MixPathError:
            folder = ""
    artist_dir = os.path.join(root, folder) if folder else ""
    has_artist_dir = bool(artist_dir) and os.path.isdir(artist_dir)
    if has_artist_dir:
        rel = _by_file_name(root, artist_dir, name, "", clips_seen)
    if not rel:
        rel = _by_file_name(root, root, name, want_artist, clips_seen)
    if not rel and has_artist_dir:
        # A missing folder means a missing track: walking the whole library for a tag
        # would cost minutes on a NAS.
        rel = _scan_artist_folder(root, artist_dir, want_name, want_artist, clips_seen)
    if not rel and clips_seen:
        raise ClipError(404, IS_CLIP)
    return rel


def _recall(root: str, key: tuple) -> tuple[str | None, str | None]:
    """(path, None) for a hit that still holds, (None, message) for a live miss, else
    (None, None). A hit is re-proved every time: the file may have vanished or been
    swapped for a link leading out of the folder since."""
    with _memo_lock:
        rel = _track_memo.get(key)
        miss = _miss_memo.get(key)
        if miss and miss[0] <= _now():
            _miss_memo.pop(key, None)
            miss = None
    if rel:
        path = os.path.join(root, *rel.split("/"))
        if os.path.exists(path) and _accept_track(root, path):
            return rel, None
        with _memo_lock:
            _track_memo.pop(key, None)
    return None, (miss[1] if miss else None)


def _remember(key: tuple, rel: str | None, message: str = NOT_OWNED) -> None:
    with _memo_lock:
        if rel:
            memo, value = _track_memo, rel
        else:
            memo, value = _miss_memo, (_now() + MISS_TTL, message)
            for k in [k for k, v in _miss_memo.items() if v[0] <= _now()]:
                del _miss_memo[k]
        if len(memo) >= MEMO_MAX:
            memo.pop(next(iter(memo)))
        memo[key] = value


def _find_track(root: str, username: str, name: str, artist: str) -> str:
    """The track's path relative to `root`, or raises ClipError(404)."""
    key = (username, _fold(name), _fold(artist))
    rel, miss = _recall(root, key)
    if not rel and not miss:
        with _memo_lock:
            gate = _flights.setdefault(key, threading.Lock())
        # The first /audio and /waveform arrive together: the second waits here and then
        # finds the first one's answer in the memo instead of walking the same folders.
        with gate:
            rel, miss = _recall(root, key)
            if not rel and not miss:
                try:
                    rel = _locate(root, player.nfc(name), player.nfc(artist), key[1], key[2])
                    miss = None if rel else NOT_OWNED
                except ClipError as e:
                    miss = e.message
                except OSError:
                    miss = NOT_OWNED      # e.g. a name too long for the file system: not found
                _remember(key, rel, miss or NOT_OWNED)
        with _memo_lock:
            if _flights.get(key) is gate:
                del _flights[key]
    if not rel:
        raise ClipError(404, miss or NOT_OWNED)
    return rel


def resolve_source(music_dir: str, username: str, *, dj: str | None = None, file: str | None = None,
                   name: str | None = None, artist: str | None = None) -> SourceRef:
    """The one place that turns a request into a file. Either a downloaded set (`dj` +
    `file`) or a track of the caller's own library (`name` + `artist`); blocking (it
    touches a NAS), so callers run it in a thread. Raises ClipError."""
    dj, file, name, artist = dj or "", file or "", name or "", artist or ""
    has_mix, has_track = bool(dj or file), bool(name or artist)
    if has_mix == has_track:
        raise ClipError(400, "Give either dj and file, or name and artist")
    # A real folder called "@track" must never be mistaken for the key of a track source.
    if dj == TRACK_DJ:
        raise ClipError(400, "Invalid dj")
    if len(name.encode("utf-8")) > 255 or len(artist.encode("utf-8")) > 255:
        raise ClipError(400, "The name or artist is too long")
    try:
        root = os.path.realpath(mixes.user_root(music_dir, username))
        if has_mix:
            path = mixes.resolve_library_file(music_dir, username, dj, file)
    except mixes.MixPathError as e:
        raise ClipError(400, str(e))
    if has_mix:
        if not os.path.isfile(path):
            raise ClipError(404, "Mix not found")
        return SourceRef(path, dj, file)
    if not name.strip():
        raise ClipError(400, "Give the track's name")
    rel = _find_track(root, username, name, artist)
    return SourceRef(os.path.join(root, *rel.split("/")), TRACK_DJ, rel)


def source_info(ref: SourceRef, name: str = "", artist: str = "") -> dict:
    """What the editor needs to match clips to this source without knowing the relpath."""
    meta = _read_meta(ref.path)
    stem = os.path.splitext(os.path.basename(ref.file))[0]
    return {"dj": ref.dj, "file": ref.file, "title": meta["title"] or name or stem,
            "artist": meta["artist"] or artist or (ref.dj if ref.dj != TRACK_DJ else "")}


# ── Paths ──

def _clip_path(root: str, artist_dir: str, file: str) -> str:
    """<root>/<artist>/Clips/<file>, proven (symlinks resolved) to sit exactly there
    inside the user's own folder. Raises MixPathError otherwise."""
    artist_dir, file = mixes._one_component(artist_dir), mixes._one_component(file)
    root = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root, artist_dir, CLIPS_ALBUM, file))
    album = os.path.dirname(path)
    if (os.path.basename(album) != CLIPS_ALBUM or os.path.dirname(os.path.dirname(album)) != root
            or os.path.basename(os.path.dirname(album)).startswith(".")):
        raise mixes.MixPathError("Invalid path")
    return path


def _prune(path: str) -> None:
    """Remove the Clips folder, then the artist folder, when EMPTY — rmdir refuses
    anything that still holds a file, which is the whole point."""
    album = os.path.dirname(path)
    for d in (album, os.path.dirname(album)):
        try:
            os.rmdir(d)
        except OSError:
            break


# ── Tags ──

def _source_cover(path: str) -> tuple[bytes, str] | None:
    try:
        import mutagen
        f = mutagen.File(path)
        if f is None:
            return None
        pic = None
        if hasattr(f, "pictures") and f.pictures:
            pic = (f.pictures[0].data, f.pictures[0].mime)
        elif f.tags is not None:
            tags = f.tags
            if "covr" in tags and tags["covr"]:
                c = tags["covr"][0]
                pic = (bytes(c), "image/png" if getattr(c, "imageformat", 0) == 14 else "image/jpeg")
            else:
                apic = [tags[k] for k in tags.keys() if str(k).startswith("APIC")]
                if apic:
                    pic = (apic[0].data, apic[0].mime)
        if pic and 0 < len(pic[0]) <= COVER_MAX_BYTES:
            return pic
    except Exception:
        pass
    return None


def _tag_clip(path: str, title: str, artist: str, comment: str, cover: tuple[bytes, str] | None) -> float:
    from mutagen.flac import FLAC, Picture
    f = FLAC(path)
    if f.tags is None:
        f.add_tags()
    f["title"] = [title]
    f["artist"] = [artist]
    f["albumartist"] = [artist]
    f["album"] = [CLIPS_ALBUM]
    f["date"] = [str(datetime.now().year)]
    f["comment"] = [comment]
    if cover:
        pic = Picture()
        pic.type = 3
        pic.mime = cover[1]
        pic.data = cover[0]
        f.clear_pictures()
        f.add_picture(pic)
    f.save()
    return float(f.info.length)


def _clip_meta(path: str) -> dict | None:
    """Tags of one file if it is a clip of ours, else None."""
    from mutagen.flac import FLAC
    try:
        f = FLAC(path)
    except Exception:
        return None
    tags = f.tags or {}

    def first(k):
        v = tags.get(k)
        return str(v[0]) if v else ""
    comment = first("comment")
    if not comment.startswith(MARKER):
        return None
    parts = comment.split("|")

    def text(i):
        return parts[i] if len(parts) > i else ""

    def num(i):
        try:
            return float(parts[i])
        except (IndexError, ValueError):
            return 0.0
    return {"title": first("title"), "artist": first("artist"), "duration": float(f.info.length),
            "source_title": text(1), "source_artist": text(2), "start": num(3), "end": num(4),
            "source_dj": text(6), "source_file": text(7)}


# ── Create / list / delete ──

def _field(s: str) -> str:
    """A text field of the marker: '|' is its separator, so it cannot appear inside. Only
    '%', '|' and '¦' are percent-encoded — ordinary names stay readable in the tag, and a
    name that really contains '¦' or '|' comes back as it was."""
    return s.replace("%", "%25").replace("|", "%7C").replace("¦", "%C2%A6")


def _unfield(s: str) -> str:
    # A marker written before the encoding has no '%' escapes: taken as it is.
    return unquote(s) if "%" in s else s


def _check_range(start: float, end: float, duration: float) -> None:
    if not (math.isfinite(start) and math.isfinite(end)):
        raise ClipError(400, "Start and end must be numbers")
    # duration 0 = the tags could not tell; refusing every clip for that would be worse
    # than trusting ffmpeg to stop at the real end.
    if start < 0 or start >= end or (duration > 0 and end > duration + END_SLACK):
        raise ClipError(400, "The clip must lie inside the mix, start before end")
    if end - start < MIN_LEN:
        raise ClipError(400, f"A clip must be at least {int(MIN_LEN)} seconds long")
    if end - start > MAX_LEN:
        raise ClipError(400, f"A clip can be at most {int(MAX_LEN // 60)} minutes long")


async def create_clip(music_dir: str, username: str, dj: str, file: str,
                      start: float, end: float, title: str, artist: str,
                      src_name: str = "", src_artist: str = "") -> dict:
    title = player.nfc((title or "").strip())
    if not title:
        raise ClipError(400, "Give the clip a title")
    ref = await asyncio.to_thread(resolve_source, music_dir, username, dj=dj, file=file,
                                  name=src_name, artist=src_artist)
    src, dj, file = ref.path, ref.dj, ref.file
    meta = await asyncio.to_thread(_read_meta, src)
    duration = await asyncio.to_thread(_duration_of, src)
    _check_range(start, end, duration)
    artist = player.nfc((artist or "").strip()) or player.nfc(meta["artist"]) or player.nfc(src_artist or (dj if dj != TRACK_DJ else ""))

    # The file name must be exactly what player._resolve_local_file looks for.
    base = player._sanitize(title)
    folder = player._sanitize(artist)
    try:
        mixes._one_component(base)
        mixes._one_component(folder)
    except mixes.MixPathError:
        raise ClipError(400, "That title or artist cannot be used as a file name")
    if len(base.encode("utf-8")) > NAME_MAX_BYTES or len(folder.encode("utf-8")) > 255:
        raise ClipError(400, "The title or artist is too long")
    # BPM analysis skips whatever mixes.is_mix(title, artist) says is a mix.
    if mixes.is_mix(title, artist):
        raise ClipError(400, "A clip cannot have the same title as a downloaded set")

    root = os.path.realpath(mixes.user_root(music_dir, username))
    fname = base + ".flac"
    final = _clip_path(root, folder, fname)
    if await asyncio.to_thread(os.path.exists, final):
        raise ClipError(409, "A clip with this title already exists")
    # A clip is found by title + artist like any track; one that shadows a real track
    # would play (or be deleted) in its place. Globs a NAS: off the loop.
    if await asyncio.to_thread(player._resolve_local_file, title, artist):
        raise ClipError(409, "A track with this title already exists in the library")

    length = end - start
    scratch_root = os.path.join(music_dir, SCRATCH_ROOT)
    # One private dir per cut, so cleaning up never touches another cut's file and the
    # shared root is never removed under a cut that is about to use it.
    def _workdir() -> str:
        os.makedirs(scratch_root, exist_ok=True)
        return tempfile.mkdtemp(dir=scratch_root)
    workdir = await asyncio.to_thread(_workdir)
    scratch = os.path.join(workdir, "cut.flac")
    quality = meta["codec"] + (f" {meta['kbps']} kbps" if meta["kbps"] else "")
    comment = MARKER + "|".join(_field(x) for x in (
        meta["title"] or src_name or os.path.splitext(os.path.basename(file))[0],
        meta["artist"] or src_artist or (dj if dj != TRACK_DJ else ""))
    ) + f"|{start:.3f}|{end:.3f}|{quality}|{_field(dj)}|{_field(file)}"
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", src,
            "-vn", "-map", "0:a:0", "-map_metadata", "-1",
            "-af", f"afade=t=in:st=0:d={FADE},afade=t=out:st={length - FADE:.3f}:d={FADE}",
            "-c:a", "flac", "-sample_fmt", "s16", "-y", scratch,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            _, err = await asyncio.wait_for(proc.communicate(), CUT_TIMEOUT)
        except asyncio.TimeoutError:
            raise ClipError(502, "Cutting the clip took too long")
        if proc.returncode != 0 or not os.path.isfile(scratch) or os.path.getsize(scratch) == 0:
            logger.warning("ffmpeg cut failed: %s", (err or b"").decode("utf-8", "replace")[-300:])
            raise ClipError(502, "Could not cut the clip")
        cover = await asyncio.to_thread(_source_cover, src)
        try:
            out_len = await asyncio.to_thread(_tag_clip, scratch, title, artist, comment, cover)
        except Exception as e:
            logger.warning("Could not tag clip: %s", e)
            raise ClipError(500, "Could not tag the clip")
        await asyncio.to_thread(_publish, scratch, final)
    finally:
        if proc is not None:
            await _kill(proc)
        shutil.rmtree(workdir, ignore_errors=True)
    return {"name": title, "artist": artist, "album": CLIPS_ALBUM, "duration": round(out_len, 3),
            "dir": os.path.basename(os.path.dirname(os.path.dirname(final))), "file": fname}


def _publish(scratch: str, final: str) -> None:
    """Put the finished file at `final` without ever replacing one that is there.
    A hard link fails atomically if the name exists (two cuts of one title race here);
    some NAS mounts refuse links, and then the exists-check + replace is what is left."""
    os.makedirs(os.path.dirname(final), exist_ok=True)
    try:
        os.link(scratch, final)
        return
    except FileExistsError:
        raise ClipError(409, "A clip with this title already exists")
    except OSError:
        pass
    if os.path.exists(final):
        raise ClipError(409, "A clip with this title already exists")
    try:
        os.replace(scratch, final)
    except OSError:
        _prune(final)
        raise ClipError(500, "Could not save the clip")


def list_clips(music_dir: str, username: str) -> dict:
    """Every clip of `username`: a .flac under <artist>/Clips/ whose COMMENT carries
    the marker — a real album called "Clips" is not ours. Reads tags: off the loop."""
    try:
        root = mixes.user_root(music_dir, username)
    except mixes.MixPathError:
        return {"clips": [], "count": 0}
    clips = []
    try:
        artists = os.listdir(root)
    except OSError:
        artists = []
    for a in artists:
        album = os.path.join(root, a, CLIPS_ALBUM)
        if a.startswith(".") or not os.path.isdir(album):
            continue
        for fname in os.listdir(album):
            fpath = os.path.join(album, fname)
            if fname.startswith(".") or not fname.lower().endswith(".flac") or not os.path.isfile(fpath):
                continue
            m = _clip_meta(fpath)
            if not m:
                continue
            st = os.stat(fpath)
            clips.append({"title": player.nfc(m["title"]) or player.nfc(fname[:-5]),
                          "artist": player.nfc(m["artist"]) or player.nfc(a), "dir": a, "file": fname,
                          "duration": round(m["duration"], 3), "size": st.st_size,
                          "modified": int(st.st_mtime), "source_title": player.nfc(_unfield(m["source_title"])),
                          "source_artist": player.nfc(_unfield(m["source_artist"])),
                          # dj/file are matched against names on disk: no NFC, only the separator undone
                          "source_dj": _unfield(m["source_dj"]), "source_file": _unfield(m["source_file"]),
                          "start": m["start"], "end": m["end"]})
    clips.sort(key=lambda c: c["modified"], reverse=True)
    return {"clips": clips, "count": len(clips)}


def delete_clip(music_dir: str, username: str, dir_: str, file: str) -> dict | None:
    """Delete one clip; the {title, artist} the player keyed it on, None if absent."""
    path = _clip_path(mixes.user_root(music_dir, username), dir_, file)
    if not file.lower().endswith(".flac"):
        raise mixes.MixPathError("Not a clip")
    if not os.path.isfile(path):
        return None
    m = _clip_meta(path)
    if not m:
        raise mixes.MixPathError("Not a clip")
    gone = {"title": player.nfc(m["title"]) or player.nfc(file[:-5]),
            "artist": player.nfc(m["artist"]) or player.nfc(dir_)}
    os.remove(path)
    _prune(path)
    return gone
