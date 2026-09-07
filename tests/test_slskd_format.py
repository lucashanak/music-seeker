"""Unit tests for slskd format selection and download API format enforcement."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import downloads
from app.services import auth
from app.services.downloader import _pick_best_slskd_file, _slskd_file_extension


def _file(filename: str, size: int = 5_000_000, bit_rate: int = 320) -> dict:
    return {"filename": filename, "size": size, "bitRate": bit_rate}


def _responses(username: str, *files: dict) -> list:
    return [{"username": username, "files": list(files)}]


# --- _slskd_file_extension ---


def test_extension_uses_final_component_and_real_suffix():
    assert _slskd_file_extension(r"music\song.mp3.extra.flac") == "flac"
    assert _slskd_file_extension("folder/track.MP3") == "mp3"


# --- _pick_best_slskd_file ---


def test_mp3_requested_selects_mp3_over_flac():
    responses = _responses(
        "peer1",
        _file("Artist - Song.mp3", bit_rate=192),
        _file("Artist - Song.flac", size=30_000_000, bit_rate=1411),
    )
    result = _pick_best_slskd_file(responses, "mp3")
    assert result is not None
    _, chosen = result
    assert chosen["filename"].endswith(".mp3")


def test_mp3_requested_only_flac_returns_none():
    responses = _responses("peer1", _file("Artist - Song.flac", bit_rate=1411))
    assert _pick_best_slskd_file(responses, "mp3") is None


def test_flac_requested_selects_flac_over_mp3():
    responses = _responses(
        "peer1",
        _file("Artist - Song.mp3", bit_rate=320),
        _file("Artist - Song.flac", bit_rate=1411),
    )
    result = _pick_best_slskd_file(responses, "flac")
    assert result is not None
    _, chosen = result
    assert chosen["filename"].endswith(".flac")


def test_uppercase_mp3_extension_counts_as_mp3():
    responses = _responses("peer1", _file("Artist - Song.MP3"))
    result = _pick_best_slskd_file(responses, "mp3")
    assert result is not None
    _, chosen = result
    assert chosen["filename"].endswith(".MP3")


def test_high_quality_flac_does_not_beat_mp3_when_mp3_requested():
    responses = _responses(
        "peer1",
        _file("Artist - Song.mp3", size=5_000_000, bit_rate=128),
        _file("Artist - Song.flac", size=50_000_000, bit_rate=1411),
    )
    result = _pick_best_slskd_file(responses, "mp3")
    assert result is not None
    _, chosen = result
    assert chosen["filename"].endswith(".mp3")


# --- POST /api/download format enforcement ---


def test_download_flac_forbidden_when_only_mp3_allowed():
    app = FastAPI()
    app.include_router(downloads.router)

    def mock_user():
        return {
            "username": "testuser",
            "allowed_formats": ["mp3"],
            "allowed_methods": ["yt-dlp", "slskd", "lidarr"],
            "is_admin": False,
        }

    app.dependency_overrides[auth.get_current_user] = mock_user
    try:
        client = TestClient(app)
        resp = client.post(
            "/api/download",
            json={
                "url": "",
                "title": "Artist - Song",
                "method": "slskd",
                "format": "flac",
            },
        )
        assert resp.status_code == 403
        assert "flac" in resp.json()["detail"].lower()
    finally:
        app.dependency_overrides.clear()
