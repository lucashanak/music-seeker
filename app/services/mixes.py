"""DJ mixes from Mixcloud and SoundCloud: download exactly the linked file.

Everything else in the downloader searches YouTube for a song by name. A mix is
the opposite case — the user hands us the one recording they want — so this path
never searches, it downloads the URL it was given.

Quality is decided by the source, not by us (measured 2026-11-17 with yt-dlp
2026.11.x on the production container):

- Mixcloud serves standard uploads as AAC-LC 64 kbps. Every format yt-dlp lists for
  such a mix (`http`, `dash-*`, `hls-64`) is the same 64 kbps stream. "HQ" (Opus
  160) exists only for mixes whose AUTHOR has a paid Pro account; a listener
  cannot buy it.
- SoundCloud offers `hls_aac_96k` and `hls_aac_160k`.

So the file is stored in the codec it arrives in. Converting AAC 64 to FLAC or to
MP3 320 adds no sound, only bytes, and a "lossless" extension on lossy audio is a
lie the library would carry forever. `DownloadRequest.format` is ignored here.
"""

import asyncio
import base64
import json
import logging
import os
import re
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, quote, unquote

import httpx

from app.services.player import nfc

logger = logging.getLogger(__name__)

SOURCE_LABEL = {"mixcloud": "Mixcloud", "soundcloud": "SoundCloud"}

# One album per DJ, whichever site the mix came from. Navidrome keys albums on
# album + album artist, so "DJ Sets" by Martin Šmoldas is one album holding all
# of his mixes — Mixcloud and SoundCloud alike — instead of one single-track album
# per mix flooding the album view, and instead of the site name splitting one DJ's
# work in two. Where a mix came from is kept in the COMMENT tag (its URL).
MIX_ALBUM = "DJ Sets"

# The directory under a user's music folder. Mixes stay out of Artist/Album so
# they never mix with album tracks of the same name.
MIX_DIR = "Mixes"

INFO_TIMEOUT = 60          # yt-dlp -J for one mix
PROBE_TIMEOUT = 30         # ffprobe of the finished file
COVER_TIMEOUT = 20
COVER_MAX_BYTES = 15 * 1024 * 1024   # an "original" artwork PNG can be several MB

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
REGISTRY_FILE = DATA_DIR / "mixes.json"

# Audio extensions yt-dlp's `-x` (codec "best", i.e. no re-encode) can leave behind.
AUDIO_EXTS = ("m4a", "opus", "ogg", "mp3", "aac", "flac", "webm", "mka")


# ── Recognising a link ──

# First path segments that are site sections, not user names.
_MIXCLOUD_RESERVED = {
    "discover", "live", "upload", "uploads", "dashboard", "settings", "select", "pro",
    "categories", "tag", "tags", "search", "player", "widget", "about", "jobs", "help",
    "notifications", "messages", "favorites", "listens", "playlists", "for-you",
    "creator-hub", "developers", "terms", "privacy", "artists", "radio",
}
# Second path segments that make it a user's sub-page, not a mix.
_MIXCLOUD_USER_PAGES = {
    "uploads", "favorites", "listens", "playlists", "stream", "followers", "following",
    "posts", "reposts", "shows", "hosts", "live", "select", "history",
}
_SOUNDCLOUD_RESERVED = {
    "discover", "search", "you", "stream", "charts", "upload", "pages", "settings",
    "messages", "notifications", "feed", "people", "terms-of-use", "jobs", "pro",
    "mobile", "imprint", "creators", "artists", "connect", "signin", "logout",
}
_SOUNDCLOUD_USER_PAGES = {
    "sets", "tracks", "albums", "likes", "reposts", "followers", "following",
    "popular-tracks", "comments", "spotlight", "toptracks", "playlists",
}

_SLUG_RE = re.compile(r"^[^\s/?#]+$")


