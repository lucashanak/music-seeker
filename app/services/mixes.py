"""DJ mixes from Mixcloud, SoundCloud, hearthis.at and YouTube: download exactly
the linked file.

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

SOURCE_LABEL = {"mixcloud": "Mixcloud", "soundcloud": "SoundCloud",
                "hearthis": "hearthis.at", "youtube": "YouTube"}

# Sources whose links ARE mixes. `start_download` turns any such link into a mix
# job whatever the client called it. YouTube is deliberately not here: the YouTube
# Music search provider hands out plain watch URLs as the `url` of ordinary
# tracks (search_providers.py), so treating every YouTube link as a mix would
# send every YouTube Music track download down this path. A YouTube video is a
# mix only when the client says `type: "mix"`.
AUTO_MIX_SOURCES = {"mixcloud", "soundcloud", "soundcloud-short", "hearthis"}

NOT_A_MIX = "Not a single-mix link from Mixcloud or SoundCloud, hearthis.at or YouTube"

# One album per DJ, whichever site the mix came from. Navidrome keys albums on
# album + album artist, so "DJ Sets" by Martin Šmoldas is one album holding all
# of his mixes — Mixcloud and SoundCloud alike — instead of one single-track album
# per mix flooding the album view, and instead of the site name splitting one DJ's
# work in two. Where a mix came from is kept in the COMMENT tag (its URL).
MIX_ALBUM = "DJ Sets"

# Where a mix lives: <MUSIC_DIR>/<user>/<DJ>/DJ Sets/<title>.<ext> — the same
# Artist/Album shape as every other download, matching the tags (ARTIST = DJ,
# ALBUM = "DJ Sets"). The player's local-file lookup first searches
# <user>/<artist>/ and only then globs the title over everything; under the old
# <user>/Mixes/<DJ>/ layout every mix took the broad glob, and a generic title
# ("Sunday set") played ANOTHER DJ's mix. Now two DJs never collide; one DJ's
# two mixes of the same title still do (the second is saved as "<title> (2)",
# which the player cannot find by name and plays through Navidrome).
#
# yt-dlp works in <MUSIC_DIR>/.mix-dl/<random>: the same filesystem (the final
# move is an atomic rename), outside every user's tree, and hidden from both the
# player (it skips top-level dot dirs) and Navidrome.
SCRATCH_ROOT = ".mix-dl"

INFO_TIMEOUT = 60          # yt-dlp -J for one mix
PROBE_TIMEOUT = 30         # ffprobe of the finished file
COVER_TIMEOUT = 20
COVER_MAX_BYTES = 15 * 1024 * 1024   # an "original" artwork PNG can be several MB

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
REGISTRY_FILE = DATA_DIR / "mixes.json"

# Audio extensions yt-dlp's `-x` (codec "best", i.e. no re-encode) can leave behind.
# hearthis.at hands out the uploader's ORIGINAL file when downloads are allowed:
# measured 2026-11-17 on 61 downloadable tracks, 42 were MP3, 17 M4A (AAC ~310k)
# and 2 WAV (PCM 1411k).
AUDIO_EXTS = ("m4a", "opus", "ogg", "mp3", "aac", "flac", "webm", "mka", "wav", "aif", "aiff")


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

_HEARTHIS_RESERVED = {
    "search", "categories", "category", "charts", "live", "upload", "settings", "messages",
    "notifications", "feed", "stream", "explore", "labels", "podcasts", "playlists", "set",
    "sets", "login", "register", "signup", "about", "faq", "help", "imprint", "terms",
    "privacy", "pro", "shop", "api", "app", "embed", "events", "radio", "genres", "tags",
    "maps", "discover",
}
_HEARTHIS_USER_PAGES = {
    "likes", "playlists", "set", "sets", "followers", "following", "reshares", "tracks",
    "albums", "events", "about", "comments", "listen", "download", "embed", "fans", "podcast",
}

_SLUG_RE = re.compile(r"^[^\s/?#]+$")


def hearthis_segment_ok(seg: str) -> bool:
    """A hearthis.at user or track name: its own characters, and never made of
    dots alone ("..")."""
    return bool(re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", seg or "") and re.search(r"[A-Za-z0-9]", seg))
_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def parse_mix_url(text: str) -> tuple[str, str] | None:
    """Return (source, canonical_url) for a single Mixcloud, SoundCloud,
    hearthis.at or YouTube recording found in `text`, else None.

    A YouTube result does NOT make a link a mix by itself — see AUTO_MIX_SOURCES.

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

    if host in ("hearthis.at", "www.hearthis.at"):
        if len(segs) != 2:
            return None
        user, slug = unquote(segs[0]), unquote(segs[1])
        if user.lower() in _HEARTHIS_RESERVED or slug.lower() in _HEARTHIS_USER_PAGES:
            return None
        if not (hearthis_segment_ok(user) and hearthis_segment_ok(slug)):
            return None
        return "hearthis", f"https://hearthis.at/{user}/{slug}/"

    if host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"):
        if segs != ["watch"]:
            return None
        vid = ""
        for pair in parts.query.split("&"):
            k, _, v = pair.partition("=")
            if k == "v":
                vid = v
                break
        if not _YT_ID_RE.match(vid):
            return None
        return "youtube", f"https://www.youtube.com/watch?v={vid}"

    if host == "youtu.be":
        if len(segs) != 1 or not _YT_ID_RE.match(segs[0]):
            return None
        return "youtube", f"https://www.youtube.com/watch?v={segs[0]}"

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


