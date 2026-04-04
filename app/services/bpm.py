"""BPM analysis service — ensemble detection optimized for zouk music."""

import asyncio
import json
import logging
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import numpy as np

from app.services import library
from app.services.player import find_track_file

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
BPM_CACHE_FILE = DATA_DIR / "bpm_analysis.json"

ZOUK_MIN_BPM = 65
ZOUK_MAX_BPM = 110

CAMELOT_MAP = {
    "A minor": "8A", "E minor": "9A", "B minor": "10A", "F# minor": "11A",
    "Db minor": "12A", "Ab minor": "1A", "Eb minor": "2A", "Bb minor": "3A",
    "F minor": "4A", "C minor": "5A", "G minor": "6A", "D minor": "7A",
    "C major": "8B", "G major": "9B", "D major": "10B", "A major": "11B",
    "E major": "12B", "B major": "1B", "F# major": "2B", "Db major": "3B",
    "Ab major": "4B", "Eb major": "5B", "Bb major": "6B", "F major": "7B",
}

_bpm_cache: dict = {}

# 4 threads — C extensions (librosa/numpy FFT, essentia C++, madmom Cython)
# release the GIL, so threads give real parallelism with shared memory.
# 4 threads ≈ 1.5 GB total vs 16 subprocesses ≈ 10 GB.
_executor = ThreadPoolExecutor(max_workers=6)


def _load_cache() -> dict:
    if BPM_CACHE_FILE.exists():
        try:
            data = json.loads(BPM_CACHE_FILE.read_text())
            # Invalidate entries from older versions that lack beat_grid/outro_start
            return {k: v for k, v in data.items()
                    if isinstance(v, dict) and v.get("beat_grid") and v.get("outro_start") is not None}
        except Exception:
            pass
    return {}


def _save_cache():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BPM_CACHE_FILE.write_text(json.dumps(_bpm_cache, indent=2))


_bpm_cache = _load_cache()


def _cache_key(name: str, artist: str) -> str:
    return f"{artist.lower().strip()}::{name.lower().strip()}"


def normalize_bpm(bpm: float, min_bpm: float = ZOUK_MIN_BPM, max_bpm: float = ZOUK_MAX_BPM) -> float:
    while bpm > max_bpm: bpm /= 2
    while bpm < min_bpm: bpm *= 2
    return bpm


# ── Analysis (runs in thread, C extensions release GIL) ──

