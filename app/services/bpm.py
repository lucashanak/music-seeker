"""BPM analysis service — ensemble detection optimized for zouk music."""

import asyncio
import ctypes
import ctypes.util
import gc
import json
import logging
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import numpy as np

from app.services import library
from app.services.player import find_track_file, evict_cache_dir, BPM_CACHE_MAX_BYTES, cache_navidrome_stream

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
BPM_CACHE_FILE = DATA_DIR / "bpm_analysis.json"

ZOUK_MIN_BPM = 60       # fold window spans exactly one octave (60–120 = 2×) → no dead zone
ZOUK_MAX_BPM = 120
BPM_ALGO_VERSION = 5    # bump to invalidate cached/tagged BPM when the algorithm changes
FEATURE_VERSION = 1     # bump to lazily backfill audio features (energy/danceability/…) — NEVER triggers a BPM re-scan

# ── Audio-feature normalization anchors (fixed references → reproducible 0..1, NOT dataset-relative) ──
# All calibratable later; chosen to map typical music into a useful 0..1 spread.
DBFS_FLOOR = -36        # RMS dBFS mapped to energy_loud=0
DBFS_CEIL = -6          # RMS dBFS mapped to energy_loud=1
BRIGHTNESS_REF_HZ = 4000  # spectral-centroid Hz mapped to brightness=1
PULSE_REF = 4.0         # onset-strength magnitude mapped to danceability=1 (calibratable)


