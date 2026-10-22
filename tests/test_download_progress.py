"""The progress bar of a one-track download.

The commonest job in the app is a single track, and it is the one case where
"percent of tracks started" is always zero: the bar sat empty for the whole
download and then jumped straight to done.
"""
from app.services.downloader import _track_progress


def test_a_single_track_reaches_full_when_it_finishes():
    assert _track_progress(0, 1) == 0
    assert _track_progress(1, 1) == 100


def test_a_multi_track_job_climbs_once_per_finished_track():
    assert [_track_progress(done, 4) for done in range(5)] == [0, 25, 50, 75, 100]


def test_an_empty_job_does_not_divide_by_zero():
    assert _track_progress(0, 0) == 0
