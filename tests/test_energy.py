"""Energy (feature version 2): it must not follow the volume knob, it must tell a busy
rhythm from a sparse one, and old entries must be brought up to date in the background."""
import asyncio

import numpy as np
import pytest

from app.services import bpm

SR = bpm.ENERGY_SR


def _track(hits_per_sec: float, seconds: float = 12.0, level: float = 0.5) -> np.ndarray:
    """A pad with percussive clicks on top: `hits_per_sec` decides how busy it is."""
    rng = np.random.default_rng(3)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    y = 0.2 * np.sin(2 * np.pi * 220 * t)
    burst = rng.standard_normal(int(0.03 * SR)) * np.exp(-np.linspace(0, 6, int(0.03 * SR)))
    for k in range(int(seconds * hits_per_sec)):
        i = int(k / hits_per_sec * SR)
        y[i:i + len(burst)] += burst[: max(0, min(len(burst), n - i))]
    return (level * y / np.max(np.abs(y))).astype(np.float32)


def _energy(y):
    return bpm.energy_from_raw([bpm.energy_window_raw(y)])


def test_turning_the_volume_down_does_not_change_the_energy():
    loud, quiet = _energy(_track(4, level=0.9)), _energy(_track(4, level=0.09))   # −20 dB
    assert abs(loud - quiet) < 0.02


def test_a_busy_rhythm_is_more_energetic_than_a_sparse_one_at_any_level():
    sparse_loud, busy_quiet = _energy(_track(1, level=0.9)), _energy(_track(6, level=0.09))
    assert busy_quiet > sparse_loud + 0.15


def test_the_result_stays_inside_0_and_1_and_silence_does_not_crash():
    assert 0.0 <= _energy(_track(12)) <= 1.0
    assert 0.0 <= _energy(np.zeros(SR * 5, dtype=np.float32)) <= 1.0


def test_windows_without_the_new_features_give_no_energy_rather_than_loudness():
    # The old composite under the new version number would be shown as the real thing.
    assert bpm.energy_from_raw([{"rms": 0.1, "centroid_hz": 2000, "pulse": 1.0}]) is None
    feats = bpm._aggregate_features([{"rms": 0.1, "centroid_hz": 2000, "pulse": 1.0}], None, [])
    assert feats["energy"] is None and feats["feature_version"] == bpm.FEATURE_VERSION


# -- through the production path: a file on disk -> compute_features_only --

def _flac(tmp_path, name, y):
    import soundfile as sf
    p = tmp_path / name
    sf.write(str(p), y, SR, format="FLAC")
    return str(p)


def test_a_file_played_20_db_quieter_gets_the_same_energy(tmp_path):
    loud = bpm.compute_features_only(_flac(tmp_path, "loud.flac", _track(4, seconds=40, level=0.9)))
    quiet = bpm.compute_features_only(_flac(tmp_path, "quiet.flac", _track(4, seconds=40, level=0.09)))
    assert loud["energy"] is not None and abs(loud["energy"] - quiet["energy"]) < 0.03
    assert loud["feature_version"] == bpm.FEATURE_VERSION


def test_a_quiet_busy_file_beats_a_loud_sparse_one(tmp_path):
    sparse = bpm.compute_features_only(_flac(tmp_path, "sparse.flac", _track(1, seconds=40, level=0.9)))
    busy = bpm.compute_features_only(_flac(tmp_path, "busy.flac", _track(6, seconds=40, level=0.09)))
    assert busy["energy"] > sparse["energy"] + 0.15


def test_a_long_track_is_read_in_three_places(tmp_path, monkeypatch):
    seen = []
    real = bpm._read_window
    monkeypatch.setattr(bpm, "_read_window", lambda p, st, ln: (seen.append(round(st)), real(p, st, ln))[1])
    bpm.compute_features_only(_flac(tmp_path, "long.flac", _track(2, seconds=120)))
    assert seen == [30, 60, 90]


def test_a_file_that_cannot_be_read_is_unmeasured_not_average(tmp_path):
    bad = tmp_path / "broken.flac"
    bad.write_bytes(b"not audio")
    feats = bpm.compute_features_only(str(bad))
    assert feats["energy"] is None and feats["feature_version"] == bpm.FEATURE_VERSION


def test_the_median_over_windows_ignores_one_quiet_passage():
    busy, calm = bpm.energy_window_raw(_track(6)), bpm.energy_window_raw(_track(0.5))
    assert bpm.energy_from_raw([busy, calm, busy]) == pytest.approx(bpm.energy_from_raw([busy]))