def clamp01(x: float) -> float:
    """Clamp a value into [0, 1] (NaN/None → 0.5 neutral)."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.5
    if v != v:  # NaN
        return 0.5
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v

# Dance-band fold center: zouk is danced ~82 BPM (half-time). Env-overridable.
_DANCE_CENTER = float(os.environ.get("BPM_DANCE_CENTER", "82"))
# Number of evenly-spaced analysis windows across the track body.
_BPM_SEGMENTS = int(os.environ.get("BPM_SEGMENTS", "5"))

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
_executor = ThreadPoolExecutor(max_workers=int(os.environ.get("BPM_WORKERS", "2")))


# ── Native-memory reclaim ────────────────────────────────────────────────────
# librosa/essentia/madmom/numpy allocate large native buffers per analysis. glibc
# keeps freed pages in per-thread arenas instead of returning them to the OS, so
# RSS ratchets up over many analyses and never comes down — this drove the uvicorn
# OOM. After each analysis we force gc + malloc_trim(0) to hand the pages back;
# MALLOC_ARENA_MAX=2 (container env) caps arena fragmentation. If insufficient,
# escalate to a recycling ProcessPoolExecutor (native heap dies with the worker).
try:
    _libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
except Exception:
    _libc = None


def _trim_memory():
    try:
        gc.collect()
        if _libc is not None:
            _libc.malloc_trim(0)
    except Exception:
        pass


async def _run_in_pool(fn, *args):
    """Run a heavy analysis fn in the thread pool, then reclaim native memory."""
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(_executor, fn, *args)
    finally:
        _trim_memory()


def _load_cache() -> dict:
    if BPM_CACHE_FILE.exists():
        try:
            data = json.loads(BPM_CACHE_FILE.read_text())
            # Invalidate entries from older versions that lack beat_grid/outro_start
            return {k: v for k, v in data.items()
                    if isinstance(v, dict) and v.get("beat_grid") and v.get("outro_start") is not None
                    and v.get("algo_version") == BPM_ALGO_VERSION}
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
    """Dance-aware octave fold. Brings a detected tempo into a sane octave window, then
    folds into ONE clean octave centered (geometrically) on the zouk dance center — a
    STRICT MONOTONE fold (no dead zone, no per-value octave flips) so tracks stay
    comparable/sortable. The band follows BPM_DANCE_CENTER: everything lands in
    [center/√2, center·√2). Lower the center to shift the whole scale toward the
    half-time pulse zouk is danced to. Keeps the original name+signature."""
    if bpm <= 0:
        return bpm
    lo = _DANCE_CENTER / 1.4142135623730951  # center / √2
    hi = lo * 2.0
    while bpm >= hi: bpm /= 2
    while bpm < lo: bpm *= 2
    return round(bpm, 2)


# Octave bounds for snap-to-prior search (well outside the dance band so a doubled
# detector reading is reachable without saturating at any cap).
_SNAP_MIN_BPM = 30.0
_SNAP_MAX_BPM = 240.0


def snap_to_prior(bpm: float, prior: float = _DANCE_CENTER) -> float:
    """Deterministically snap a detected tempo to the octave multiple (÷4…×4, kept inside
    [30, 240]) that minimizes log-distance to the zouk dance prior (~82 BPM).

    This REPLACES the per-detector seam fold used to compute confidence agreement. The
    seam fold (`normalize_bpm`) folds into a single octave around a hard boundary, so a
    detector that doubles to ~160 (or saturates at a 120 cap) lands on the far side of
    the seam from honest ~80 detectors → a manufactured ~20 BPM disagreement. Snapping to
    the prior instead places every candidate on the SAME octave as the prior, so
    cap-collision and seam-straddle stop fabricating disagreement.

    Anchor-safety: for any single value the snap is monotone toward the prior octave, so a
    value already in the prior's octave is unchanged; a clean single cluster therefore
    keeps its BPM (verified: 0 flips on clean clusters)."""
    if bpm <= 0 or prior <= 0:
        return bpm
    best = None
    best_dist = None
    # Octave multiples ÷4, ÷2, ×1, ×2, ×4.
    for mult in (0.25, 0.5, 1.0, 2.0, 4.0):
        cand = bpm * mult
        if cand < _SNAP_MIN_BPM or cand > _SNAP_MAX_BPM:
            continue
        dist = abs(np.log2(cand / prior))
        if best_dist is None or dist < best_dist:
            best_dist = dist
            best = cand
    if best is None:
        return round(float(bpm), 2)
    return round(float(best), 2)


def _grid_regularity(beat_times) -> float:
    """Grid-regularity gate: 1.0 when the beat grid is metronomic (inter-beat-interval
    coefficient of variation < 2%), scaling down toward 0 for irregular grids. Multiplies
    into the confidence score so genuinely irregular tracks cannot earn false-high
    confidence. Returns 1.0 (neutral) when there are too few beats to judge."""
    try:
        if beat_times is None or len(beat_times) < 4:
            return 1.0
        ibis = np.diff(np.asarray(beat_times, dtype=float))
        ibis = ibis[ibis > 0]
        if len(ibis) < 3:
            return 1.0
        # CRITICAL: beat_times here is intro (0-30s) + outro (last 60s) beats concatenated,
        # so there is a HUGE gap interval between the two segments (the whole song body).
        # Raw-diff CV would be dominated by that single gap (and by dropped-beat double
        # intervals) → CV blows up → grid_reg floors at 0.3 for EVERY track. Keep only IBIs
        # near the median beat period (±50%) so CV reflects within-segment metronome
        # steadiness, not the segment boundary.
        med = float(np.median(ibis))
        if med <= 0:
            return 1.0
        near = ibis[(ibis >= 0.5 * med) & (ibis <= 1.5 * med)]
        if len(near) < 3:
            return 1.0
        mean_ibi = float(np.mean(near))
        if mean_ibi <= 0:
            return 1.0
        cv = float(np.std(near)) / mean_ibi
        if cv < 0.02:
            return 1.0
        # Linear roll-off: CV 2% → 1.0, CV 12% → 0.5, CV ≥ 22% → 0.3 floor.
        reg = 1.0 - (cv - 0.02) * 5.0
        return float(max(0.3, min(1.0, reg)))
    except Exception:
        return 1.0


# ── Integrated loudness (LUFS) for cross-track level matching ──

def _compute_lufs(data_44k_seg):
    """Integrated loudness (LUFS) + loudness range (LU) for an already-loaded 44.1kHz
    window, via essentia LoudnessEBUR128 (pyloudnorm is absent). Accepts mono or stereo:
    mono is duplicated to 2ch (EBU R128 expects interleaved stereo float32). Deterministic.
    Fully graceful: any failure → last-resort K-weighted-ish RMS approximation, then
    (None, None) if even that fails. Never aborts BPM.

    Returns (integrated_lufs, loudness_range) rounded to 1 decimal, or (None, None)."""
    try:
        seg = np.asarray(data_44k_seg, dtype=np.float32)
        if seg.size == 0:
            return None, None
        if seg.ndim == 1:
            stereo = np.column_stack([seg, seg]).astype(np.float32)
        else:
            # Use first two channels; duplicate if only one present.
            if seg.shape[1] >= 2:
                stereo = seg[:, :2].astype(np.float32)
            else:
                col = seg[:, 0]
                stereo = np.column_stack([col, col]).astype(np.float32)
        stereo = np.ascontiguousarray(stereo, dtype=np.float32)
        try:
            import essentia.standard as es
            # LoudnessEBUR128 returns (momentary, shortTerm, integrated, loudnessRange).
            _mom, _short, integrated, lrange = es.LoudnessEBUR128(sampleRate=44100)(stereo)
            return round(float(integrated), 1), round(float(lrange), 1)
        except Exception as e:
            logger.warning("LoudnessEBUR128 failed, using RMS approximation: %s", e)
            # Last-resort approximation: simple un-gated RMS in LUFS-like units.
            mono = np.mean(stereo, axis=1)
            ms = float(np.mean(np.square(mono)))
            if ms <= 0:
                return None, None
            approx = -0.691 + 10.0 * np.log10(ms)
            return round(float(approx), 1), None
    except Exception as e:
        logger.warning("LUFS computation failed: %s", e)
        return None, None


# ── Analysis (runs in thread, C extensions release GIL) ──

def _window_features(mono_44k_seg, onset_env, sr: int = 44100) -> dict:
    """Per-window raw audio features computed on the ALREADY-loaded segment (no extra
    file reads, no extra heavy DSP). `onset_env` is reused as-is (never recomputed).
    Returns raw (un-normalized) values: {rms, centroid_hz, pulse}."""
    import librosa
    rms = float(np.mean(librosa.feature.rms(y=mono_44k_seg)))
    centroid_hz = float(np.mean(librosa.feature.spectral_centroid(y=mono_44k_seg, sr=sr)))
    pulse = float(np.mean(onset_env))
    return {"rms": rms, "centroid_hz": centroid_hz, "pulse": pulse}


def _read_window(file_path: str, start_sec: float, len_sec: float):
    """Read ONLY one window of audio (never the whole track), resampled to 44100Hz.
    Returns (mono_44k, data_44k) where data_44k preserves channels."""
    import soundfile as sf
    import librosa
    info = sf.info(file_path)
    sr = info.samplerate
    data, _ = sf.read(file_path, start=int(start_sec * sr),
                      frames=int(len_sec * sr), dtype="float32")
    if sr != 44100:
        if data.ndim > 1:
            data = librosa.resample(data.T, orig_sr=sr, target_sr=44100).T
        else:
            data = librosa.resample(data, orig_sr=sr, target_sr=44100)
    if data.ndim > 1:
        mono = np.mean(data, axis=1)
    else:
        mono = data
    return mono, data


def _detect_window(mono_44k_seg, data_44k_seg, want_key: bool, want_madmom: bool = False):
    """Run the librosa + essentia (+ optional madmom) detectors on a single window.
    `want_key` is retained for signature compatibility but KEY IS NOW DETECTED ON EVERY
    WINDOW (~0.16s/window) for multi-window voting.
    Returns (raw_values_dict, beat_positions_rel, detected_key_or_None, key_strength_or_None,
    features_dict, downbeats_rel_or_None, time_signature_or_None). Downbeats/time_signature
    are populated only on the mid (`want_madmom`) window; (None, None) otherwise."""
    import librosa
    raw = {}
    features = None
    key_strength = None
    downbeats_rel = None
    time_signature = None

    # ── librosa (hop_length=512 → 2× faster, minimal accuracy loss) ──
    HOP = 512
    mono_22k = librosa.resample(mono_44k_seg, orig_sr=44100, target_sr=22050)
    _, y_perc = librosa.effects.hpss(mono_22k, margin=3.0)
    onset_env = librosa.onset.onset_strength(
        y=y_perc, sr=22050, hop_length=HOP,
        aggregate=np.median, fmax=8000, n_mels=80,
    )
    tempo = librosa.beat.tempo(
        onset_envelope=onset_env, sr=22050, hop_length=HOP,
        start_bpm=85, std_bpm=1.0, ac_size=8.0, max_tempo=120,
    )
    raw["librosa_tempo"] = round(float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo), 1)
    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=22050, hop_length=HOP,
        start_bpm=85, tightness=120,
    )
    bt = librosa.frames_to_time(beat_frames, sr=22050, hop_length=HOP)
    raw["librosa_beats"] = round(float(60.0 / np.median(np.diff(bt))), 1) if len(bt) > 1 else raw["librosa_tempo"]
    beat_positions_rel = [round(float(t), 3) for t in bt]
    # Per-window audio features — reuse the already-computed onset_env (additive, never
    # allowed to break BPM detection).
    try:
        features = _window_features(mono_44k_seg, onset_env, sr=44100)
    except Exception as e:
        logger.warning("Feature extraction failed: %s", e)
        features = None
    del y_perc, onset_env, bt, mono_22k

    # ── essentia (hopSize=256 → 2× faster) ──
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
        # KEY on EVERY window (~0.16s) → multi-window modal voting + real key_confidence.
        try:
            key_name, scale, strength = es.KeyExtractor()(audio_es)
            detected_key = f"{key_name} {scale}"
            key_strength = float(strength)
        except Exception as e:
            logger.warning("Key detection failed: %s", e)
            detected_key = None
        del audio_es
    except ImportError:
        detected_key = None

    # ── madmom RNN downbeat tracker (5th detector + downbeats/bars) ──
    # SINGLE RNN pass on the mid window only (want_madmom). The DBNDownBeatTrackingProcessor
    # emits an Nx2 array of (time, position-in-bar) covering EVERY beat, so the 5th-detector
    # beat-BPM ("madmom_rnn") is DERIVED from all beat times here — no separate RNNBeat+DBNBeat
    # pass is needed (saves ≈5.7s/track). Downbeats are rows where pos==1; time signature is
    # the modal bar length (beats between successive downbeats). Deterministic given fixed
    # input (no RNG). Absence/empty output degrades gracefully → no madmom_rnn vote (the other
    # 4 detectors carry) and (downbeats, time_signature) = (None, None). Never aborts.
    if want_madmom:
        try:
            import madmom
            from madmom.audio.signal import Signal as _DBSignal

            db_signal = _DBSignal(mono_44k_seg.astype(np.float32), sample_rate=44100)
            db_rnn = madmom.features.downbeats.RNNDownBeatProcessor()
            db_act = db_rnn(db_signal)
            db_proc = madmom.features.downbeats.DBNDownBeatTrackingProcessor(
                beats_per_bar=[4, 3], fps=100, min_bpm=55, max_bpm=120,
            )
            db_beats = db_proc(db_act)  # shape (N, 2): [time, beat_pos_in_bar]
            if db_beats is not None and len(db_beats) > 1:
                # 5th-detector beat-BPM derived from ALL beats (every row is a beat).
                all_beat_times = [t for t, pos in db_beats]
                if len(all_beat_times) > 1:
                    raw["madmom_rnn"] = round(
                        float(60.0 / np.median(np.diff(all_beat_times))), 1)
                # Downbeats (pos==1) + modal-bar-length time signature.
                dbs = [round(float(t), 3) for t, pos in db_beats if int(round(pos)) == 1]
                if len(dbs) >= 2:
                    downbeats_rel = dbs
                    # Modal bar length = beats between consecutive downbeats.
                    bar_lengths = []
                    db_idx = [i for i, (_, pos) in enumerate(db_beats)
                              if int(round(pos)) == 1]
                    for a, b in zip(db_idx, db_idx[1:]):
                        bar_lengths.append(b - a)
                    if bar_lengths:
                        ts = max(set(bar_lengths), key=bar_lengths.count)
                        if ts in (3, 4):
                            time_signature = ts
        except ImportError:
            pass
        except Exception as e:
            logger.warning("madmom downbeat tracking failed: %s", e)

    return (raw, beat_positions_rel, detected_key, key_strength, features,
            downbeats_rel, time_signature)


def analyze_bpm(file_path: str) -> dict:
    """Multi-segment ensemble BPM analysis — memory efficient (windowed reads only,
    never loads the whole track), with two-level cross-segment confidence
    (within-window detector agreement + cross-segment agreement)."""
    import soundfile as sf

    info = sf.info(file_path)
    track_duration = float(info.duration)

    # ── Plan windows: N windows of 45s evenly spaced across 10%–85% of the body.
    WIN_LEN = 45.0
    if track_duration < 90:
        starts = [0.0]  # very short track: single window at start
    else:
        body_start = 0.10 * track_duration
        body_end = 0.85 * track_duration
        n = max(1, _BPM_SEGMENTS)
        if n == 1:
            starts = [body_start]
        else:
            span = body_end - body_start
            step = span / (n - 1)
            starts = [body_start + i * step for i in range(n)]
        # Clamp so each window fits inside the track.
        max_start = max(0.0, track_duration - WIN_LEN)
        starts = [min(s, max_start) for s in starts]
        # Drop near-duplicate windows (short tracks clamp several starts together).
        dedup = []
        for s in starts:
            if not any(abs(s - d) < WIN_LEN / 2 for d in dedup):
                dedup.append(s)
        starts = dedup

    weights = {
        "madmom_rnn": 4.0,
        "essentia_percival": 3.0, "essentia_rhythm": 2.0,
        "librosa_tempo": 1.5, "librosa_beats": 1.0,
    }

    mid_idx = len(starts) // 2
    raw = {}
    detected_key = None
    key_strength = None           # mean essentia strength of windows voting the modal key
    beat_positions = []           # absolute beat times from the first window
    per_window_folded = []        # list of dicts {detector: folded_bpm} (seam-fold, for final value)
    per_window_snapped = []       # list of dicts {detector: snapped_bpm} (prior-snap, for confidence)
    per_window_features = []      # list of {rms, centroid_hz, pulse} raw feature dicts
    per_window_keys = []          # (key, strength) per window (for modal key voting)
    mid_downbeats_rel = None      # mid-window-relative downbeat times (madmom)
    mid_downbeat_offset = 0.0     # absolute offset of the mid window
    time_signature = None         # inferred from modal bar length (4/3/None)
    lufs_stereo_seg = None        # an already-loaded stereo (or mono) window for LUFS

    for wi, s in enumerate(starts):
        try:
            mono_seg, data_seg = _read_window(file_path, s, WIN_LEN)
            if len(mono_seg) == 0:
                del mono_seg, data_seg
                continue
            want_key = (wi == mid_idx)
            want_madmom = (wi == mid_idx)  # madmom is CPU-heavy → one mid window only
            (win_raw, bt_rel, win_key, win_key_strength, win_features,
             win_downbeats, win_ts) = _detect_window(
                mono_seg, data_seg, want_key, want_madmom)
            # Capture one already-loaded window for LUFS (prefer the stereo mid window).
            if lufs_stereo_seg is None or wi == mid_idx:
                lufs_stereo_seg = np.array(data_seg, copy=True)
            del mono_seg, data_seg
        except Exception as e:
            # One bad window must not abort the whole analysis (we run N of them).
            logger.warning("BPM window %d failed: %s", wi, e)
            continue
        if win_features:
            per_window_features.append(win_features)
        if win_key:
            per_window_keys.append((win_key, win_key_strength))
        # Mid-window downbeats / time signature (relative → absolutized later).
        if wi == mid_idx and win_downbeats:
            mid_downbeats_rel = win_downbeats
            mid_downbeat_offset = s
            time_signature = win_ts
        # First window's beats become the absolute beat_positions / anchor source.
        if wi == 0:
            beat_positions = [round(t + s, 3) for t in bt_rel]
        # Merge raw values with window-index suffix for debugging.
        for k, v in win_raw.items():
            raw[f"{k}_{wi}"] = v
        # Fold this window's detector values (seam fold → final sortable value).
        folded = {k: round(normalize_bpm(v), 2) for k, v in win_raw.items()}
        per_window_folded.append(folded)
        # Snap to prior octave (no seam) → agreement basis for confidence.
        snapped = {k: snap_to_prior(v) for k, v in win_raw.items()}
        per_window_snapped.append(snapped)

    # ── Beat detection for intro/outro (windowed, never whole track) ──
    import librosa
    HOP = 512
    sr22 = 22050
    forced_bpm = raw.get("librosa_tempo_0", 85)
    # Intro: first 30s — a corrupt intro region must not abort the whole analysis.
    intro_beats = []
    try:
        intro_len = min(30.0, track_duration)
        intro_mono, _ = _read_window(file_path, 0.0, intro_len)
        intro_22k = librosa.resample(intro_mono, orig_sr=44100, target_sr=sr22)
        _, intro_frames = librosa.beat.beat_track(y=intro_22k, sr=sr22, hop_length=HOP, bpm=forced_bpm, tightness=120)
        intro_beats = librosa.frames_to_time(intro_frames, sr=sr22, hop_length=HOP).tolist()
        del intro_22k, intro_mono
    except Exception as e:
        logger.warning("BPM intro beat read failed: %s", e)
    # Outro: last 60s — a corrupt outro region must not abort the whole analysis.
    outro_beats = []
    try:
        outro_offset = max(0.0, track_duration - 60.0)
        outro_mono, _ = _read_window(file_path, outro_offset, track_duration - outro_offset)
        outro_22k = librosa.resample(outro_mono, orig_sr=44100, target_sr=sr22)
        _, outro_frames = librosa.beat.beat_track(y=outro_22k, sr=sr22, hop_length=HOP, bpm=forced_bpm, tightness=120)
        outro_beats = [round(t + outro_offset, 3) for t in librosa.frames_to_time(outro_frames, sr=sr22, hop_length=HOP).tolist()]
        del outro_22k, outro_mono
    except Exception as e:
        logger.warning("BPM outro beat read failed: %s", e)
    full_beats = sorted(set(intro_beats + outro_beats))

    # ── Weighted median over ALL (window × detector) folded values ──
    all_pairs = []
    for folded in per_window_folded:
        for k, v in folded.items():
            all_pairs.append((v, weights.get(k, 1.0)))
    all_pairs.sort(key=lambda x: x[0])
    if all_pairs:
        cumw = np.cumsum([w for _, w in all_pairs])
        idx = int(np.searchsorted(cumw, cumw[-1] / 2))
        final_bpm = all_pairs[idx][0]
    else:
        final_bpm = round(normalize_bpm(forced_bpm), 2)
    if not final_bpm or final_bpm <= 0:
        final_bpm = round(normalize_bpm(85), 2)  # floor — never let beat_period divide by 0

    # ── Agreement-ratio confidence (prior-snapped values) × grid-regularity gate ──
    # Pool ALL (window × detector) values, snapped to the prior octave so the seam can no
    # longer manufacture disagreement. A weighted median anchors the cluster; agree_ratio
    # is the fraction (by weight) of values within ±4% of that median. One outlier among
    # 4–5 detectors now costs at most ~one bucket instead of slamming the 0.30 floor.
    snap_pairs = []
    for snapped in per_window_snapped:
        for k, v in snapped.items():
            snap_pairs.append((v, weights.get(k, 1.0)))
    if snap_pairs:
        sp_sorted = sorted(snap_pairs, key=lambda x: x[0])
        sp_cumw = np.cumsum([w for _, w in sp_sorted])
        sp_idx = int(np.searchsorted(sp_cumw, sp_cumw[-1] / 2))
        wmedian = sp_sorted[sp_idx][0]
        total_w = float(sum(w for _, w in snap_pairs))
        agree_w = float(sum(w for v, w in snap_pairs
                            if wmedian > 0 and abs(v - wmedian) / wmedian <= 0.04))
        agree_ratio = agree_w / total_w if total_w > 0 else 0.0
    else:
        agree_ratio = 0.0

    # ── Grid-regularity gate (P4): caps confidence when the beat grid is irregular ──
    grid_reg = _grid_regularity(full_beats)

    score = agree_ratio * grid_reg
    confidence = (0.95 if score >= 0.95 else 0.85 if score >= 0.80
                  else 0.70 if score >= 0.65 else 0.50 if score >= 0.50 else 0.30)

    # (Downbeat tie-break intentionally omitted: with single-octave band folding every
    # value already collapses into the same octave, so a downbeat estimate cannot
    # disambiguate the metrical level — the cross-segment confidence above is the
    # uncertainty signal instead, and it flags tracks where segments genuinely disagree.)

    # Merge per-window folded values into one normalized dict (suffixed keys).
    normalized = {}
    for wi, folded in enumerate(per_window_folded):
        for k, v in folded.items():
            normalized[f"{k}_{wi}"] = v

    # ── Beat grid (quantized from final BPM, full track) ──
    beat_period = 60.0 / final_bpm
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
                candidate = round(full_beats[i - 1], 3)
                if candidate > track_duration * 0.5:
                    outro_start = candidate
                break

    # ── Multi-window KEY voting + real key_confidence ──
    # Modal key across all windows that returned one; key_confidence = agreement fraction ×
    # mean strength of the windows that voted the modal key. Same field names as before
    # (key, camelot, key_confidence) → frontend unchanged. Graceful fallback to 0.5.
    from collections import Counter
    if per_window_keys:
        n_windows = len(per_window_keys)
        key_counts = Counter(k for k, _ in per_window_keys)
        modal_key, modal_count = key_counts.most_common(1)[0]
        agree_frac = modal_count / n_windows
        modal_strengths = [s for k, s in per_window_keys
                           if k == modal_key and s is not None]
        mean_strength = float(np.mean(modal_strengths)) if modal_strengths else 0.5
        detected_key = modal_key
        key_strength = mean_strength
        key_confidence_value = clamp01(agree_frac * mean_strength)
    else:
        detected_key = None
        key_strength = None
        key_confidence_value = 0.5

    # ── Key / Camelot ──
    camelot = CAMELOT_MAP.get(detected_key) if detected_key else None

    # ── Downbeats: absolutize mid-window downbeats, then extrapolate a full-track grid ──
    # (mirror the beat_grid reconstruction): bar_period = beat_period × (time_signature or 4),
    # first downbeat anchors the grid. Graceful: empty list when madmom produced nothing.
    downbeats = []
    if mid_downbeats_rel:
        abs_downbeats = [round(t + mid_downbeat_offset, 3) for t in mid_downbeats_rel]
        first_db = abs_downbeats[0]
        bar_period = beat_period * (time_signature or 4)
        if bar_period > 0:
            n_bars = int((track_duration - first_db) / bar_period) + 1
            downbeats = [round(first_db + i * bar_period, 3) for i in range(max(0, n_bars))]

    # ── Integrated loudness (LUFS) for level matching (≈0.2s, additive/graceful) ──
    lufs, loudness_range = _compute_lufs(lufs_stereo_seg) if lufs_stereo_seg is not None else (None, None)

    # ── Audio features (energy/danceability/brightness) + key confidence ──
    # Reproducible, fixed-anchor normalization (NOT dataset-relative). Fully additive:
    # any failure degrades to neutral 0.5 and never affects BPM/key/camelot/beat_grid.
    # key_confidence is now the multi-window vote (above), not the single-strength path; pass
    # [] for keys so _aggregate_features computes only energy/danceability/brightness.
    features = _aggregate_features(per_window_features, None, [])

    return {
        "bpm": round(final_bpm, 1), "confidence": confidence,
        "raw": raw, "normalized": normalized,
        "beat_positions": beat_positions,
        "beat_grid": beat_grid,
        "key": detected_key,
        "camelot": camelot,
        "intro_end": intro_end,
        "outro_start": outro_start,
        "downbeats": downbeats,
        "time_signature": time_signature,
        "lufs": lufs,
        "loudness_range": loudness_range,
        "algo_version": BPM_ALGO_VERSION,
        "energy": features["energy"],
        "danceability": features["danceability"],
        "brightness": features["brightness"],
        "key_confidence": round(float(key_confidence_value), 4),
        "feature_version": FEATURE_VERSION,
    }


# ── Audio features: median-aggregate across windows + reproducible normalization ──

def _aggregate_features(per_window_features: list, key_strength, per_window_keys: list) -> dict:
    """Median-aggregate raw per-window features (mirrors the weighted-median BPM approach)
    and map to reproducible 0..1 scalars via fixed anchors. Returns
    {energy, danceability, brightness, key_confidence, feature_version}.

    Fully additive: ANY failure degrades to neutral 0.5 and never touches BPM/key/camelot."""
    try:
        if per_window_features:
            rms_raw = float(np.median([f["rms"] for f in per_window_features]))
            centroid_hz = float(np.median([f["centroid_hz"] for f in per_window_features]))
            pulse_raw = float(np.median([f["pulse"] for f in per_window_features]))

            energy_loud = clamp01((20.0 * np.log10(rms_raw + 1e-6) - DBFS_FLOOR) / (DBFS_CEIL - DBFS_FLOOR))
            danceability = clamp01(pulse_raw / PULSE_REF)
            brightness = clamp01(centroid_hz / BRIGHTNESS_REF_HZ)
            energy = clamp01(0.6 * energy_loud + 0.4 * danceability)  # composite arc target
        else:
            energy = danceability = brightness = 0.5

        # Key confidence: prefer essentia strength; else cross-window key agreement; else neutral.
        if key_strength is not None and 0.0 < float(key_strength) <= 1.0:
            key_confidence = clamp01(key_strength)
        elif len(per_window_keys) > 1:
            top = max(set(per_window_keys), key=per_window_keys.count)
            key_confidence = clamp01(per_window_keys.count(top) / len(per_window_keys))
        else:
            key_confidence = 0.5

        return {
            "energy": round(float(energy), 4),
            "danceability": round(float(danceability), 4),
            "brightness": round(float(brightness), 4),
            "key_confidence": round(float(key_confidence), 4),
            "feature_version": FEATURE_VERSION,
        }
    except Exception as e:
        logger.warning("Feature aggregation failed: %s", e)
        return {
            "energy": 0.5, "danceability": 0.5, "brightness": 0.5,
            "key_confidence": 0.5, "feature_version": FEATURE_VERSION,
        }


def compute_features_only(file_path: str) -> dict:
    """Lazy-backfill features WITHOUT touching BPM. Reads ONE cheap mid-window and computes
    only the audio features + essentia key strength. Never computes the BPM ensemble, beat
    tracking, or beat grid, and never returns bpm/key/camelot/beat_grid. Returns
    {energy, danceability, brightness, key_confidence, feature_version}."""
    try:
        import soundfile as sf
        import librosa

        info = sf.info(file_path)
        track_duration = float(info.duration)

        WIN_LEN = 45.0
        start = 0.0 if track_duration < 90 else max(0.0, min(0.45 * track_duration, track_duration - WIN_LEN))
        mono_seg, _ = _read_window(file_path, start, WIN_LEN)
        if len(mono_seg) == 0:
            raise ValueError("empty mid-window")

        # Reuse the same onset_env recipe as _detect_window so `pulse` stays comparable.
        HOP = 512
        mono_22k = librosa.resample(mono_seg, orig_sr=44100, target_sr=22050)
        _, y_perc = librosa.effects.hpss(mono_22k, margin=3.0)
        onset_env = librosa.onset.onset_strength(
            y=y_perc, sr=22050, hop_length=HOP,
            aggregate=np.median, fmax=8000, n_mels=80,
        )
        win_features = _window_features(mono_seg, onset_env, sr=44100)

        key_strength = None
        try:
            import essentia.standard as es
            _kn, _scale, strength = es.KeyExtractor()(mono_seg.astype(np.float32))
            key_strength = float(strength)
        except Exception:
            key_strength = None

        return _aggregate_features([win_features], key_strength, [])
    except Exception as e:
        logger.warning("compute_features_only failed for %s: %s", file_path, e)
        return {
            "energy": 0.5, "danceability": 0.5, "brightness": 0.5,
            "key_confidence": 0.5, "feature_version": FEATURE_VERSION,
        }


def _needs_features(entry: dict) -> bool:
    """True when a cached/fast-path entry lacks current-version audio features."""
    return isinstance(entry, dict) and entry.get("feature_version") != FEATURE_VERSION


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


def read_downbeat_anchor_tag(file_path: str) -> float | None:
    """Read the first-downbeat anchor (seconds) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("DOWNBEAT_ANCHOR") or tags.get("downbeat_anchor")
    if val:
        try:
            return float(val[0])
        except Exception:
            pass
    return None