def parse_mix_url(text: str) -> tuple[str, str] | None:
    """Return (source, canonical_url) for a single Mixcloud or SoundCloud mix link
    found in `text`, else None.

    The canonical URL is REBUILT from the parsed parts — host fixed, tracking query
    dropped — so whatever reaches yt-dlp is a plain https URL on one of the two
    sites and can never be an option or another host. A user page, a playlist/set
    or a site section is not a mix and is refused here.

    `on.soundcloud.com/<code>` share links are recognised as ("soundcloud-short", url);
    `resolve_short_link` turns them into a real track URL (yt-dlp has no extractor
    for them).
    """
    m = re.search(r"https?://\S+", str(text or ""))
    raw = m.group(0) if m else str(text or "").strip()
    raw = raw.rstrip(").,]}>\"'")
    if not raw:
        return None
    if "://" not in raw:
        raw = "https://" + raw
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    segs = [s for s in parts.path.split("/") if s]

    if host in ("mixcloud.com", "www.mixcloud.com", "m.mixcloud.com"):
        if len(segs) != 2:
            return None
        user, slug = unquote(segs[0]), unquote(segs[1])
        if user.lower() in _MIXCLOUD_RESERVED or slug.lower() in _MIXCLOUD_USER_PAGES:
            return None
        if not (_SLUG_RE.match(user) and _SLUG_RE.match(slug)):
            return None
        return "mixcloud", f"https://www.mixcloud.com/{quote(user, safe='')}/{quote(slug, safe='')}/"

    if host in ("soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"):
        # /<user>/<track> or a private link /<user>/<track>/s-<secret>
        if len(segs) not in (2, 3):
            return None
        user, track = unquote(segs[0]), unquote(segs[1])
        if user.lower() in _SOUNDCLOUD_RESERVED or track.lower() in _SOUNDCLOUD_USER_PAGES:
            return None
        if not (_SLUG_RE.match(user) and _SLUG_RE.match(track)):
            return None
        tail = ""
        if len(segs) == 3:
            secret = unquote(segs[2])
            if not re.fullmatch(r"s-[A-Za-z0-9]+", secret):
                return None
            tail = f"/{secret}"
        return "soundcloud", f"https://soundcloud.com/{quote(user, safe='')}/{quote(track, safe='')}{tail}"

    if host == "on.soundcloud.com":
        if len(segs) != 1 or not re.fullmatch(r"[A-Za-z0-9]+", segs[0]):
            return None
        return "soundcloud-short", f"https://on.soundcloud.com/{segs[0]}"

    return None