@pytest.fixture
def sweep(monkeypatch):
    from app.services import library, mixes
    cache = {
        "a::old": {"name": "Old", "artist": "A", "bpm": 88.0, "energy": 0.7, "feature_version": 1},
        "a::new": {"name": "New", "artist": "A", "bpm": 90.0, "energy": 0.2, "feature_version": bpm.FEATURE_VERSION},
        "a::gone": {"name": "Gone", "artist": "A", "bpm": 70.0, "energy": 0.6, "feature_version": 1},
        "a::set": {"name": "Set", "artist": "A", "bpm": 80.0, "energy": 0.6, "feature_version": 1},
        "a::nav": {"name": "Nav", "artist": "A", "bpm": 81.0, "energy": 0.6, "feature_version": 1},
    }
    st = {"cache": cache, "asked": [], "saves": 0, "pool": None, "executors": [], "running": 0, "peak": 0}
    monkeypatch.setattr(bpm, "_bpm_cache", cache)
    monkeypatch.setattr(bpm, "_cache_key", lambda n, a: f"{a.lower()}::{n.lower()}")
    monkeypatch.setattr(bpm, "_save_cache", lambda: st.__setitem__("saves", st["saves"] + 1))
    monkeypatch.setattr(bpm, "_sweep_state", {"running": False, "done": 0, "left": 0})
    monkeypatch.setattr(mixes, "is_mix", lambda n, a: n == "Set")

    async def find_song_id(name, artist, album=""):
        return "nd1" if name == "Nav" else None
    monkeypatch.setattr(library, "find_song_id", find_song_id)

    async def audio(song_id, name, artist):
        st["asked"].append((name, song_id))
        return None if name == "Gone" else "/x.flac"
    monkeypatch.setattr(bpm, "_get_audio_file", audio)

    async def pool(fn, *a, executor=None):
        st["executors"].append(executor)
        st["running"] += 1
        st["peak"] = max(st["peak"], st["running"])
        await asyncio.sleep(0.01)
        st["running"] -= 1
        if st["pool"]:
            await st["pool"]()
        return {"energy": 0.33, "danceability": 0.5, "brightness": 0.5, "key_confidence": 0.5,
                "feature_version": bpm.FEATURE_VERSION}
    monkeypatch.setattr(bpm, "_run_in_pool", pool)
    return st


def test_the_background_sweep_updates_stale_entries_and_leaves_bpm_alone(sweep):
    cache = sweep["cache"]
    st = asyncio.run(bpm.backfill_stale_features(pause=0))
    assert sorted(sweep["asked"]) == [("Gone", ""), ("Nav", "nd1"), ("Old", "")]   # not the current one, not the set
    assert cache["a::old"]["energy"] == 0.33 and cache["a::old"]["bpm"] == 88.0
    assert cache["a::nav"]["energy"] == 0.33                      # found through its Navidrome id
    assert cache["a::set"]["feature_version"] == 1                # a downloaded set is never analysed
    assert st["done"] == 2 and st["left"] == 0 and st["running"] is False
    assert sweep["saves"] == 1                                    # once at the end, not once per track


def test_a_track_without_audio_is_marked_and_not_walked_for_again(sweep):
    asyncio.run(bpm.backfill_stale_features(pause=0))
    gone = sweep["cache"]["a::gone"]
    assert gone["feature_version"] == 1 and gone["energy"] == 0.6 and gone["features_unavailable"] == bpm.FEATURE_VERSION
    sweep["asked"].clear()
    asyncio.run(bpm.backfill_stale_features(pause=0))
    assert ("Gone", "") not in sweep["asked"]


def test_the_sweep_saves_in_batches(sweep, monkeypatch):
    monkeypatch.setattr(bpm, "SWEEP_SAVE_EVERY", 1)
    asyncio.run(bpm.backfill_stale_features(pause=0))
    assert sweep["saves"] == 3                                    # Old, Gone (its mark), Nav


def test_a_re_analysis_that_lands_during_the_sweep_is_not_overwritten(sweep):
    cache = sweep["cache"]
    fresh = {"name": "Old", "artist": "A", "bpm": 120.0, "beat_grid": [0.5], "energy": 0.9,
             "feature_version": bpm.FEATURE_VERSION}

    async def meanwhile():
        cache["a::old"] = fresh                                   # a forced analysis finishes first
    sweep["pool"] = meanwhile
    asyncio.run(bpm.backfill_stale_features(pause=0))
    assert cache["a::old"] is fresh and fresh["bpm"] == 120.0 and fresh["energy"] == 0.9


def test_the_cache_file_is_replaced_whole(tmp_path, monkeypatch):
    import os
    f = tmp_path / "bpm_analysis.json"
    f.write_text('{"keep": 1}')
    monkeypatch.setattr(bpm, "DATA_DIR", tmp_path)
    monkeypatch.setattr(bpm, "BPM_CACHE_FILE", f)
    monkeypatch.setattr(bpm, "_bpm_cache", {"a": {"bpm": 1.0}})
    real = os.replace
    seen = {}
    monkeypatch.setattr(os, "replace", lambda a, b: (seen.setdefault("old", f.read_text()), real(a, b))[1])
    bpm._save_cache()
    assert seen["old"] == '{"keep": 1}'                           # the old file was whole until the swap
    assert f.read_text() == '{"a":{"bpm":1.0}}' and not list(tmp_path.glob("*.tmp"))