# ── Quality before downloading ──
# What a search result or the paste banner can say about quality without
# downloading anything. `quality_known` is False where the figure is what the
# site typically serves (YouTube, hearthis.at) rather than read from the
# recording's own format list or the site's own answer.

def nominal_quality(codec: str, kbps: int, known: bool) -> dict:
    return {"codec": codec, "kbps": int(kbps or 0), "quality_known": bool(known),
            "quality_label": f"{codec} {int(kbps)}" if kbps else codec}


# Measured 2026-11-17 (ffprobe of the served streams):
#  - Mixcloud SQ = AAC 64, HQ (author has Pro) = AAC 192 beside Opus ~195.
#  - hearthis.at `mp3-1` (the uploader allows downloads) = MP3 192 on 3 of 4
#    mixes, 256 on the fourth; the stream `mp3-0` = MP3 128 on 2, 192 on 2.
#  - YouTube itag 140 = AAC 129 on all 4 measured; never probed per video
#    (every probe is a request YouTube counts against us).
def mixcloud_quality(audio_quality: str) -> dict:
    return nominal_quality("AAC", 192 if str(audio_quality).upper() == "HQ" else 64, True)


LOSSLESS_KBPS = 1411   # CD PCM; what a WAV/AIFF/FLAC original amounts to for the filters

_LOSSLESS = {"wav": "WAV", "aif": "AIFF", "aiff": "AIFF", "flac": "FLAC"}


def hearthis_quality(downloadable, download_filename: str = "") -> dict:
    """What a hearthis.at download gets. With downloads allowed it is the
    uploader's original, whose kind the file name tells (measured: MP3 192-256,
    M4A AAC ~310, WAV 1411); without, the stream (MP3 128-192)."""
    if str(downloadable) != "1":
        return nominal_quality("MP3", 128, False)
    ext = str(download_filename or "").rsplit(".", 1)[-1].lower() if "." in str(download_filename or "") else "mp3"
    if ext in _LOSSLESS:
        q = nominal_quality(_LOSSLESS[ext], LOSSLESS_KBPS, False)
        q["quality_label"] = f"{_LOSSLESS[ext]} lossless"
        return q
    if ext in ("m4a", "aac", "mp4"):
        return nominal_quality("AAC", 256, False)
    return nominal_quality("MP3", 192, False)


def youtube_quality() -> dict:
    return nominal_quality("AAC", 128, False)


# hearthis lists formats without rates: "mp3" (stream) beside the original,
# named after its extension ("mp3-0"/"mp3-1" when both are MP3).
_HEARTHIS_NOMINAL = {"mp3-1": 192, "mp3-0": 128, "mp3": 128, "m4a": 256,
                     "wav": LOSSLESS_KBPS, "aif": LOSSLESS_KBPS, "aiff": LOSSLESS_KBPS,
                     "flac": LOSSLESS_KBPS}


