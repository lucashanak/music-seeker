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

_bpm_cache: dict = {}

# 4 threads — C extensions (librosa/numpy FFT, essentia C++, madmom Cython)
# release the GIL, so threads give real parallelism with shared memory.
# 4 threads ≈ 1.5 GB total vs 16 subprocesses ≈ 10 GB.
_executor = ThreadPoolExecutor(max_workers=6)


def _load_cache() -> dict:
    if BPM_CACHE_FILE.exists():
        try:
            return json.loads(BPM_CACHE_FILE.read_text())
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
    del y_perc, onset_env, bt

    # ── 2. essentia (hopSize=256 → 2× faster) ──
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
        del audio_es
    except ImportError:
        pass

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

    return {"bpm": round(final_bpm, 1), "confidence": confidence, "raw": raw, "normalized": normalized}


# ── File tag read/write ──

def read_bpm_tag(file_path: str) -> int | None:
    try:
        if file_path.endswith(".flac"):
            from mutagen.flac import FLAC
            val = FLAC(file_path).get("BPM") or FLAC(file_path).get("bpm")
        elif file_path.endswith(".mp3"):
            from mutagen.easyid3 import EasyID3
            val = EasyID3(file_path).get("bpm")
        else:
            return None
        if val:
            return int(float(val[0]))
    except Exception:
        pass
    return None


def write_bpm_tag(file_path: str, bpm: int):
    try:
        if file_path.endswith(".flac"):
            from mutagen.flac import FLAC
            tags = FLAC(file_path)
            tags["BPM"] = str(bpm)
            tags.save()
        elif file_path.endswith(".mp3"):
            from mutagen.easyid3 import EasyID3
            try:
                tags = EasyID3(file_path)
            except Exception:
                tags = EasyID3()
                tags.filename = file_path
            tags["bpm"] = str(bpm)
            tags.save()
    except Exception as e:
        logger.error("Failed to write BPM tag to %s: %s", file_path, e)


def _analyze_or_read_tag(file_path: str) -> dict:
    """Check file tags first, then run full analysis."""
    existing = read_bpm_tag(file_path)
    if existing:
        return {"bpm": float(existing), "confidence": 1.0,
                "raw": {"tag": existing}, "normalized": {"tag": float(existing)}}
    result = analyze_bpm(file_path)
    write_bpm_tag(file_path, int(round(result["bpm"])))
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

async def analyze_track(song_id: str, name: str, artist: str,
                        force: bool = False) -> dict | None:
    key = _cache_key(name, artist)
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