def test_the_sweep_works_several_tracks_at_once_on_its_own_workers(sweep):
    for i in range(12):
        sweep["cache"][f"a::t{i}"] = {"name": f"T{i}", "artist": "A", "bpm": 80.0, "feature_version": 1}
    st = asyncio.run(bpm.backfill_stale_features(pause=0))
    assert 1 < sweep["peak"] <= bpm._sweep_executor._max_workers
    assert set(sweep["executors"]) == {bpm._sweep_executor}       # never the pool listeners wait on
    assert st["done"] == 14 and st["left"] == 0


# -- felt tempo, and a little of it in the energy (feature version 3) --

def test_the_felt_tempo_changes_octave_only_when_the_rhythm_leaves_no_doubt():
    assert bpm.tempo_feel(62, 62 / 60 * 3.6) == 124.0            # a dense "62" is a 124 BPM track
    assert bpm.tempo_feel(110, 110 / 60 * 1.7) == 55.0           # one event per beat at 110 feels half
    assert bpm.tempo_feel(62, 62 / 60 * 3.0) == 62.0             # not dense enough: left alone
    assert bpm.tempo_feel(72, 72 / 60 * 4.0) == 72.0             # 144 would be a guess; outside the rule
    assert bpm.tempo_feel(68, 68 / 60 * 4.0) == 68.0
    assert bpm.tempo_feel(88, 88 / 60 * 1.5) == 88.0
    assert bpm.tempo_feel(None, 3.0) is None and bpm.tempo_feel(0, 3.0) is None
    assert bpm.tempo_feel(80, None) == 80.0
    # density is not speed: a calm, finger-picked "68" stays 68; a driving one doubles
    assert bpm.tempo_feel(64, 64 / 60 * 4.0, score=-0.4) == 64.0
    assert bpm.tempo_feel(64, 64 / 60 * 4.0, score=0.6) == 128.0
    # "Tunnel Vision": 70 BPM, busy hats, calm — doubling stops at 66 whatever the score
    assert bpm.tempo_feel(70, 70 / 60 * 4.4, score=0.9) == 70.0
    assert bpm.tempo_feel(110, 110 / 60 * 1.7, score=0.6) == 110.0   # sparse but driving: not halved
    assert bpm.tempo_feel(110, 110 / 60 * 1.7, score=-0.6) == 55.0


def test_a_faster_felt_tempo_raises_the_energy_a_little_and_no_tempo_is_neutral():
    slow, mid, fast = bpm.energy_value(0.0, 60), bpm.energy_value(0.0, 82), bpm.energy_value(0.0, 124)
    assert slow < mid < fast
    assert fast - slow < 0.35                                    # "a little": rhythm still decides
    assert bpm.energy_value(0.0) == pytest.approx(mid, abs=0.01)   # unknown tempo sits at the centre


def test_features_carry_the_felt_tempo_through_the_production_path(tmp_path):
    busy = _flac(tmp_path, "busy.flac", _track(6, seconds=60))
    drone = (0.3 * np.sin(2 * np.pi * 220 * np.arange(60 * SR) / SR)).astype(np.float32)
    calm = _flac(tmp_path, "calm.flac", drone)
    f = bpm.compute_features_only(busy, 62.0)
    assert f["onset_rate"] > 62 / 60 * 3.5 and f["tempo_feel"] == 124.0      # dense and driving: doubled
    assert bpm.compute_features_only(busy, 90.0)["tempo_feel"] == 90.0       # nothing to fold at 90
    nobpm = bpm.compute_features_only(busy)
    assert nobpm["energy"] is not None and "tempo_feel" not in nobpm         # no BPM: still an energy
    # the tempo reaches the energy: the same audio "at 124" does not rank below itself "at 90"
    assert f["energy"] >= bpm.compute_features_only(busy, 90.0)["energy"]
    assert bpm.compute_features_only(calm, 62.0)["tempo_feel"] == 62.0       # a drone is not a fast track
    assert "bpm" not in f


def test_the_sweep_hands_each_tracks_own_bpm_to_the_analysis(sweep):
    seen = []

    async def pool(fn, *a, executor=None):
        seen.append(a)
        return {"energy": 0.5, "danceability": 0.5, "brightness": 0.5, "key_confidence": 0.5,
                "feature_version": bpm.FEATURE_VERSION}
    bpm._run_in_pool = pool
    asyncio.run(bpm.backfill_stale_features(pause=0))
    assert sorted(a[1] for a in seen) == [81.0, 88.0]             # Nav and Old, each with its BPM