def read_time_sig_tag(file_path: str) -> int | None:
    """Read time signature (beats per bar, 3 or 4) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("TIME_SIG") or tags.get("time_sig")
    if val:
        try:
            return int(float(val[0]))
        except Exception:
            pass
    return None


def read_lufs_tag(file_path: str) -> float | None:
    """Read integrated loudness (LUFS) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("LUFS") or tags.get("lufs")
    if val:
        try:
            return float(val[0])
        except Exception:
            pass
    return None


def read_loudness_range_tag(file_path: str) -> float | None:
    """Read loudness range (LU) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("LOUDNESS_RANGE") or tags.get("loudness_range")
    if val:
        try:
            return float(val[0])
        except Exception:
            pass
    return None


def read_algover_tag(file_path: str) -> int | None:
    """Read the BPM algorithm version the file was last analyzed with."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("BPM_ALGO_VER") or tags.get("bpm_algo_ver")
    if val:
        try:
            return int(val[0])
        except Exception:
            pass
    return None


def read_feature_ver_tag(file_path: str) -> int | None:
    """Read the audio-feature version the file was last analyzed with."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("FEATURE_VER") or tags.get("feature_ver")
    if val:
        try:
            return int(val[0])
        except Exception:
            pass
    return None


def read_feature_tags(file_path: str) -> dict | None:
    """Read energy/danceability/brightness/key_confidence + feature_version from tags.
    Returns the feature dict only when ALL feature values + a matching version are present;
    otherwise None so the caller backfills."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    fv = read_feature_ver_tag(file_path)
    if fv != FEATURE_VERSION:
        return None
    out = {}
    for field, flac_key, mp3_key in [
        ("energy", "ENERGY", "energy"),
        ("danceability", "DANCEABILITY", "danceability"),
        ("brightness", "BRIGHTNESS", "brightness"),
        ("key_confidence", "KEY_CONFIDENCE", "key_confidence"),
    ]:
        val = tags.get(flac_key) or tags.get(mp3_key)
        if not val:
            return None
        try:
            out[field] = clamp01(float(val[0]))
        except Exception:
            return None
    out["feature_version"] = FEATURE_VERSION
    return out