def _is_aac(f: dict) -> bool:
    ac = str(f.get("acodec") or "").lower()
    return ac.startswith("mp4a") or ac == "aac" or "aac" in str(f.get("format_id") or "").lower()


def _codec_of(f: dict) -> str:
    if _is_aac(f):
        return "AAC"
    ac = str(f.get("acodec") or "").lower()
    for key, label in (("opus", "Opus"), ("mp3", "MP3"), ("vorbis", "Vorbis"), ("flac", "FLAC")):
        if key in ac or key in str(f.get("format_id") or "").lower():
            return label
    ext = str(f.get("ext") or "").lower()
    return {"mp3": "MP3", "m4a": "AAC", "opus": "Opus", "ogg": "Vorbis", "wav": "WAV",
            "aif": "AIFF", "aiff": "AIFF"}.get(ext, ac.upper() or "?")


def quality_from_formats(formats: list[dict]) -> dict | None:
    """The quality the download selector (`bestaudio[acodec^=mp4a]/bestaudio`)
    will get, from a yt-dlp format list: the best AAC, else the best audio.
    None when the list says nothing usable."""
    # A SoundCloud Go+ track offers only a 30 s "_preview" to a listener.
    formats = [f for f in formats or [] if isinstance(f, dict)
               and "preview" not in str(f.get("format_id") or "")]
    audio = [f for f in formats if str(f.get("acodec") or "") != "none"
             and str(f.get("vcodec") or "none") in ("none", "")]
    if not audio:
        audio = [f for f in formats if str(f.get("acodec") or "") != "none"]
    if not audio:
        return None

    def rate(f):
        for k in ("abr", "tbr"):
            try:
                v = float(f.get(k) or 0)
            except (TypeError, ValueError):
                v = 0
            if v > 0:
                return v
        return float(_HEARTHIS_NOMINAL.get(str(f.get("format_id")), 0))

    aac = [f for f in audio if _is_aac(f)]
    pool = aac or audio
    best = max(pool, key=rate)
    kbps = int(round(rate(best)))
    known = bool(best.get("abr") or best.get("tbr"))
    q = nominal_quality(_codec_of(best), kbps, known)
    if q["codec"] in ("WAV", "AIFF", "FLAC"):
        q["quality_label"] = f"{q['codec']} lossless"
    return q


# A banner lookup is one yt-dlp process; a burst of pastes must not become a burst
# of processes (and of requests to the site).
_info_slots = asyncio.Semaphore(2)


def _youtube_refused() -> bool:
    from app.services import player
    return player.youtube_rate_limited()


def _note_youtube_stderr(what: str, err: str) -> None:
    """Hand yt-dlp's complaint to the player's rate-limit latch: a 429 met here
    must park YouTube playback too, and the other way round."""
    from app.services import player
    player._note_ytdlp_stderr(what, err)


async def _hearthis_info(url: str) -> dict:
    """One hearthis.at track from its public API. yt-dlp is no use for the
    metadata: it prefixes the title with the uploader and states no uploader."""
    from app.services import mix_sources
    path = urlsplit(url).path
    try:
        d = await mix_sources.get_json(f"{mix_sources.HEARTHIS_API}{path}")
    except Exception as e:
        raise ValueError(f"hearthis.at: {str(e)[:200] or 'not found'}")
    try:
        item = mix_sources.parse_hearthis_track(d) if isinstance(d, dict) else None
    except Exception:
        item = None   # a malformed answer is "not a track", never a 500
    if not item:
        raise ValueError("hearthis.at: not a track")
    return item