async def resolve_short_link(url: str) -> tuple[str, str] | None:
    """Follow ONE redirect of an on.soundcloud.com share link and parse where it
    points. Only a redirect to a SoundCloud track counts; anything else is None."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            resp = await client.get(url)
        loc = resp.headers.get("location", "")
    except Exception:
        return None
    parsed = parse_mix_url(loc)
    if parsed and parsed[0] == "soundcloud":
        return parsed
    return None


async def canonical(url: str) -> tuple[str, str] | None:
    """parse_mix_url, with short links resolved. None = not a mix link."""
    parsed = parse_mix_url(url)
    if parsed and parsed[0] == "soundcloud-short":
        return await resolve_short_link(parsed[1])
    return parsed


# ── Metadata ──

async def _run_capture(cmd: list[str], timeout: float) -> tuple[int | None, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except Exception as e:
        return None, "", str(e)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return None, "", "timed out"
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _last_error(stderr: str) -> str:
    lines = [ln.strip() for ln in (stderr or "").splitlines() if ln.strip()]
    errs = [ln for ln in lines if ln.startswith("ERROR")]
    msg = (errs or lines or ["unknown error"])[-1]
    return msg.replace("ERROR: ", "", 1)[:300]


def _pick_thumbnail(d: dict) -> str:
    """A cover of sensible size. SoundCloud's `thumbnail` is the ORIGINAL artwork
    (a multi-MB PNG measured); its 500x500 JPEG rendition is listed beside it."""
    thumbs = d.get("thumbnails") or []
    for t in thumbs:
        u = t.get("url") or ""
        if "t500x500" in u:
            return u
    return d.get("thumbnail") or (thumbs[-1].get("url", "") if thumbs else "")


def normalize_info(d: dict, source: str, url: str) -> dict:
    """The fields we use, from a yt-dlp info dict. Pure — no I/O."""
    title = nfc((d.get("title") or "").strip()) or "Untitled mix"
    uploader = nfc((d.get("uploader") or d.get("uploader_id") or "").strip()) or "Unknown DJ"
    ts = d.get("timestamp")
    date = ""
    if isinstance(ts, (int, float)) and ts > 0:
        date = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    elif re.fullmatch(r"\d{8}", str(d.get("upload_date") or "")):
        u = d["upload_date"]
        date = f"{u[:4]}-{u[4:6]}-{u[6:]}"
    return {
        "source": source,
        "source_label": SOURCE_LABEL.get(source, source),
        "url": url,
        "title": title,
        "uploader": uploader,
        "thumbnail": _pick_thumbnail(d),
        "date": date,
        "duration": int(d.get("duration") or 0),
    }


# A banner lookup is one yt-dlp process; a burst of pastes must not become a burst
# of processes (and of requests to the site).
_info_slots = asyncio.Semaphore(2)


async def fetch_info(url: str) -> dict:
    """Metadata of one mix. Raises ValueError with a user-facing reason."""
    parsed = await canonical(url)
    if not parsed:
        raise ValueError("Not a Mixcloud or SoundCloud mix link")
    source, curl = parsed
    async with _info_slots:
        rc, out, err = await _run_capture(
            ["yt-dlp", "-J", "--no-playlist", "--skip-download", "--", curl], INFO_TIMEOUT,
        )
    if rc != 0 or not out.strip():
        raise ValueError(f"{SOURCE_LABEL[source]}: {_last_error(err)}")
    try:
        d = json.loads(out)
    except ValueError:
        raise ValueError(f"{SOURCE_LABEL[source]}: unreadable answer")
    if d.get("_type") == "playlist":
        raise ValueError("That link is a playlist, not a single mix")
    return normalize_info(d, source, curl)


# ── Paths ──

def _sanitize(name: str) -> str:
    """Same rule as downloader._sanitize and player._sanitize (the file lookup
    must find what we write), applied after folding to NFC."""
    return re.sub(r'[/\\:*?"<>|]', '_', nfc(name)).strip().rstrip('.')


def mix_dir(music_dir: str, username: str, uploader: str) -> str:
    base = f"{music_dir}/{_sanitize(username)}" if username else music_dir
    # No leading dot: a hidden folder is skipped by Navidrome, and ".mix-dl-*" is
    # what the stale-scratch sweep deletes.
    return f"{base}/{MIX_DIR}/{_sanitize(uploader).lstrip('.').strip() or 'Unknown DJ'}"


def mix_basename(title: str) -> str:
    # Leave room for the extension and yt-dlp's scratch suffixes in a 255-byte name.
    # Must equal player._sanitize(title) whenever no cut is needed — that is how
    # the player's local-file lookup finds the mix.
    name = _sanitize(title) or "Untitled mix"
    if len(name.encode("utf-8")) > 200:
        while len(name.encode("utf-8")) > 200:
            name = name[:-1]
        name = name.strip().rstrip(".") or "Untitled mix"
    return name


def build_download_cmd(url: str, out_template: str, path_file: str) -> list[str]:
    """The yt-dlp command for one mix. No `--audio-format`: `-x` with the default
    codec "best" keeps the stream as it is and only moves it into an audio
    container (AAC → .m4a, Opus → .opus). Nothing is re-encoded.

    The best AAC stream wins, Opus only when there is no AAC. Measured 2026-11-17
    on Mixcloud HQ mixes (NTS, Worldwide FM): they offer AAC 192k (`hls-192`) and
    Opus ~195k (`dash-f2-*`) side by side. yt-dlp's own ranking puts the codec
    before the bit rate and would take the Opus — the same sound, but iOS Safari
    and DLNA renderers play AAC and not Opus. SQ mixes are AAC 64k only, and
    SoundCloud's best is `hls_aac_160k`."""
    return [
        "yt-dlp",
        "-f", "bestaudio[acodec^=mp4a]/bestaudio/best",
        "-x",
        "--no-playlist",
        "--no-embed-metadata",
        "--no-embed-thumbnail",
        "--concurrent-fragments", "4",
        "--newline",
        "--print-to-file", "after_move:filepath", path_file,
        "-o", out_template,
        "--", url,
    ]


def find_output(out_dir: str, base: str) -> str | None:
    """The finished audio file for `base` in `out_dir`, if there is one."""
    for ext in AUDIO_EXTS:
        p = os.path.join(out_dir, f"{base}.{ext}")
        if os.path.isfile(p) and os.path.getsize(p) > 0:
            return p
    return None


# ── Quality ──