def write_tags(file_path: str, bpm: int = None, key: str = None,
               beat_anchor: float = None, intro_end: float = None,
               outro_start: float = None, algo_ver: int = None,
               energy: float = None, danceability: float = None,
               brightness: float = None, key_confidence: float = None,
               feature_ver: int = None, downbeat_anchor: float = None,
               time_sig: int = None, lufs: float = None,
               loudness_range: float = None):
    """Write BPM, key, beat anchor, intro end, outro start, and audio features to file tags.
    Feature tags are ADDITIVE — they never block the BPM tag write."""
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
        for tag_name, value in [("INTRO_END", intro_end), ("OUTRO_START", outro_start),
                                ("ENERGY", energy), ("DANCEABILITY", danceability),
                                ("BRIGHTNESS", brightness), ("KEY_CONFIDENCE", key_confidence),
                                ("DOWNBEAT_ANCHOR", downbeat_anchor), ("LUFS", lufs),
                                ("LOUDNESS_RANGE", loudness_range), ("TIME_SIG", time_sig)]:
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
        if feature_ver is not None:
            if fmt == "flac":
                tags["FEATURE_VER"] = str(feature_ver)
            else:
                from mutagen.easyid3 import EasyID3
                if "feature_ver" not in EasyID3.valid_keys:
                    from mutagen.id3 import TXXX
                    EasyID3.RegisterTXXXKey("feature_ver", "FEATURE_VER")
                tags["feature_ver"] = str(feature_ver)
        if algo_ver is not None:
            if fmt == "flac":
                tags["BPM_ALGO_VER"] = str(algo_ver)
            else:
                from mutagen.easyid3 import EasyID3
                if "bpm_algo_ver" not in EasyID3.valid_keys:
                    from mutagen.id3 import TXXX
                    EasyID3.RegisterTXXXKey("bpm_algo_ver", "BPM_ALGO_VER")
                tags["bpm_algo_ver"] = str(algo_ver)
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