async def fetch_info(url: str) -> dict:
    """Metadata of one mix, with the quality the download will get. Raises
    ValueError with a user-facing reason."""
    parsed = await canonical(url)
    if not parsed:
        raise ValueError(NOT_A_MIX)
    source, curl = parsed
    if source == "hearthis":
        item = await _hearthis_info(curl)
        info = {k: item[k] for k in ("source", "source_label", "url", "title", "uploader",
                                     "thumbnail", "date", "duration")}
        info.update({k: item[k] for k in ("codec", "kbps", "quality_known", "quality_label")})
        return info
    if source == "youtube" and _youtube_refused():
        raise ValueError("YouTube is rate-limiting us — try again in a few minutes")
    async with _info_slots:
        rc, out, err = await _run_capture(
            ["yt-dlp", "-J", "--no-playlist", "--skip-download", "--", curl], INFO_TIMEOUT,
        )
    if source == "youtube":
        _note_youtube_stderr(f"mix info {curl[-11:]}", err)
    if rc != 0 or not out.strip():
        raise ValueError(f"{SOURCE_LABEL[source]}: {_last_error(err)}")
    try:
        d = json.loads(out)
    except ValueError:
        raise ValueError(f"{SOURCE_LABEL[source]}: unreadable answer")
    if not isinstance(d, dict):
        raise ValueError(f"{SOURCE_LABEL[source]}: unreadable answer")
    if d.get("_type") == "playlist":
        raise ValueError("That link is a playlist, not a single mix")
    try:
        info = normalize_info(d, source, curl)
    except (TypeError, ValueError, AttributeError, OverflowError, OSError):
        raise ValueError(f"{SOURCE_LABEL[source]}: unreadable answer")
    q = None
    if source == "mixcloud":
        # Mixcloud lists the same stream under several names; its own answer
        # says SQ or HQ outright.
        from app.services import mix_sources
        try:
            aq = await mix_sources.mixcloud_audio_quality(curl)
            if aq:
                q = mixcloud_quality(aq)
        except Exception:
            q = None
    if q is None:
        q = quality_from_formats(d.get("formats") or [])
    if q is None:
        q = nominal_quality("?", 0, False)
    info.update(q)
    return info


# ── Paths ──

def _sanitize(name: str) -> str:
    """Same rule as downloader._sanitize and player._sanitize (the file lookup
    must find what we write), applied after folding to NFC."""
    return re.sub(r'[/\\:*?"<>|]', '_', nfc(name)).strip().rstrip('.')


class MixPathError(ValueError):
    pass


def user_folder(username: str) -> str:
    """The user's own folder name. A user name that would clean up to another
    name ("lucas." → "lucas") is refused rather than mapped onto someone else's
    folder — downloads, the list, delete and the follow check all ask here."""
    folder = _sanitize(username)
    if not username or folder != username or folder in (".", ".."):
        raise MixPathError("This account name cannot have a music folder")
    return folder


def dj_folder(uploader: str) -> str:
    # No leading dot: a hidden folder is skipped by Navidrome and the player.
    return _sanitize(uploader).lstrip(".").strip() or "Unknown DJ"


def mix_dir(music_dir: str, username: str, uploader: str) -> str:
    base = f"{music_dir}/{user_folder(username)}" if username else music_dir
    return f"{base}/{dj_folder(uploader)}/{MIX_ALBUM}"


# yt-dlp writes a fixed "mix.<ext>" in scratch, so the title only has to fit the
# final name: 255 bytes less the longest extension we keep (".aiff", ".flac").
NAME_MAX_BYTES = 255 - max(len("." + e) for e in AUDIO_EXTS)


def mix_basename(title: str) -> str:
    # Must equal player._sanitize(nfc(title)) whenever no cut is needed — that is
    # how the player's local-file lookup finds the mix. A cut name it cannot
    # find; the cut is as rare as a 250-byte limit makes it.
    name = _sanitize(title) or "Untitled mix"
    if len(name.encode("utf-8")) > NAME_MAX_BYTES:
        while len(name.encode("utf-8")) > NAME_MAX_BYTES:
            name = name[:-1]
        name = name.strip().rstrip(".") or "Untitled mix"
    return name


# A SoundCloud Go+ track offers a listener only a 30 s "*_preview" stream, and when that is
# the one AAC beside a full MP3 the plain `[acodec^=mp4a]` filter picked the preview.
_NO_PREVIEW = "[format_id!*=preview]"
FORMAT_SELECTOR = (f"bestaudio[acodec^=mp4a]{_NO_PREVIEW}/bestaudio{_NO_PREVIEW}/best{_NO_PREVIEW}")


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
        "-f", FORMAT_SELECTOR,
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
    label = "PCM" if codec.startswith("pcm_") else _CODEC_LABEL.get(codec, codec.upper() or "?")
    return {"codec": label,
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
        "source": info.get("source", ""), "thumbnail": info.get("thumbnail", ""),
    }
    _save_registry(reg)