def test_a_file_tagged_current_is_still_measured_for_the_felt_tempo(tmp_path, monkeypatch):
    # The tags hold four features; the onset rate is not one of them.
    monkeypatch.setattr(bpm, "read_bpm_tag", lambda p: 62)
    monkeypatch.setattr(bpm, "read_key_tag", lambda p: "A minor")
    for fn in ("read_anchor_tag", "read_intro_tag", "read_outro_tag"):
        monkeypatch.setattr(bpm, fn, lambda p: 1.0)
    monkeypatch.setattr(bpm, "read_algover_tag", lambda p: bpm.BPM_ALGO_VERSION)
    monkeypatch.setattr(bpm, "_reconstruct_beat_grid", lambda b, a, p: ([1.0, 2.0], 60.0))
    monkeypatch.setattr(bpm, "write_tags", lambda *a, **k: None)
    asked = []
    monkeypatch.setattr(bpm, "compute_features_only",
                        lambda p, b=None: (asked.append(b), {"energy": 0.9, "tempo_feel": 124.0, "feature_version": bpm.FEATURE_VERSION})[1])
    r = bpm._analyze_or_read_tag(str(tmp_path / "x.flac"))
    assert asked == [62.0] and r["bpm"] == 62.0 and r["tempo_feel"] == 124.0


def test_the_stored_bpm_is_never_changed_by_the_felt_tempo(sweep):
    cache = sweep["cache"]

    async def pool(fn, *a, executor=None):
        return {"energy": 0.9, "tempo_feel": 176.0, "onset_rate": 6.0, "danceability": 0.5, "brightness": 0.5,
                "key_confidence": 0.5, "feature_version": bpm.FEATURE_VERSION}
    bpm._run_in_pool = pool                                       # restored by the fixture's monkeypatch
    asyncio.run(bpm.backfill_stale_features(pause=0))
    assert cache["a::old"]["bpm"] == 88.0 and cache["a::old"]["tempo_feel"] == 176.0


def test_a_background_refresh_runs_once_per_track_and_marks_missing_audio(sweep):
    cache = sweep["cache"]

    async def run():
        assert bpm.backfill_in_background("Old", "A") is True
        assert bpm.backfill_in_background("Old", "A") is False          # already under way
        assert bpm.backfill_in_background("New", "A") is False          # current: nothing to do
        assert bpm.backfill_in_background("Nobody", "A") is False       # not analysed at all
        assert bpm.backfill_in_background("Gone", "A") is True
        await asyncio.gather(*list(bpm._bg_tasks))
    asyncio.run(run())
    assert cache["a::old"]["energy"] == 0.33 and cache["a::old"]["bpm"] == 88.0
    assert cache["a::gone"]["features_unavailable"] == bpm.FEATURE_VERSION and not bpm._bg_backfills
    assert set(sweep["executors"]) == {bpm._sweep_executor}             # never the listeners' pool


# -- version 4: a pluck over silence is not a snare in a full mix --

def _plucked(seconds=40.0, per_sec=5.0):
    """Dull, decaying 'guitar' notes over near-silence: big dB jumps, no bright percussion."""
    n = int(seconds * SR)
    y = np.zeros(n, dtype=np.float64)
    note = np.sin(2 * np.pi * 330 * np.arange(int(0.25 * SR)) / SR) * np.exp(-np.linspace(0, 7, int(0.25 * SR)))
    for k in range(int(seconds * per_sec)):
        i = int(k / per_sec * SR)
        y[i:i + len(note)] += note[: max(0, min(len(note), n - i))]
    return (0.6 * y / np.max(np.abs(y))).astype(np.float32)


def test_busy_plucking_over_a_quiet_bed_is_not_a_driving_track(tmp_path):
    plucked = bpm.compute_features_only(_flac(tmp_path, "guitar.flac", _plucked()), 78.0)
    driving = bpm.compute_features_only(_flac(tmp_path, "drums.flac", _track(5, seconds=40)), 78.0)
    assert plucked["energy"] < driving["energy"] - 0.2
    raw = bpm.energy_window_raw(_plucked(12.0))
    assert raw["perc_hi"] < bpm.energy_window_raw(_track(5))["perc_hi"] / 10     # the separating feature
    assert "onset_perc" not in raw and "lowflux" not in raw                      # nothing is a dB jump any more


def test_silence_between_notes_does_not_inflate_the_flux():
    # On a dB scale the first sound after digital silence is an enormous "rise".
    y = np.zeros(SR * 12, dtype=np.float32)
    y[SR * 6: SR * 6 + 2000] = 0.5 * np.sin(2 * np.pi * 440 * np.arange(2000) / SR)
    raw = bpm.energy_window_raw(y)
    assert all(np.isfinite(v) for v in raw.values()) and raw["flux_all"] < 5.0