def _reconstruct_downbeats(bpm: float, downbeat_anchor: float, time_sig: int,
                           duration: float) -> list:
    """Reconstruct the full-track downbeat grid from bpm + first-downbeat anchor + time
    signature (parallel to _reconstruct_beat_grid). Returns [] when inputs are missing."""
    try:
        if bpm <= 0 or downbeat_anchor is None:
            return []
        beat_period = 60.0 / bpm
        bar_period = beat_period * (time_sig or 4)
        if bar_period <= 0:
            return []
        n_bars = int((duration - downbeat_anchor) / bar_period) + 1
        return [round(downbeat_anchor + i * bar_period, 3) for i in range(max(0, n_bars))]
    except Exception:
        return []


def _analyze_or_read_tag(file_path: str) -> dict:
    """Check file tags first, run full analysis if any tag missing."""
    existing_bpm = read_bpm_tag(file_path)
    existing_key = read_key_tag(file_path)
    existing_anchor = read_anchor_tag(file_path)
    existing_intro = read_intro_tag(file_path)
    existing_outro = read_outro_tag(file_path)
    existing_ver = read_algover_tag(file_path)

    if (existing_bpm and existing_key and existing_anchor is not None
            and existing_intro is not None and existing_outro is not None
            and existing_ver == BPM_ALGO_VERSION):
        # All tags present AND analyzed by the current algorithm — fast path (BPM untouched).
        bpm = float(existing_bpm)
        camelot = CAMELOT_MAP.get(existing_key)
        beat_grid, track_duration = _reconstruct_beat_grid(bpm, existing_anchor, file_path)
        # Reconstruct downbeats from anchor + time_sig (additive; [] when tags absent).
        existing_db_anchor = read_downbeat_anchor_tag(file_path)
        existing_time_sig = read_time_sig_tag(file_path)
        downbeats = _reconstruct_downbeats(bpm, existing_db_anchor, existing_time_sig,
                                           track_duration)
        result = {
            "bpm": bpm, "confidence": 1.0,
            "raw": {"tag_bpm": existing_bpm, "tag_key": existing_key},
            "normalized": {"tag": bpm},
            "key": existing_key, "camelot": camelot,
            "beat_positions": beat_grid, "beat_grid": beat_grid,
            "intro_end": existing_intro,
            "outro_start": existing_outro,
            "downbeats": downbeats,
            "time_signature": existing_time_sig,
            "lufs": read_lufs_tag(file_path),
            "loudness_range": read_loudness_range_tag(file_path),
            "algo_version": BPM_ALGO_VERSION,
        }
        # Lazy feature backfill — never blocks/breaks the BPM fast path.
        feats = read_feature_tags(file_path)
        if feats is None:
            feats = compute_features_only(file_path)
            try:
                write_tags(file_path,
                           energy=feats.get("energy"),
                           danceability=feats.get("danceability"),
                           brightness=feats.get("brightness"),
                           key_confidence=feats.get("key_confidence"),
                           feature_ver=FEATURE_VERSION)
            except Exception as e:
                logger.warning("Feature tag write failed for %s: %s", file_path, e)
        result.update(feats)
        return result

    # Need full analysis (missing tag(s))
    result = analyze_bpm(file_path)
    # Write all tags
    anchor = (result.get("beat_positions") or [None])[0]
    downbeats_out = result.get("downbeats") or []
    downbeat_anchor = downbeats_out[0] if downbeats_out else None
    write_tags(file_path,
               bpm=int(round(result["bpm"])),
               key=result.get("key"),
               beat_anchor=anchor,
               intro_end=result.get("intro_end"),
               outro_start=result.get("outro_start"),
               algo_ver=BPM_ALGO_VERSION,
               energy=result.get("energy"),
               danceability=result.get("danceability"),
               brightness=result.get("brightness"),
               key_confidence=result.get("key_confidence"),
               feature_ver=FEATURE_VERSION,
               downbeat_anchor=downbeat_anchor,
               time_sig=result.get("time_signature"),
               lufs=result.get("lufs"),
               loudness_range=result.get("loudness_range"))
    return result