def _save_registry(reg: dict) -> None:
    try:
        REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(REGISTRY_FILE.parent), prefix=".mixes.", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(reg, f)
        os.replace(tmp, REGISTRY_FILE)
    except Exception as e:
        logger.warning("Could not save mix registry: %s", e)


def forget_path(path: str) -> int:
    """Drop every registry entry recorded for `path`. Returns how many went."""
    reg = _load_registry()
    real = os.path.realpath(path)
    gone = [k for k, v in reg.items()
            if isinstance(v, dict) and os.path.realpath(v.get("path", "") or "/nonexistent") == real]
    for k in gone:
        reg.pop(k, None)
    if gone:
        _save_registry(reg)
    return len(gone)


def _registry_by_path() -> dict[str, dict]:
    out = {}
    for v in _load_registry().values():
        if isinstance(v, dict) and v.get("path"):
            out[os.path.realpath(v["path"])] = v
    return out


def is_mix(name: str, artist: str) -> bool:
    """True while the recorded file is still there. A mix deleted from the library
    is no longer one we own — the BPM answer "owned, not analysable" would be
    untrue, so it falls back to the ordinary ownership check."""
    entry = _load_registry().get(_key(name, artist))
    return bool(entry) and os.path.exists(entry.get("path", ""))


# ── The downloaded mixes of one user ──

def user_root(music_dir: str, username: str) -> str:
    return os.path.join(music_dir, user_folder(username))


def _source_of_url(url: str) -> str:
    p = parse_mix_url(url or "")
    if not p:
        return ""
    return "soundcloud" if p[0] == "soundcloud-short" else p[0]


def _read_file_meta(path: str) -> dict:
    """Title, artist, comment, length and a bit-rate guess from the file's tags."""
    out = {"title": "", "artist": "", "comment": "", "duration": 0, "codec": "", "kbps": 0}
    if path.lower().endswith(".mp3"):
        # EasyID3 has no "comment" key; read the ID3 frames themselves (this
        # also works where the MPEG stream itself cannot be parsed).
        try:
            from mutagen.id3 import ID3
            t = ID3(path)
            out["title"] = str(t["TIT2"].text[0]) if "TIT2" in t else ""
            out["artist"] = str(t["TPE1"].text[0]) if "TPE1" in t else ""
            comms = t.getall("COMM")
            out["comment"] = str(comms[0].text[0]) if comms and comms[0].text else ""
        except Exception:
            pass
    try:
        import mutagen
        f = mutagen.File(path, easy=True)
    except Exception:
        f = None
    if f is None:
        return out
    tags = f.tags or {}

    def first(key):
        try:
            v = tags.get(key)
        except Exception:
            v = None
        return str(v[0]) if v else ""

    out["title"] = first("title") or out["title"]
    out["artist"] = first("artist") or out["artist"]
    out["comment"] = first("comment") or out["comment"]
    info = getattr(f, "info", None)
    if info is not None:
        out["duration"] = int(getattr(info, "length", 0) or 0)
        br = int(getattr(info, "bitrate", 0) or 0)
        out["kbps"] = int(round(br / 1000)) if br else 0
        codec = str(getattr(info, "codec", "") or "").lower()
        ext = path.rsplit(".", 1)[-1].lower()
        if codec.startswith("mp4a") or ext in ("m4a", "aac"):
            out["codec"] = "AAC"
        elif ext == "opus":
            out["codec"] = "Opus"
        elif ext == "mp3":
            out["codec"] = "MP3"
        elif ext == "flac":
            out["codec"] = "FLAC"
        elif ext == "ogg":
            out["codec"] = "Vorbis"
        elif ext == "wav":
            out["codec"] = "WAV"
        elif ext in ("aif", "aiff"):
            out["codec"] = "AIFF"
        else:
            out["codec"] = ext.upper()
    return out


