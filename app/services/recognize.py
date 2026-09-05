import asyncio
import audioop
import logging
import math
import os
import shutil
import struct
import subprocess
import tempfile
import time

from aiohttp_retry import ExponentialRetry
from shazamio import Shazam
from shazamio.client import HTTPClient

logger = logging.getLogger(__name__)

# shazamio's default retry policy is ExponentialRetry(attempts=20, max_timeout=60,
# statuses={500,502,503,504,429}), which can retry for minutes — far longer than the
# frontend's 30s abort. Use a handful of quick attempts instead, and drop 429: retrying
# a rate limit inside a single request cannot succeed and only deepens the rate limit.
# The frontend records 12s clips, but shazamio fingerprints only the first
# `segment_duration_seconds` of what it is given — the default 10 silently threw
# away the last 2 seconds of every recording. Measured on 16 real library tracks
# (clean 12s clips, 2026-09): segment=10 → 14/16 matched; segment=12 recovered
# BOTH misses (Paulo Mac "Toda Noite", Kaysha "Forever") → 16/16. Keep this equal
# to the clip length the client records (see CLIP_MS in static/js/party.js and the
# 12s recorder in static/js/recognize.js).
# Also measured and rejected in the same run, so nobody re-litigates them: a
# multi-window retry (0-10s + 2-12s) recovered 0/2, and region endpoints
# fr-FR/FR and pt-BR/BR recovered 0/2 — the catalogue is not region-gated here.
# A segment longer than the clip is safe: verified 4s/6s/8s clips still match.
_SEGMENT_SECONDS = 12

_shazam = Shazam(
    segment_duration_seconds=_SEGMENT_SECONDS,
    http_client=HTTPClient(
        retry_options=ExponentialRetry(
            attempts=3,
            max_timeout=5,
            statuses={500, 502, 503, 504},
        )
    )
)

_SHAZAM_TIMEOUT_S = 12  # One of THREE bounded stages in POST /api/recognize; the sum
                        # must stay under the frontend's 30s abort, or the client
                        # reports a timeout for a song the server already identified.
                        # Budget: ffmpeg 15s (_convert_to_wav) + this 12s + enrichment
                        # 5s (asyncio.wait_for in routers/settings.py) = 32s ceiling,
                        # but ffmpeg decodes 12s of Opus in well under a second, so the
                        # realistic worst case is ~18s. If you change any of these three,
                        # change them together.


class RecognizerUnavailable(Exception):
    """Shazam errored, timed out, or is rate-limited — a transient service issue, not a no-match."""


class RecognizerInputError(Exception):
    """The uploaded recording was silent, too short, or couldn't be decoded."""


