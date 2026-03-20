import asyncio
import os
import subprocess
import tempfile
from shazamio import Shazam

_shazam = Shazam()

ACOUSTID_API_KEY = os.environ.get("ACOUSTID_API_KEY", "")


def _convert_to_wav(audio_data: bytes) -> bytes:
    """Convert any audio format (WebM/Opus, etc.) to WAV via ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as inp:
        inp.write(audio_data)
        inp_path = inp.name

    out_path = inp_path.rsplit(".", 1)[0] + ".wav"

    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-i", inp_path,
                "-ar", "44100",    # 44.1kHz sample rate
                "-ac", "1",        # mono
                "-sample_fmt", "s16",  # 16-bit PCM
                out_path,
            ],
            capture_output=True,
            timeout=15,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg conversion failed: {result.stderr.decode()[:200]}")

        with open(out_path, "rb") as f:
            return f.read()
    finally:
        for p in (inp_path, out_path):
            try:
                os.unlink(p)
            except OSError:
                pass


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


async def identify_song(audio_data: bytes) -> dict | None:
    """Identify a song. Tries Shazam first, then AcoustID as fallback."""
    # Convert browser audio (WebM/Opus) to WAV
    try:
        wav_data = await asyncio.to_thread(_convert_to_wav, audio_data)
    except Exception as e:
        raise RuntimeError(f"Audio conversion failed: {e}")

    # Try Shazam first
    result = await _try_shazam(wav_data)
    if result:
        result["recognized_by"] = "Shazam"
        return result

    # Fallback to AcoustID
    if ACOUSTID_API_KEY:
        result = await _try_acoustid(wav_data)
        if result:
            result["recognized_by"] = "AcoustID"
            return result

    return None


async def _try_shazam(wav_data: bytes) -> dict | None:
    """Try identifying with Shazam."""
    try:
        result = await _shazam.recognize(wav_data)
    except Exception:
        return None

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


async def _try_acoustid(wav_data: bytes) -> dict | None:
    """Try identifying with AcoustID + Chromaprint."""
    try:
        import acoustid
    except ImportError:
        return None

    try:
        # Write WAV to temp file for fpcalc
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav_data)
            tmp_path = f.name

        try:
            results = await asyncio.to_thread(
                acoustid.match, ACOUSTID_API_KEY, tmp_path
            )
            for score, recording_id, title, artist in results:
                if score > 0.5 and title:
                    return {
                        "name": title,
                        "artist": artist or "",
                        "album": "",
                        "image": "",
                        "shazam_url": "",
                        "spotify_url": "",
                        "genre": "",
                        "type": "track",
                        "acoustid_score": round(score, 2),
                        "musicbrainz_id": recording_id,
                    }
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception:
        return None

    return None