def analyze_bpm(file_path: str) -> dict:
    """Ensemble BPM analysis — loads audio ONCE, skips madmom if others agree."""
    import soundfile as sf
    import librosa

    # Load once at 44100Hz
    data_44k, sr = sf.read(file_path, dtype="float32")
    if sr != 44100:
        data_44k = librosa.resample(data_44k.T, orig_sr=sr, target_sr=44100).T
    if data_44k.ndim > 1:
        mono_44k = np.mean(data_44k, axis=1)
    else:
        mono_44k = data_44k

    # Skip first 30s (intro), analyze 60s of the body
    start = min(30 * 44100, len(mono_44k) // 3)
    end = start + 60 * 44100
    mono_44k_seg = mono_44k[start:end]
    data_44k_seg = data_44k[start:end] if data_44k.ndim > 1 else mono_44k_seg

    # Downsample for librosa
    mono_22k = librosa.resample(mono_44k_seg, orig_sr=44100, target_sr=22050)

    raw = {}

    # ── 1. librosa (hop_length=512 → 2× faster, minimal accuracy loss) ──
    HOP = 512
    _, y_perc = librosa.effects.hpss(mono_22k, margin=3.0)
    onset_env = librosa.onset.onset_strength(
        y=y_perc, sr=22050, hop_length=HOP,
        aggregate=np.median, fmax=8000, n_mels=80,
    )
    tempo = librosa.beat.tempo(
        onset_envelope=onset_env, sr=22050, hop_length=HOP,
        start_bpm=85, std_bpm=1.0, ac_size=8.0, max_tempo=150,
    )
    raw["librosa_tempo"] = round(float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo), 1)
    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=22050, hop_length=HOP,
        start_bpm=85, tightness=120,
    )
    bt = librosa.frames_to_time(beat_frames, sr=22050, hop_length=HOP)
    raw["librosa_beats"] = round(float(60.0 / np.median(np.diff(bt))), 1) if len(bt) > 1 else raw["librosa_tempo"]
    # Store beat positions (offset by segment start for absolute track time)
    seg_offset = start / 44100
    beat_positions = [round(float(t) + seg_offset, 3) for t in bt]
    del y_perc, onset_env, bt

    # ── 2. essentia (hopSize=256 → 2× faster) ──
    detected_key = None
    try:
        import essentia.standard as es
        audio_es = mono_44k_seg.astype(np.float32)
        raw["essentia_percival"] = round(float(es.PercivalBpmEstimator(
            frameSize=2048, hopSize=256, maxBPM=120, minBPM=55, sampleRate=44100,
        )(audio_es)), 1)
        rbpm, _, _, _, _ = es.RhythmExtractor2013(
            method="multifeature", maxTempo=120, minTempo=55,
        )(audio_es)
        raw["essentia_rhythm"] = round(float(rbpm), 1)
        # Key detection
        try:
            key_name, scale, strength = es.KeyExtractor()(audio_es)
            detected_key = f"{key_name} {scale}"
        except Exception as e:
            logger.warning("Key detection failed: %s", e)
            detected_key = None
        del audio_es
    except ImportError:
        detected_key = None

    # ── 3. madmom (RNN) — SKIP if essentia+librosa agree ±2 BPM ──
    run_madmom = True
    if "essentia_percival" in raw:
        n_lib = normalize_bpm(raw["librosa_tempo"])
        n_perc = normalize_bpm(raw["essentia_percival"])
        n_rhy = normalize_bpm(raw["essentia_rhythm"])
        if abs(n_lib - n_perc) <= 2 and abs(n_lib - n_rhy) <= 2:
            run_madmom = False

    if run_madmom:
        try:
            import madmom
            from madmom.audio.signal import Signal
            if data_44k_seg.ndim == 1:
                mm_data = data_44k_seg.reshape(-1, 1)
            else:
                mm_data = data_44k_seg
            signal = Signal(mm_data.astype(np.float32), sample_rate=44100)
            activation = madmom.features.beats.RNNBeatProcessor(
                num_threads=3,
            )(signal)
            beats = madmom.features.beats.DBNBeatTrackingProcessor(
                min_bpm=55, max_bpm=120, fps=100, transition_lambda=200,
            )(activation)
            if len(beats) >= 2:
                raw["madmom_rnn"] = round(float(60.0 / np.median(np.diff(beats))), 1)
            del signal, activation, beats
        except ImportError:
            pass

    # Track duration for beat grid (before freeing buffers)
    track_duration = len(mono_44k) / 44100

    # ── Full-track beat detection for intro/outro (lightweight, forced BPM) ──
    # Downsample full track to 22050 for librosa
    mono_22k_full = librosa.resample(mono_44k, orig_sr=44100, target_sr=22050)
    _, full_beat_frames = librosa.beat.beat_track(
        y=mono_22k_full, sr=22050, hop_length=HOP,
        bpm=raw.get("librosa_tempo", 85),  # forced BPM = skip tempo estimation, fast
        tightness=120,
    )
    full_beats = librosa.frames_to_time(full_beat_frames, sr=22050, hop_length=HOP).tolist()
    del mono_22k_full

    # Free audio buffers
    del data_44k, mono_44k, mono_44k_seg, data_44k_seg, mono_22k

    # ── Normalize + weighted median ──
    normalized = {k: round(normalize_bpm(v), 1) for k, v in raw.items()}
    weights = {
        "madmom_rnn": 4.0, "essentia_percival": 3.0, "essentia_rhythm": 2.0,
        "librosa_tempo": 1.5, "librosa_beats": 1.0,
    }
    pairs = sorted([(normalized[k], weights.get(k, 1.0)) for k in normalized], key=lambda x: x[0])
    cumw = np.cumsum([w for _, w in pairs])
    idx = int(np.searchsorted(cumw, cumw[-1] / 2))
    final_bpm = pairs[idx][0]

    values = list(normalized.values())
    std = float(np.std(values)) if len(values) > 1 else 0.0
    confidence = 0.95 if std < 1 else 0.85 if std < 2 else 0.70 if std < 4 else 0.50 if std < 8 else 0.30

    # ── Beat grid (quantized from final BPM, full track) ──
    beat_period = 60.0 / final_bpm
    # Use first full-track beat as anchor (not segment offset)
    anchor = full_beats[0] if full_beats else 0
    beat_grid = [round(anchor + i * beat_period, 3)
                 for i in range(int((track_duration - anchor) / beat_period) + 1)]

    # ── Intro detection: first beat in the track ──
    intro_end = round(full_beats[0], 3) if full_beats else 0

    # ── Outro detection: scan full-track beats from end ──
    outro_start = track_duration
    if len(full_beats) > 8:
        for i in range(len(full_beats) - 1, 0, -1):
            gap = full_beats[i] - full_beats[i - 1]
            if gap > beat_period * 1.5:
                outro_start = round(full_beats[i - 1], 3)
                break

    # ── Key / Camelot ──
    camelot = CAMELOT_MAP.get(detected_key) if detected_key else None

    return {
        "bpm": round(final_bpm, 1), "confidence": confidence,
        "raw": raw, "normalized": normalized,
        "beat_positions": beat_positions,
        "beat_grid": beat_grid,
        "key": detected_key,
        "camelot": camelot,
        "intro_end": intro_end,
        "outro_start": outro_start,
    }


