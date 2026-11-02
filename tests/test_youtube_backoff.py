"""Asking YouTube less when YouTube has stopped answering.

Measured on production 2026-11-02: an album of tracks nobody owns made the resolver
run a search plus up to five extractions per track, with no memory of failure and no
reaction to being throttled. YouTube answered 429 / "Sign in to confirm you're not a
bot", and from then on every track that was not downloaded returned 404 — the user's
"tracks I haven't downloaded stopped playing". Twenty minutes later the same queries
worked again untouched, which is what makes this our volume rather than their outage.
"""
import asyncio
import time

import pytest

from app.services import player


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    player._url_cache.clear()
    player._yt_failed.clear()
    monkeypatch.setattr(player, "_yt_blocked_until", 0.0)
    # Nothing is owned, so every lookup reaches the YouTube arm.
    monkeypatch.setattr(player, "_resolve_local_file", lambda name, artist: None)

    async def no_navidrome(name, artist):
        return None
    monkeypatch.setattr(player, "_resolve_navidrome", no_navidrome)
    yield
    player._url_cache.clear()
    player._yt_failed.clear()


def _count_youtube_calls(monkeypatch, result=None):
    calls = []

    async def fake(name, artist):
        calls.append((name, artist))
        return result
    monkeypatch.setattr(player, "_resolve_youtube", fake)
    return calls


def test_a_track_that_just_failed_is_not_looked_up_again(monkeypatch):
    calls = _count_youtube_calls(monkeypatch)

    assert asyncio.run(player.resolve_stream("Ashfall", "Ragal Ironbull")) is None
    assert asyncio.run(player.resolve_stream("Ashfall", "Ragal Ironbull")) is None

    assert len(calls) == 1, "the second request re-ran the whole search + extractions"


def test_the_memory_of_a_failure_expires(monkeypatch):
    calls = _count_youtube_calls(monkeypatch)
    asyncio.run(player.resolve_stream("Ashfall", "Ragal Ironbull"))

    # Walk past the TTL rather than sleeping through it.
    monkeypatch.setattr(player, "YT_FAIL_TTL", 300.0)
    for key in list(player._yt_failed):
        player._yt_failed[key] = time.monotonic() - 1

    asyncio.run(player.resolve_stream("Ashfall", "Ragal Ironbull"))
    assert len(calls) == 2


def test_being_rate_limited_stops_the_youtube_arm_for_every_track(monkeypatch):
    calls = _count_youtube_calls(monkeypatch)
    player.note_youtube_rate_limit("HTTP Error 429: Too Many Requests")

    assert asyncio.run(player.resolve_stream("Ashfall", "Ragal Ironbull")) is None
    assert asyncio.run(player.resolve_stream("Frozen Gods", "Ragal Ironbull")) is None

    assert calls == [], "kept hammering YouTube while it was refusing us"


def test_the_cooldown_lets_go(monkeypatch):
    calls = _count_youtube_calls(monkeypatch)
    monkeypatch.setattr(player, "YT_COOLDOWN", 0.0)
    player.note_youtube_rate_limit("429")

    assert player.youtube_rate_limited() is False
    asyncio.run(player.resolve_stream("Ashfall", "Ragal Ironbull"))
    assert len(calls) == 1


def test_an_owned_track_still_plays_while_we_are_backing_off(monkeypatch):
    """The guard skips the YouTube fallback only — a file on disk is found first, so a
    download finishing mid-cool-down is playable at once."""
    calls = _count_youtube_calls(monkeypatch)
    monkeypatch.setattr(player, "_resolve_local_file",
                        lambda name, artist: {"source": "local", "path": "/music/x.flac"})
    player.note_youtube_rate_limit("429")

    got = asyncio.run(player.resolve_stream("Ashfall", "Ragal Ironbull"))
    assert got == {"source": "local", "path": "/music/x.flac"}
    assert calls == []


def test_yt_dlp_saying_429_puts_us_in_the_cooldown(monkeypatch):
    assert player.youtube_rate_limited() is False
    player._note_ytdlp_stderr("search x", "ERROR: [youtube] HTTP Error 429: Too Many Requests")
    assert player.youtube_rate_limited() is True


def test_an_ordinary_yt_dlp_error_does_not(monkeypatch):
    player._note_ytdlp_stderr("extract x", "ERROR: [youtube] abc: Video unavailable")
    assert player.youtube_rate_limited() is False


def test_the_failure_memory_stays_bounded(monkeypatch):
    monkeypatch.setattr(player, "YT_FAIL_MAX", 10)
    _count_youtube_calls(monkeypatch)
    for i in range(40):
        asyncio.run(player.resolve_stream(f"track {i}", "nobody"))
    assert len(player._yt_failed) <= 10
