"""backfill_in_background leaves a downloaded DJ mix alone, as the sweep does."""
import asyncio

import pytest

from app.services import bpm, library, mixes


@pytest.fixture
def env(monkeypatch):
    calls = {"backfill": [], "find_song_id": 0}
    state = {"mix": False}

    async def fake_find_song_id(name, artist, album=""):
        calls["find_song_id"] += 1
        return "sid"

    async def fake_backfill(entry, song_id, name, artist, **kw):
        calls["backfill"].append((song_id, name, artist))
        return {**entry, "feature_version": bpm.FEATURE_VERSION}

    monkeypatch.setattr(library, "find_song_id", fake_find_song_id)
    monkeypatch.setattr(bpm, "_backfill_features", fake_backfill)
    monkeypatch.setattr(mixes, "is_mix", lambda name, artist: state["mix"])
    monkeypatch.setattr(bpm, "BG_REFRESH_DELAY", 0)
    key = bpm._cache_key("Set", "DJ")
    monkeypatch.setitem(bpm._bpm_cache, key, {"name": "Set", "artist": "DJ", "bpm": 120.0})
    monkeypatch.setattr(bpm, "_bg_backfills", set())
    return calls, state


def _drain():
    async def go():
        while bpm._bg_tasks:
            await asyncio.gather(*list(bpm._bg_tasks))
    return go()


def test_mix_is_not_refreshed(env):
    calls, state = env
    state["mix"] = True

    async def go():
        started = bpm.backfill_in_background("Set", "DJ")
        await _drain()
        return started

    assert asyncio.run(go()) is False
    assert calls["backfill"] == [] and calls["find_song_id"] == 0
    assert not bpm._bg_backfills


def test_normal_track_is_refreshed(env):
    calls, state = env

    async def go():
        started = bpm.backfill_in_background("Set", "DJ")
        await _drain()
        return started

    assert asyncio.run(go()) is True
    assert calls["backfill"] == [("sid", "Set", "DJ")]