_CODEC_LABEL = {"aac": "AAC", "opus": "Opus", "mp3": "MP3", "vorbis": "Vorbis", "flac": "FLAC"}


def parse_probe(probe: dict, size_bytes: int = 0) -> dict:
    """{codec, kbps} from ffprobe's JSON. The stream bit rate when the container
    states one (MP4 does); otherwise the file's average (Ogg Opus does not)."""
    streams = probe.get("streams") or []
    fmt = probe.get("format") or {}
    s = streams[0] if streams else {}
    codec = (s.get("codec_name") or "").lower()
    bps = 0
    for v in (s.get("bit_rate"), fmt.get("bit_rate")):
        try:
            bps = int(v)
        except (TypeError, ValueError):
            continue
        if bps > 0:
            break
    if not bps:
        try:
            dur = float(fmt.get("duration") or 0)
            if dur > 0 and size_bytes:
                bps = int(size_bytes * 8 / dur)
        except (TypeError, ValueError):
            pass
    return {"codec": _CODEC_LABEL.get(codec, codec.upper() or "?"),
            "kbps": int(round(bps / 1000)) if bps else 0}


def quality_label(source: str, q: dict) -> str:
    """'Mixcloud · AAC 64 kbps'."""
    label = SOURCE_LABEL.get(source, source)
    if q.get("kbps"):
        return f"{label} · {q['codec']} {q['kbps']} kbps"
    return f"{label} · {q.get('codec') or '?'}"


async def probe_quality(path: str) -> dict:
    rc, out, _ = await _run_capture([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,bit_rate:format=bit_rate,duration",
        "-of", "json", path,
    ], PROBE_TIMEOUT)
    try:
        probe = json.loads(out) if rc == 0 else {}
    except ValueError:
        probe = {}
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    return parse_probe(probe, size)


# ── Tags ──