def _is_our_mix(reg_entry: dict, meta: dict) -> bool:
    """A file is one of our mixes when the registry recorded it, or when its
    COMMENT is a link to one of our sources (write_tags puts the source URL
    there) — a registry lost with the data dir does not orphan the mixes."""
    return bool(reg_entry) or bool(parse_mix_url(meta.get("comment") or "")
                                   and str(meta.get("comment")).startswith(("http://", "https://")))


def list_library(music_dir: str, username: str) -> dict:
    """Every downloaded mix of `username` — every audio file in
    <user>/<DJ>/DJ Sets/ — grouped by DJ folder. The disk is the truth, not the
    registry: a mix the registry lost is still listed and deletable. Reads
    tags, so call it off the event loop."""
    try:
        root = user_root(music_dir, username)
    except MixPathError:
        return {"djs": [], "total_size": 0, "count": 0}
    by_path = _registry_by_path()
    djs, total_size, total_count = [], 0, 0
    try:
        dj_names = sorted(os.listdir(root), key=lambda n: nfc(n).casefold())
    except OSError:
        dj_names = []
    for dj in dj_names:
        dj_path = os.path.join(root, dj, MIX_ALBUM)
        if dj.startswith(".") or not os.path.isdir(dj_path):
            continue   # hidden, a stray file, or an artist with no DJ sets
        mixes_ = []
        for fname in os.listdir(dj_path):
            fpath = os.path.join(dj_path, fname)
            if fname.startswith(".") or not os.path.isfile(fpath):
                continue
            ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
            if ext not in AUDIO_EXTS:
                continue
            try:
                st = os.stat(fpath)
            except OSError:
                continue
            meta = _read_file_meta(fpath)
            reg = by_path.get(os.path.realpath(fpath), {})
            if not _is_our_mix(reg, meta):
                continue   # an ordinary album that happens to be called "DJ Sets"
            url = reg.get("url") or (meta["comment"] if meta["comment"].startswith("https://") else "")
            quality = reg.get("quality", "")
            if not quality and meta["kbps"]:
                quality = f"{meta['codec']} {meta['kbps']} kbps"
            elif not quality:
                quality = meta["codec"]
            source = reg.get("source") or _source_of_url(url)
            mixes_.append({
                "file": fname,
                "dj": dj,
                "title": nfc(meta["title"]) or nfc(os.path.splitext(fname)[0]),
                "artist": nfc(meta["artist"]) or nfc(dj),
                "size": st.st_size,
                "duration": meta["duration"],
                "quality": quality,
                "url": url,
                "source": source,
                "source_label": SOURCE_LABEL.get(source, ""),
                "thumbnail": reg.get("thumbnail", ""),
                "modified": int(st.st_mtime),
            })
        if not mixes_:
            continue
        mixes_.sort(key=lambda m: m["modified"], reverse=True)
        size = sum(m["size"] for m in mixes_)
        total_size += size
        total_count += len(mixes_)
        djs.append({"name": nfc(dj), "dir": dj, "mixes": mixes_, "count": len(mixes_), "total_size": size})
    return {"djs": djs, "total_size": total_size, "count": total_count}


def _one_component(name: str) -> str:
    """A single, ordinary path component — never a separator, '.', '..' or a
    hidden (scratch) name."""
    name = str(name or "")
    if (not name or name != os.path.basename(name) or "/" in name or "\\" in name
            or name in (".", "..") or name.startswith(".") or "\0" in name):
        raise MixPathError("Invalid name")
    return name


def resolve_library_file(music_dir: str, username: str, dj: str, file: str) -> str:
    """The absolute path of one downloaded mix, proven to be exactly
    <user>/<dj>/DJ Sets/<file> inside the user's own folder (symlinks resolved).
    Raises MixPathError for anything else."""
    dj, file = _one_component(dj), _one_component(file)
    root = os.path.realpath(user_root(music_dir, username))
    path = os.path.realpath(os.path.join(root, dj, MIX_ALBUM, file))
    album = os.path.dirname(path)
    if (os.path.basename(album) != MIX_ALBUM or os.path.dirname(os.path.dirname(album)) != root
            or os.path.basename(os.path.dirname(album)).startswith(".")):
        raise MixPathError("Invalid path")
    ext = file.rsplit(".", 1)[-1].lower() if "." in file else ""
    if ext not in AUDIO_EXTS:
        raise MixPathError("Not a mix file")
    return path


