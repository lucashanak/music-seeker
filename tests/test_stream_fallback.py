"""One spelling per track, and audio we already hold stays playable.

Both come from the same production run (2026-11-05): a Czech album arrived with its
titles in two different Unicode spellings inside one playlist, and a block of sixteen
tracks answered 404 while the audio pipeline itself was healthy minutes later.
"""
import asyncio
import os
import unicodedata

import pytest

from app.services import player


NFC_NAME = "Divoká"
NFD_NAME = unicodedata.normalize("NFD", NFC_NAME)


def test_the_two_spellings_of_a_title_are_one_cache_key():
    assert NFD_NAME != NFC_NAME, "the fixture must really be two different strings"
    assert player._cache_key(NFD_NAME, "Vesna") == player._cache_key(NFC_NAME, "Vesna")


def test_the_two_spellings_are_one_downloaded_file():
    assert (player._yt_cache_path(NFD_NAME, "Vesna", "192k")
            == player._yt_cache_path(NFC_NAME, "Vesna", "192k"))


def test_a_decomposed_title_is_folded_before_anything_looks_for_it(monkeypatch):
    """The library on disk is precomposed throughout, so a glob built from the
    decomposed spelling finds nothing and the track falls through to YouTube."""
    seen = []

    def fake_local(name, artist):
        seen.append(name)
        return {"source": "local", "path": "/music/x.flac"}
    monkeypatch.setattr(player, "_resolve_local_file", fake_local)
    player._url_cache.clear()

    asyncio.run(player.resolve_stream(NFD_NAME, "Vesna"))
    assert seen == [NFC_NAME]


def test_a_bitrate_we_do_not_have_still_finds_the_one_we_do(tmp_path, monkeypatch):
    monkeypatch.setattr(player.tempfile, "gettempdir", lambda: str(tmp_path))
    os.makedirs(tmp_path / "ms-yt-cache", exist_ok=True)
    have = player._yt_cache_path("Moravo", "Vesna", "192k")
    with open(have, "wb") as f:
        f.write(b"audio")

    assert player.youtube_cache_path("Moravo", "Vesna", "320k") == have
    assert player.youtube_cache_path("Moravo", "Vesna", "192k") == have


def test_nothing_downloaded_means_nothing_to_offer(tmp_path, monkeypatch):
    monkeypatch.setattr(player.tempfile, "gettempdir", lambda: str(tmp_path))
    os.makedirs(tmp_path / "ms-yt-cache", exist_ok=True)
    assert player.youtube_cache_path("Podzim", "Vesna") is None


def test_an_empty_cache_file_is_not_offered(tmp_path, monkeypatch):
    """A download killed half-way leaves a zero-byte file; serving it is silence."""
    monkeypatch.setattr(player.tempfile, "gettempdir", lambda: str(tmp_path))
    os.makedirs(tmp_path / "ms-yt-cache", exist_ok=True)
    open(player._yt_cache_path("Podzim", "Vesna", "192k"), "wb").close()
    assert player.youtube_cache_path("Podzim", "Vesna") is None
