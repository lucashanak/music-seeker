"""Tag writes must not touch a file the player may be streaming, and must not
rewrite a file when nothing changes (the mtime keys the MP3 transcode cache)."""
import os
import tempfile
import threading
import time

import numpy as np
import pytest
import soundfile as sf
from mutagen.flac import FLAC

from app.services import bpm, player


def _flac(path):
    sf.write(path, (np.sin(np.arange(44100) / 20) * 0.3).astype("float32"), 44100, format="FLAC")
    f = FLAC(path)
    f["ARTIST"] = "x"
    f.save(padding=lambda info: 0)  # no padding: any growth shifts the audio offsets
    return path


def _stat(p):
    st = os.stat(p)
    return st.st_size, st.st_mtime_ns


@pytest.fixture
def track(tmp_path):
    p = str(tmp_path / "t.flac")
    _flac(p)
    yield p
    player._raw_pins.pop(p, None)


def test_unpinned_write_changes_file(track):
    before = _stat(track)
    bpm.write_tags(track, bpm=120)
    assert _stat(track) != before
    assert FLAC(track)["BPM"] == ["120"]


def test_pinned_file_is_not_written(track):
    player.pin_raw_local(track)
    before = open(track, "rb").read()
    bpm.write_tags(track, bpm=120, key="8A")
    assert open(track, "rb").read() == before


@pytest.fixture
def nav_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    d = tmp_path / "ms-nav-cache"
    d.mkdir()
    return d


def test_nav_cache_file_is_not_written(nav_dir):
    p = _flac(str(nav_dir / "t.flac"))
    before = open(p, "rb").read()
    bpm.write_tags(p, bpm=120)
    assert open(p, "rb").read() == before


def test_nav_cache_reached_through_symlink_is_not_written(nav_dir, tmp_path):
    p = _flac(str(nav_dir / "t.flac"))
    link = tmp_path / "link"
    link.symlink_to(nav_dir)
    before = open(p, "rb").read()
    bpm.write_tags(str(link / "t.flac"), bpm=120)
    assert open(p, "rb").read() == before


def test_sibling_of_nav_cache_is_written(nav_dir, tmp_path):
    d = tmp_path / "ms-nav-cache-x"
    d.mkdir()
    p = _flac(str(d / "t.flac"))
    bpm.write_tags(p, bpm=120)
    assert FLAC(p)["BPM"] == ["120"]


def test_changed_value_of_existing_tag_is_written(track):
    bpm.write_tags(track, bpm=120)
    bpm.write_tags(track, bpm=121)
    assert FLAC(track)["BPM"] == ["121"]


def test_open_reader_keeps_original_bytes(track):
    # a local .mp3 / lossless response holds a descriptor and has no pin
    orig = open(track, "rb").read()
    with open(track, "rb") as fh:
        head = fh.read(4096)
        bpm.write_tags(track, bpm=120, key="8A", intro_end=1.0, outro_start=9.0)
        rest = fh.read()
    assert head + rest == orig
    assert FLAC(track)["BPM"] == ["120"]


def test_concurrent_writers_keep_last_values(track, monkeypatch):
    real_open = bpm._open_tags

    def slow_open(path):
        r = real_open(path)
        time.sleep(0.003)  # widen the read-modify-write window so the race is certain
        return r

    monkeypatch.setattr(bpm, "_open_tags", slow_open)
    n = 30
    errs = []

    def run(field):
        try:
            for i in range(1, n + 1):
                bpm.write_tags(track, **{field: float(i)})
        except Exception as e:  # pragma: no cover
            errs.append(e)

    ts = [threading.Thread(target=run, args=(f,)) for f in ("intro_end", "outro_start")]
    [t.start() for t in ts]
    [t.join() for t in ts]
    f = FLAC(track)
    assert not errs
    assert f.get("INTRO_END") == [str(float(n))]
    assert f.get("OUTRO_START") == [str(float(n))]


def test_failed_save_leaves_no_temp_file(track, monkeypatch):
    def boom(self, *a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(FLAC, "save", boom)
    bpm.write_tags(track, bpm=120)
    assert os.listdir(os.path.dirname(track)) == ["t.flac"]


def test_no_temp_file_left_behind(track):
    bpm.write_tags(track, bpm=120)
    assert os.listdir(os.path.dirname(track)) == ["t.flac"]


def test_mp3_without_id3_header_gets_tags(tmp_path):
    p = str(tmp_path / "t.mp3")
    open(p, "wb").write(b"\xff\xfb\x90\x00" + b"\0" * 40000)
    bpm.write_tags(p, bpm=120, algo_ver=5)
    from mutagen.easyid3 import EasyID3
    assert EasyID3(p)["bpm"] == ["120"]


def test_identical_write_keeps_mtime(track):
    bpm.write_tags(track, bpm=120)
    st = _stat(track)
    time.sleep(0.02)
    bpm.write_tags(track, bpm=120)
    assert _stat(track) == st


def test_gridless_track_not_retagged_every_run(track, monkeypatch):
    monkeypatch.setattr(bpm, "analyze_bpm", lambda p: {
        "bpm": 86.1, "key": "8A", "beat_positions": [], "intro_end": 0.0,
        "outro_start": 0.5, "time_signature": 4})
    monkeypatch.setattr(bpm, "compute_features_only", lambda p: {})
    bpm._analyze_or_read_tag(track)
    st = _stat(track)
    time.sleep(0.02)
    bpm._analyze_or_read_tag(track)
    bpm._analyze_or_read_tag(track)
    assert _stat(track) == st