# ── Audio file access ──

async def _get_audio_file(song_id: str, name: str, artist: str) -> str | None:
    local = find_track_file(name, artist)
    if local:
        return local

    if not library.NAVIDROME_PASSWORD or not song_id:
        return None

    # Reuse the player's shared Navidrome stream cache (ms-nav-cache/{song_id}.mp3)
    # instead of pulling a second original-FLAC copy. Lossy 320k MP3 is transparent
    # for tempo/beat-grid/key/LUFS; it's build-lock-guarded against the live stream GET.
    shared = await cache_navidrome_stream(song_id, lossless=False)
    if shared:
        return shared
    # Fall back to original-FLAC download if the shared MP3 build failed.

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
        evict_cache_dir(cache_dir, BPM_CACHE_MAX_BYTES)
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


async def _backfill_features(entry: dict, song_id: str, name: str, artist: str) -> dict:
    """Lazily enrich a cached BPM entry with audio features WITHOUT recomputing BPM.
    Only the feature fields are merged in — bpm/key/camelot/beat_grid stay untouched.
    Returns the (possibly enriched) entry."""
    if not _needs_features(entry):
        return entry
    file_path = await _get_audio_file(song_id, name, artist)
    if not file_path:
        return entry  # can't backfill without audio — leave BPM data intact
    feats = await _run_in_pool(compute_features_only, file_path)
    entry.update(feats)  # feats contains ONLY feature fields → never overwrites bpm/key/grid
    _bpm_cache[_cache_key(name, artist)] = entry
    _save_cache()
    return entry


async def analyze_track(song_id: str, name: str, artist: str,
                        force: bool = False) -> dict | None:
    key = _cache_key(name, artist)
    if not force and key in _bpm_cache:
        return await _backfill_features(_bpm_cache[key], song_id, name, artist)

    # Per-track lock: only one analysis at a time per track
    if key not in _analysis_locks:
        _analysis_locks[key] = asyncio.Lock()
    async with _analysis_locks[key]:
        # Re-check cache after acquiring lock (another request may have finished)
        if not force and key in _bpm_cache:
            return await _backfill_features(_bpm_cache[key], song_id, name, artist)

        file_path = await _get_audio_file(song_id, name, artist)
        if not file_path:
            return None

        result = await _run_in_pool(_analyze_or_read_tag, file_path)
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
        result = await _run_in_pool(_analyze_or_read_tag, fp)
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
    result = await _run_in_pool(_analyze_or_read_tag, file_path)
    result["name"] = name
    result["artist"] = artist
    _bpm_cache[_cache_key(name, artist)] = result
    _save_cache()
    return result