def _convert_to_wav(audio_data: bytes) -> bytes:
    """Convert an uploaded recording (WebM/Opus, MP3, etc.) to mono 16-bit 44.1kHz
    WAV via ffmpeg. Uses a scratch dir for both files instead of deriving the output
    path by string manipulation on the input path."""
    tmpdir = tempfile.mkdtemp(prefix="ms-recognize-")
    inp_path = os.path.join(tmpdir, "in.audio")
    out_path = os.path.join(tmpdir, "out.wav")
    try:
        with open(inp_path, "wb") as f:
            f.write(audio_data)

        result = subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", inp_path,
                "-vn",                  # an uploaded MP3 with embedded cover art would otherwise
                                        # have ffmpeg map the APIC as a video stream and fail outright
                "-ar", "44100",         # 44.1kHz — tested head-to-head vs 16000 across six degradation
                                        # levels (6/6 vs 6/6, no difference). Do not "fix" this.
                "-ac", "1",             # mono
                "-sample_fmt", "s16",   # 16-bit PCM
                "-c:a", "pcm_s16le",
                "-f", "wav",
                out_path,
            ],
            capture_output=True,
            timeout=15,
        )
        if result.returncode != 0:
            # Log stderr, not buried inside an exception message (that made conversion
            # failures undiagnosable). Bounded to the last 1000 chars: -loglevel error
            # keeps this short in practice, but a malformed multi-MB upload could still
            # produce a lot of lines, and this host has already had an outage from an
            # uncapped docker json-file log driver.
            stderr = result.stderr.decode(errors="replace")[-1000:]
            logger.warning("recognize: ffmpeg exited %d: %s", result.returncode, stderr)
            raise RuntimeError(f"ffmpeg conversion failed (exit {result.returncode})")

        with open(out_path, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _wav_stats(wav_bytes: bytes) -> tuple[float, float, float]:
    """Parse a RIFF/WAVE file's sub-chunks — rather than assuming a fixed 44-byte
    header, since some ffmpeg builds add a LIST/INFO chunk before "data" — and return
    (duration_seconds, rms_dbfs, peak_rms_dbfs) for the PCM payload. rms_dbfs is the
    whole-clip average (kept for logging); peak_rms_dbfs is the max RMS over ~1s
    windows, which is what the silence gate should decide on — Shazam only needs
    ~5 usable seconds, so a clip that is quiet for 7s and good for the last 5s must
    not be rejected just because the whole-clip average is dragged down.
    Returns (0.0, -inf, -inf) if the file is empty or can't be parsed; the caller
    treats that as a decode error.
    Stdlib only: struct for the header, audioop for RMS over the int16 samples.

    Note: this uses the stdlib `audioop` module, which is removed in Python 3.13
    (PEP 594). Fine on the current python:3.11-slim base image; if that ever moves
    to 3.13+, this needs to be reimplemented (e.g. with `array` + manual sum-of-squares).
    """
    if len(wav_bytes) < 12 or wav_bytes[:4] != b"RIFF" or wav_bytes[8:12] != b"WAVE":
        return 0.0, float("-inf"), float("-inf")

    channels, sample_rate, bits_per_sample = 1, 44100, 16
    data = b""
    offset = 12
    while offset + 8 <= len(wav_bytes):
        chunk_id = wav_bytes[offset:offset + 4]
        (chunk_size,) = struct.unpack_from("<I", wav_bytes, offset + 4)
        chunk_start = offset + 8
        chunk_end = min(chunk_start + chunk_size, len(wav_bytes))
        if chunk_id == b"fmt " and chunk_end - chunk_start >= 16:
            _, channels, sample_rate, _, _, bits_per_sample = struct.unpack_from(
                "<HHIIHH", wav_bytes, chunk_start
            )
        elif chunk_id == b"data":
            data = wav_bytes[chunk_start:chunk_end]
        offset = chunk_end + (chunk_size & 1)  # chunks are word-aligned (padded if odd-sized)

    if not data or bits_per_sample != 16 or channels < 1 or sample_rate <= 0:
        return 0.0, float("-inf"), float("-inf")

    sample_width = 2
    frame_size = sample_width * channels
    usable = len(data) - (len(data) % frame_size)
    if usable <= 0:
        return 0.0, float("-inf"), float("-inf")
    data = data[:usable]

    duration = (usable // frame_size) / sample_rate
    rms = audioop.rms(data, sample_width)
    rms_dbfs = 20 * math.log10(rms / 32768.0) if rms > 0 else float("-inf")

    # Windowed max RMS: split into ~1s windows (frame-aligned) and take the loudest
    # one. This is the statistic the silence gate should act on — a whole-clip
    # average is dragged down by quiet stretches even when a few good seconds of
    # usable audio are present, and Shazam only needs ~5s of those.
    window_frames = sample_rate  # ~1 second of frames
    window_bytes = window_frames * frame_size
    peak_rms = 0
    if window_bytes > 0:
        for start in range(0, usable, window_bytes):
            chunk = data[start:start + window_bytes]
            # audioop.rms requires a whole number of frames; a short trailing
            # chunk still divides evenly since frame_size divides len(data).
            chunk_len = len(chunk) - (len(chunk) % frame_size)
            if chunk_len <= 0:
                continue
            chunk_rms = audioop.rms(chunk[:chunk_len], sample_width)
            if chunk_rms > peak_rms:
                peak_rms = chunk_rms
    peak_rms_dbfs = 20 * math.log10(peak_rms / 32768.0) if peak_rms > 0 else float("-inf")

    return duration, rms_dbfs, peak_rms_dbfs


def _extract_album(track: dict) -> str:
    """Safely extract album name from Shazam track data."""
    try:
        sections = track.get("sections", [])
        if sections:
            metadata = sections[0].get("metadata", [])
            if metadata:
                return metadata[0].get("text", "")
    except (IndexError, AttributeError):
        pass
    return ""


async def identify_song(audio_data: bytes, user: str = "", content_type: str = "") -> dict | None:
    """Identify a song from a short microphone recording via Shazam.

    Returns the matched track dict, or None on a genuine no-match (a normal, frequent
    outcome — only ~68% of the library is in Shazam's database at all). Raises
    RecognizerInputError for silent/too-short/undecodable input, or RecognizerUnavailable
    if Shazam errored, timed out, or is rate-limited — callers must not conflate either
    with a no-match.
    """
    upload_bytes = len(audio_data)
    logger.info(
        "recognize start user=%s upload_bytes=%d content_type=%s", user, upload_bytes, content_type
    )

    outcome = "recognizer_error"
    ffmpeg_ms = 0
    pcm_s = 0.0
    rms_dbfs = float("-inf")
    peak_rms_dbfs = float("-inf")
    shazam_ms = 0
    track_str = "-"

    try:
        t0 = time.monotonic()
        try:
            wav_data = await asyncio.to_thread(_convert_to_wav, audio_data)
        except Exception as e:
            outcome = "decode_error"
            logger.warning("recognize: audio conversion failed: %s: %s", type(e).__name__, e)
            raise RecognizerInputError("Could not decode the recording.") from e
        ffmpeg_ms = int((time.monotonic() - t0) * 1000)

        pcm_s, rms_dbfs, peak_rms_dbfs = _wav_stats(wav_data)
        if pcm_s <= 0:
            outcome = "decode_error"
            raise RecognizerInputError("Could not decode the recording.")
        if pcm_s < 3.0:
            outcome = "silent_input"
            raise RecognizerInputError("Recording too short — hold the button for the full 12 seconds.")
        # Gate on the loudest ~1s window, not the whole-clip average: a clip that's
        # quiet for 7s and good for the last 5s is plenty for Shazam and must not be
        # rejected just because the average is dragged down. -60 dBFS sits at/below
        # typical phone mic self-noise (~-60 to -70 dBFS), so this only catches
        # genuinely muted or dead input, not a real quiet recording.
        if peak_rms_dbfs < -60.0:
            outcome = "silent_input"
            raise RecognizerInputError(
                "Almost no sound reached the microphone — check it isn't muted and the music is loud enough."
            )

        t1 = time.monotonic()
        try:
            result = await _try_shazam(wav_data)
        except Exception as e:
            shazam_ms = int((time.monotonic() - t1) * 1000)
            outcome = "recognizer_error"
            logger.warning("recognize: shazam recognize failed: %s: %s", type(e).__name__, e)
            raise RecognizerUnavailable("Recognition service unavailable — try again in a moment.") from e
        shazam_ms = int((time.monotonic() - t1) * 1000)

        if result:
            result["recognized_by"] = "Shazam"
            outcome = "match"
            track_str = f"{result.get('artist', '')} - {result.get('name', '')}"
            return result

        outcome = "no_match"
        return None
    except asyncio.CancelledError:
        # A client disconnect (e.g. the frontend's 30s abort) raises CancelledError,
        # a BaseException that skips the `except Exception` handlers above. Without
        # this, the finally block below would log the initial "recognizer_error"
        # outcome, making a routine disconnect look like a Shazam outage.
        outcome = "client_disconnect"
        raise
    finally:
        logger.info(
            "recognize done  user=%s ffmpeg_ms=%d pcm_s=%.2f rms_dbfs=%.1f peak_rms_dbfs=%.1f "
            "shazam_ms=%d outcome=%s track=%s",
            user, ffmpeg_ms, pcm_s, rms_dbfs, peak_rms_dbfs, shazam_ms, outcome, track_str,
        )


async def _try_shazam(wav_data: bytes) -> dict | None:
    """Identify via Shazam. Returns None on a genuine no-match only; any other
    failure (timeout, rate limit, transport error) propagates so the caller can
    tell a recognizer outage from a legitimate no-match instead of both silently
    collapsing to None."""
    result = await asyncio.wait_for(_shazam.recognize(wav_data), timeout=_SHAZAM_TIMEOUT_S)

    track = result.get("track")
    if not track:
        return None

    # Extract Spotify URL if available
    spotify_url = ""
    for provider in track.get("providers", []):
        if provider.get("type") == "SPOTIFY":
            for action in provider.get("actions", []):
                uri = action.get("uri", "")
                if "spotify" in uri:
                    spotify_url = uri
                    break

    if not spotify_url:
        for option in track.get("hub", {}).get("options", []):
            for action in option.get("actions", []):
                uri = action.get("uri", "")
                if "spotify" in uri:
                    spotify_url = uri
                    break

    images = track.get("images", {})
    cover = images.get("coverarthq") or images.get("coverart") or ""

    return {
        "name": track.get("title", ""),
        "artist": track.get("subtitle", ""),
        "album": _extract_album(track),
        "image": cover,
        "shazam_url": track.get("url", ""),
        "spotify_url": spotify_url,
        "genre": track.get("genres", {}).get("primary", ""),
        "type": "track",
    }
