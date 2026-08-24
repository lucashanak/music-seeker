"""Tests for configurable slskd completed-download directory lookup."""
import os

from app.services import downloader
from app.services.downloader import (
    _find_completed_slskd_file,
    _slskd_download_dir,
)


def test_default_download_dir_uses_music_dir(monkeypatch, tmp_path):
    monkeypatch.delenv("SLSKD_DOWNLOAD_DIR", raising=False)
    monkeypatch.setattr(downloader, "MUSIC_DIR", str(tmp_path))
    assert _slskd_download_dir() == f"{tmp_path}/.slskd-downloads"


def test_custom_download_dir_from_env(monkeypatch, tmp_path):
    custom = tmp_path / "downloads"
    custom.mkdir()
    monkeypatch.setenv("SLSKD_DOWNLOAD_DIR", str(custom))
    monkeypatch.setattr(downloader, "MUSIC_DIR", str(tmp_path / "music"))
    assert _slskd_download_dir() == str(custom)


def test_find_nested_file_under_custom_dir(monkeypatch, tmp_path):
    custom = tmp_path / "downloads"
    nested = custom / "peer" / "album"
    nested.mkdir(parents=True)
    track = nested / "Artist - Title.flac"
    track.write_bytes(b"audio")

    monkeypatch.setenv("SLSKD_DOWNLOAD_DIR", str(custom))
    found = _find_completed_slskd_file("Artist - Title.flac")
    assert found == str(track)


def test_default_music_dir_is_slash_music(monkeypatch):
    monkeypatch.delenv("SLSKD_DOWNLOAD_DIR", raising=False)
    monkeypatch.setattr(downloader, "MUSIC_DIR", "/music")
    assert _slskd_download_dir() == "/music/.slskd-downloads"