async def fetch_cover(url: str) -> tuple[bytes, str] | None:
    """(bytes, mime) of a JPEG/PNG cover no bigger than ~1.5 MB, or None.
    Anything else (WebP, a huge PNG) is converted to an 800 px JPEG by ffmpeg."""
    if not url or not url.startswith("https://"):
        return None
    try:
        async with httpx.AsyncClient(timeout=COVER_TIMEOUT, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                buf = bytearray()
                async for chunk in resp.aiter_bytes(65536):
                    buf += chunk
                    if len(buf) > COVER_MAX_BYTES:
                        return None
                data = bytes(buf)
    except Exception:
        return None
    if data[:3] == b"\xff\xd8\xff" and len(data) <= 1_500_000:
        return data, "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) <= 1_500_000:
        return data, "image/png"
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in")
        dst = os.path.join(tmp, "out.jpg")
        with open(src, "wb") as f:
            f.write(data)
        rc, _, _ = await _run_capture([
            "ffmpeg", "-y", "-v", "error", "-i", src,
            "-vf", "scale='min(800,iw)':-2", "-frames:v", "1", dst,
        ], COVER_TIMEOUT)
        if rc == 0 and os.path.exists(dst) and os.path.getsize(dst) > 0:
            with open(dst, "rb") as f:
                return f.read(), "image/jpeg"
    return None


def write_tags(path: str, info: dict, cover: tuple[bytes, str] | None) -> bool:
    """Tag the mix with mutagen, in whatever container it came in.

    TITLE = the mix's name, ARTIST = ALBUMARTIST = its author, ALBUM = MIX_ALBUM,
    DATE = the upload day, COMMENT = the source URL, cover = the mix's artwork.
    Returns False for a container we cannot tag (the file is kept regardless)."""
    import mutagen
    title, artist = info["title"], info["uploader"]
    date, comment = info.get("date", ""), info.get("url", "")
    ext = path.rsplit(".", 1)[-1].lower()
    try:
        if ext == "m4a":
            from mutagen.mp4 import MP4, MP4Cover
            f = MP4(path)
            if f.tags is None:
                f.add_tags()
            t = f.tags
            t["\xa9nam"] = [title]
            t["\xa9ART"] = [artist]
            t["aART"] = [artist]
            t["\xa9alb"] = [MIX_ALBUM]
            if date:
                t["\xa9day"] = [date]
            t["\xa9cmt"] = [comment]
            if cover:
                fmt = MP4Cover.FORMAT_PNG if cover[1] == "image/png" else MP4Cover.FORMAT_JPEG
                t["covr"] = [MP4Cover(cover[0], imageformat=fmt)]
            f.save()
            return True
        if ext in ("opus", "ogg", "flac"):
            from mutagen.flac import Picture
            if ext == "flac":
                from mutagen.flac import FLAC as Kind
            else:
                f0 = mutagen.File(path)
                if f0 is None:
                    return False
                Kind = type(f0)
            f = Kind(path)
            if f.tags is None:
                f.add_tags()
            f["title"] = [title]
            f["artist"] = [artist]
            f["albumartist"] = [artist]
            f["album"] = [MIX_ALBUM]
            if date:
                f["date"] = [date]
            f["comment"] = [comment]
            if cover:
                pic = Picture()
                pic.type = 3  # front cover
                pic.mime = cover[1]
                pic.data = cover[0]
                if ext == "flac":
                    f.clear_pictures()
                    f.add_picture(pic)
                else:
                    # Vorbis comments carry the picture as a base64 FLAC block.
                    f["metadata_block_picture"] = [base64.b64encode(pic.write()).decode("ascii")]
            f.save()
            return True
        if ext == "mp3":
            from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TPE2, TALB, TDRC, COMM, APIC
            try:
                t = ID3(path)
            except ID3NoHeaderError:
                t = ID3()
            t.setall("TIT2", [TIT2(encoding=3, text=title)])
            t.setall("TPE1", [TPE1(encoding=3, text=artist)])
            t.setall("TPE2", [TPE2(encoding=3, text=artist)])
            t.setall("TALB", [TALB(encoding=3, text=MIX_ALBUM)])
            if date:
                t.setall("TDRC", [TDRC(encoding=3, text=date)])
            t.setall("COMM", [COMM(encoding=3, lang="eng", desc="", text=comment)])
            if cover:
                t.setall("APIC", [APIC(encoding=3, mime=cover[1], type=3, desc="Cover", data=cover[0])])
            t.save(path)
            return True
    except Exception as e:
        logger.warning("Could not tag mix %s: %s", path, e)
    return False


# ── Registry: which library tracks are mixes ──
# BPM analysis must leave mixes alone (an hour of audio, a tempo that wanders,
# and libsndfile cannot open AAC at all). A Navidrome song id does not say a
# track is a mix and walking the music dir on every BPM request is what the BPM
# router already works hard to avoid, so the downloader records each mix here.

_registry: dict[str, dict] | None = None


def _key(name: str, artist: str) -> str:
    return f"{nfc(artist).lower().strip()}:{nfc(name).lower().strip()}"


def _load_registry() -> dict:
    global _registry
    if _registry is None:
        try:
            _registry = json.loads(REGISTRY_FILE.read_text())
            if not isinstance(_registry, dict):
                _registry = {}
        except Exception:
            _registry = {}
    return _registry


def remember_mix(info: dict, path: str, quality: str) -> None:
    reg = _load_registry()
    reg[_key(info["title"], info["uploader"])] = {
        "path": path, "url": info.get("url", ""), "quality": quality, "added": int(time.time()),
    }
    try:
        REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(REGISTRY_FILE.parent), prefix=".mixes.", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(reg, f)
        os.replace(tmp, REGISTRY_FILE)
    except Exception as e:
        logger.warning("Could not save mix registry: %s", e)


def is_mix(name: str, artist: str) -> bool:
    """True while the recorded file is still there. A mix deleted from the library
    is no longer one we own — the BPM answer "owned, not analysable" would be
    untrue, so it falls back to the ordinary ownership check."""
    entry = _load_registry().get(_key(name, artist))
    return bool(entry) and os.path.exists(entry.get("path", ""))


# ── The job ──

_PROGRESS_RE = re.compile(r"^\[download\]\s+(\d{1,3}(?:\.\d+)?)%")


async def _run_ytdlp_progress(cmd: list[str], timeout: float, on_percent) -> tuple[int | None, str]:
    """Run yt-dlp, reporting download percent as it goes. Returns (exit code or
    None when killed, the last error line)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
    except Exception as e:
        return None, str(e)
    tail: list[str] = []

    async def _pump():
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            s = line.decode("utf-8", "replace").strip()
            m = _PROGRESS_RE.match(s)
            if m:
                try:
                    on_percent(float(m.group(1)))
                except Exception:
                    pass
            elif s:
                tail.append(s)
                del tail[:-20]
        await proc.wait()

    try:
        await asyncio.wait_for(_pump(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return None, "timed out"
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode, _last_error("\n".join(tail))


def _fmt_size(n: int) -> str:
    return f"{n / 1024 / 1024:.0f} MB" if n >= 1024 * 1024 else f"{n / 1024:.0f} kB"


SCRATCH_STALE_AFTER = 6 * 3600   # longer than any download's timeout


def _drop_stale_scratch(parent: str) -> None:
    """Remove scratch directories a crashed or killed process left behind. A live
    download's directory is younger than any timeout, so it is never touched."""
    try:
        for p in Path(parent).glob(".mix-dl-*"):
            if p.is_dir() and time.time() - p.stat().st_mtime > SCRATCH_STALE_AFTER:
                shutil.rmtree(p, ignore_errors=True)
    except OSError:
        pass


async def run_mix(job, music_dir: str, timeout: float, check_quota, find_song_id) -> bool:
    """Download one mix for `job`. True when a new file landed in the library.

    `check_quota` and `find_song_id` are passed in by the downloader so this
    module needs nothing from it (and tests can stand them in).

    yt-dlp works in a hidden scratch directory next to the destination, with a
    fixed output name: a `%` in a title can never be read as a template field,
    a cancelled or failed run leaves nothing in the library (the scratch
    directory goes in `finally`), and Navidrome never scans a half-written or
    untagged file. Only a run that exited 0 AND left a file is moved into place,
    already tagged."""
    job.progress_text = "Reading mix details…"
    try:
        info = await fetch_info(job.url)
    except ValueError as e:
        raise RuntimeError(str(e))
    label = info["source_label"]
    job.title = f"{info['uploader']} - {info['title']}"

    if await find_song_id(info["title"], info["uploader"]):
        job.progress_text = f"Already in library · {label}"
        return False
    if job.username and not check_quota(job.username):
        raise RuntimeError("Disk quota exceeded")

    out_dir = mix_dir(music_dir, job.username, info["uploader"])
    base = mix_basename(info["title"])
    os.makedirs(out_dir, exist_ok=True)
    # Same filesystem as out_dir, so the final move is an atomic rename.
    _drop_stale_scratch(os.path.dirname(out_dir))
    scratch = tempfile.mkdtemp(prefix=".mix-dl-", dir=os.path.dirname(out_dir))

    def on_percent(p: float) -> None:
        job.progress = max(job.progress, min(90, int(p * 0.9)))
        job.progress_text = f"Downloading from {label} · {int(p)}%"

    try:
        job.progress_text = f"Downloading from {label}…"
        path_file = os.path.join(scratch, "filepath.txt")
        rc, err = await _run_ytdlp_progress(
            build_download_cmd(info["url"], os.path.join(scratch, "mix.%(ext)s"), path_file),
            timeout, on_percent,
        )
        got = find_output(scratch, "mix")
        if rc != 0 or not got:
            # A non-zero exit with a file on disk is a truncated download or a
            # failed post-processing step — never a mix to keep.
            raise RuntimeError(f"{label}: {err or 'download failed'}")

        job.progress = 92
        # Measure BEFORE tagging: Ogg Opus states no stream bit rate, so the figure
        # is the file's average, and an embedded cover inflates it (measured: a
        # 160 kbps Opus read as 459 kbps with its cover in).
        q = await probe_quality(got)
        quality = quality_label(info["source"], q)
        job.progress_text = "Tagging…"
        cover = await fetch_cover(info["thumbnail"])
        await asyncio.to_thread(write_tags, got, info, cover)

        ext = got.rsplit('.', 1)[-1]
        final = os.path.join(out_dir, f"{base}.{ext}")
        # Two titles can clean up to one name ("A/B", "A:B" → "A_B"). The library
        # check said this mix is not there, so an existing file is another one.
        n = 2
        while os.path.exists(final):
            final = os.path.join(out_dir, f"{base} ({n}).{ext}")
            n += 1
        os.replace(got, final)
        remember_mix(info, final, quality)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    try:
        size = _fmt_size(os.path.getsize(final))
    except OSError:
        size = ""
    job.progress = 100
    job.progress_text = " · ".join(x for x in (quality, size) if x)
    return True