def delete_library_file(music_dir: str, username: str, dj: str, file: str) -> dict | None:
    """Delete one downloaded mix and its registry entry, then the "DJ Sets"
    folder when it is empty, then the DJ folder when THAT is empty — never a DJ
    folder that still holds other albums. Returns the deleted mix's {title, artist} (what the player
    keyed its stream on), None when the file is not there."""
    path = resolve_library_file(music_dir, username, dj, file)
    if not os.path.isfile(path):
        return None
    meta = _read_file_meta(path)
    if not _is_our_mix(_registry_by_path().get(os.path.realpath(path), {}), meta):
        raise MixPathError("Not a downloaded mix")
    gone = {"title": nfc(meta["title"]) or nfc(os.path.splitext(file)[0]),
            "artist": nfc(meta["artist"]) or nfc(dj)}
    os.remove(path)
    forget_path(path)
    album_dir = os.path.dirname(path)
    for d in (album_dir, os.path.dirname(album_dir)):
        try:
            if os.listdir(d):
                break
            os.rmdir(d)
        except OSError:
            break
    return gone


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
    """Remove scratch directories a crashed or killed process left behind in
    `parent` (<MUSIC_DIR>/.mix-dl). A live download's directory is younger than
    any timeout, so it is never touched."""
    try:
        for p in Path(parent).iterdir():
            if p.is_dir() and time.time() - p.stat().st_mtime > SCRATCH_STALE_AFTER:
                shutil.rmtree(p, ignore_errors=True)
    except OSError:
        pass


def release_page_cache(path: str) -> None:
    """Flush `path` to disk and hand its pages back to the kernel.

    The container's memory limit counts page cache too. Writing a mix (yt-dlp,
    then the tag rewrite) leaves the whole file in cache, dirty at first. That
    was enough to OOM-kill the container on 2026-11-18: anon 502 MB, but 1564 MB
    of file cache that btrfs did not give back in time. Measured on /music (btrfs)
    inside the container: FADV_DONTNEED on a 166 MB set returned all 167 MB.
    fsync comes first because dirty pages cannot be dropped. Best effort only."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
    except (OSError, AttributeError):
        pass
    finally:
        os.close(fd)


async def run_mix(job, music_dir: str, timeout: float, check_quota, find_song_id) -> bool:
    """Download one mix for `job`. True when a new file landed in the library.

    `check_quota` and `find_song_id` are passed in by the downloader so this
    module needs nothing from it (and tests can stand them in).

    yt-dlp works in a scratch directory under <MUSIC_DIR>/.mix-dl, with a
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
    # Same filesystem as out_dir, so the final move is an atomic rename.
    scratch_root = os.path.join(music_dir, SCRATCH_ROOT)
    os.makedirs(scratch_root, exist_ok=True)
    _drop_stale_scratch(scratch_root)
    scratch = tempfile.mkdtemp(prefix="dl-", dir=scratch_root)

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
        if info["source"] == "youtube" and rc != 0:
            _note_youtube_stderr(f"mix download {info['url'][-11:]}", err)
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
        # Made only now: a failed or cancelled download leaves no empty
        # "<DJ>/DJ Sets" behind in the library.
        os.makedirs(out_dir, exist_ok=True)
        final = os.path.join(out_dir, f"{base}.{ext}")
        # Two titles can clean up to one name ("A/B", "A:B" → "A_B"). The library
        # check said this mix is not there, so an existing file is another one.
        # "<title> (2)" is not found by the player's name lookup; it plays
        # through Navidrome.
        n = 2
        while os.path.exists(final):
            final = os.path.join(out_dir, f"{base} ({n}).{ext}")
            n += 1
        # Before the rename, on the same inode: a cancel landing in this await
        # still leaves nothing in the library. After it, a cancelled job whose file
        # had already landed would be retried and saved again as "<title> (2)".
        await asyncio.to_thread(release_page_cache, got)
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