# ── File tag read/write ──

def _open_tags(file_path: str):
    """Open mutagen tags for reading/writing. Returns (tags, format) or (None, None)."""
    try:
        if file_path.endswith(".flac"):
            from mutagen.flac import FLAC
            return FLAC(file_path), "flac"
        elif file_path.endswith(".mp3"):
            from mutagen.easyid3 import EasyID3
            try:
                return EasyID3(file_path), "mp3"
            except Exception:
                tags = EasyID3()
                tags.filename = file_path
                return tags, "mp3"
    except Exception:
        pass
    return None, None


def read_bpm_tag(file_path: str) -> int | None:
    tags, _ = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("BPM") or tags.get("bpm")
    if val:
        try:
            return int(float(val[0]))
        except Exception:
            pass
    return None


def read_key_tag(file_path: str) -> str | None:
    """Read musical key from INITIALKEY/KEY tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    if fmt == "flac":
        val = tags.get("INITIALKEY") or tags.get("KEY") or tags.get("key")
    else:
        # EasyID3 doesn't map TKEY by default, try raw
        val = tags.get("initialkey") or tags.get("key")
    if val:
        return val[0]
    return None


def read_anchor_tag(file_path: str) -> float | None:
    """Read beat anchor (time of first beat in seconds) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("BEAT_ANCHOR") or tags.get("beat_anchor")
    if val:
        try:
            return float(val[0])
        except Exception:
            pass
    return None


def read_intro_tag(file_path: str) -> float | None:
    """Read intro end time (first beat) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("INTRO_END") or tags.get("intro_end")
    if val:
        try:
            return float(val[0])
        except Exception:
            pass
    return None


def read_outro_tag(file_path: str) -> float | None:
    """Read outro start time (seconds) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("OUTRO_START") or tags.get("outro_start")
    if val:
        try:
            return float(val[0])
        except Exception:
            pass
    return None


def write_tags(file_path: str, bpm: int = None, key: str = None,
               beat_anchor: float = None, intro_end: float = None,
               outro_start: float = None):
    """Write BPM, key, beat anchor, intro end, and outro start to file tags."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return
    try:
        if bpm is not None:
            if fmt == "flac":
                tags["BPM"] = str(bpm)
            else:
                tags["bpm"] = str(bpm)
        if key is not None:
            if fmt == "flac":
                tags["INITIALKEY"] = key
            else:
                from mutagen.easyid3 import EasyID3
                if "initialkey" not in EasyID3.valid_keys:
                    from mutagen.id3 import TKEY
                    EasyID3.RegisterTextKey("initialkey", "TKEY")
                tags["initialkey"] = key
        if beat_anchor is not None:
            if fmt == "flac":
                tags["BEAT_ANCHOR"] = str(round(beat_anchor, 3))
            else:
                # MP3: store in TXXX custom frame
                from mutagen.easyid3 import EasyID3
                if "beat_anchor" not in EasyID3.valid_keys:
                    from mutagen.id3 import TXXX
                    EasyID3.RegisterTXXXKey("beat_anchor", "BEAT_ANCHOR")
                tags["beat_anchor"] = str(round(beat_anchor, 3))
        for tag_name, value in [("INTRO_END", intro_end), ("OUTRO_START", outro_start)]:
            if value is not None:
                if fmt == "flac":
                    tags[tag_name] = str(round(value, 3))
                else:
                    from mutagen.easyid3 import EasyID3
                    lk = tag_name.lower()
                    if lk not in EasyID3.valid_keys:
                        from mutagen.id3 import TXXX
                        EasyID3.RegisterTXXXKey(lk, tag_name)
                    tags[lk] = str(round(value, 3))
        tags.save()
    except Exception as e:
        logger.error("Failed to write tags to %s: %s", file_path, e)


def _reconstruct_beat_grid(bpm: float, anchor: float, file_path: str) -> tuple[list, float]:
    """Reconstruct beat grid from BPM + anchor. Returns (beat_grid, duration)."""
    try:
        import soundfile as sf
        info = sf.info(file_path)
        duration = info.duration
    except Exception:
        duration = 300  # fallback 5 min
    beat_period = 60.0 / bpm
    grid = [round(anchor + i * beat_period, 3)
            for i in range(int((duration - anchor) / beat_period) + 1)]
    return grid, duration


def _analyze_or_read_tag(file_path: str) -> dict:
    """Check file tags first, run full analysis if any tag missing."""
    existing_bpm = read_bpm_tag(file_path)
    existing_key = read_key_tag(file_path)
    existing_anchor = read_anchor_tag(file_path)
    existing_intro = read_intro_tag(file_path)
    existing_outro = read_outro_tag(file_path)

    if (existing_bpm and existing_key and existing_anchor is not None
            and existing_intro is not None and existing_outro is not None):
        # All tags present — reconstruct everything from tags (fast path)
        bpm = float(existing_bpm)
        camelot = CAMELOT_MAP.get(existing_key)
        beat_grid, track_duration = _reconstruct_beat_grid(bpm, existing_anchor, file_path)
        return {
            "bpm": bpm, "confidence": 1.0,
            "raw": {"tag_bpm": existing_bpm, "tag_key": existing_key},
            "normalized": {"tag": bpm},
            "key": existing_key, "camelot": camelot,
            "beat_positions": beat_grid, "beat_grid": beat_grid,
            "intro_end": existing_intro,
            "outro_start": existing_outro,
        }

    # Need full analysis (missing tag(s))
    result = analyze_bpm(file_path)
    # Write all tags
    anchor = result.get("beat_positions", [None])[0]
    write_tags(file_path,
               bpm=int(round(result["bpm"])),
               key=result.get("key"),
               beat_anchor=anchor,
               intro_end=result.get("intro_end"),
               outro_start=result.get("outro_start"))
    return result


# ── Audio file access ──

async def _get_audio_file(song_id: str, name: str, artist: str) -> str | None:
    local = find_track_file(name, artist)
    if local:
        return local

    if not library.NAVIDROME_PASSWORD or not song_id:
        return None

    cache_dir = os.path.join(tempfile.gettempdir(), "ms-bpm-cache")
    os.makedirs(cache_dir, exist_ok=True)
    cache_path = os.path.join(cache_dir, f"{song_id}.flac")

    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path

    params = library._params(id=song_id)
    url = f"{library.NAVIDROME_URL}/rest/stream"
    try:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            async with client.stream("GET", url, params=params) as resp:
                resp.raise_for_status()
                with open(cache_path + ".tmp", "wb") as f:
                    async for chunk in resp.aiter_bytes(8192):
                        f.write(chunk)
        os.rename(cache_path + ".tmp", cache_path)
        return cache_path
    except Exception as e:
        logger.error("Failed to stream from Navidrome for BPM analysis: %s", e)
        for p in (cache_path + ".tmp", cache_path):
            if os.path.exists(p):
                os.unlink(p)
        return None


# ── Public API ──

# Per-track locks to prevent duplicate concurrent analysis (#10 fix)
_analysis_locks: dict[str, asyncio.Lock] = {}


async def analyze_track(song_id: str, name: str, artist: str,
                        force: bool = False) -> dict | None:
    key = _cache_key(name, artist)
    if not force and key in _bpm_cache:
        return _bpm_cache[key]

    # Per-track lock: only one analysis at a time per track
    if key not in _analysis_locks:
        _analysis_locks[key] = asyncio.Lock()
    async with _analysis_locks[key]:
        # Re-check cache after acquiring lock (another request may have finished)
        if not force and key in _bpm_cache:
            return _bpm_cache[key]

        file_path = await _get_audio_file(song_id, name, artist)
        if not file_path:
            return None

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_executor, _analyze_or_read_tag, file_path)
        result["name"] = name
        result["artist"] = artist
        _bpm_cache[key] = result
        _save_cache()
        return result


async def analyze_playlist(playlist_id: str, force: bool = False,
                           limit: int = 0, on_progress=None) -> list[dict]:
    pl = await library.get_playlist(playlist_id)
    if not pl:
        return []

    cached_results = {}
    to_analyze = []
    for track in pl["tracks"]:
        c = get_cached_bpm(track["name"], track["artist"])
        if c and not force:
            cached_results[_cache_key(track["name"], track["artist"])] = c
        else:
            to_analyze.append(track)

    if limit:
        to_analyze = to_analyze[:limit]

    # Download + analyze (thread pool handles concurrency, max 4 parallel)
    async def _do_one(track):
        fp = await _get_audio_file(track["id"], track["name"], track["artist"])
        if not fp:
            return
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_executor, _analyze_or_read_tag, fp)
        result["name"] = track["name"]
        result["artist"] = track["artist"]
        key = _cache_key(track["name"], track["artist"])
        _bpm_cache[key] = result
        cached_results[key] = result

    await asyncio.gather(*[_do_one(t) for t in to_analyze], return_exceptions=True)
    _save_cache()

    results = []
    for track in pl["tracks"]:
        key = _cache_key(track["name"], track["artist"])
        if key in cached_results:
            results.append(cached_results[key])
    return results


def get_cached_bpm(name: str, artist: str) -> dict | None:
    return _bpm_cache.get(_cache_key(name, artist))


def get_all_cached() -> dict:
    return dict(_bpm_cache)


async def analyze_and_tag(file_path: str, name: str, artist: str) -> dict | None:
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(_executor, _analyze_or_read_tag, file_path)
    result["name"] = name
    result["artist"] = artist
    _bpm_cache[_cache_key(name, artist)] = result
    _save_cache()
    return result
