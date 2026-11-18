"""GET /api/bpm/track answers a track with no audio source cheaply and truthfully.

Ownership is decided by the server with the sources the analysis itself uses
(a Navidrome id, a local file). The analysis is replaced by a tripwire so these
tests never touch madmom, Navidrome or the disk.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import bind_navidrome_creds
from app.routers import bpm as bpm_router
from app.services import auth, bpm, library


@pytest.fixture
def env(monkeypatch):
    calls = {"analyze": [], "find_song_id": 0, "find_file": 0}
    state = {"song_id": None, "file": None}

    async def fake_find_song_id(name, artist, album=""):
        calls["find_song_id"] += 1
        return state["song_id"]

    def fake_find_file(name, artist):
        calls["find_file"] += 1
        return state["file"]

    async def fake_analyze(song_id, name, artist, force=False):
        calls["analyze"].append((song_id, name, artist))
        return {"name": name, "artist": artist, "bpm": 120.0, "feature_version": bpm.FEATURE_VERSION}

    monkeypatch.setattr(library, "find_song_id", fake_find_song_id)
    monkeypatch.setattr(bpm, "find_track_file", fake_find_file)
    monkeypatch.setattr(bpm, "analyze_track", fake_analyze)
    monkeypatch.setattr(bpm, "get_cached_bpm", lambda n, a: None)
    bpm_router._not_owned.clear()

    app = FastAPI()
    app.include_router(bpm_router.router)
    app.dependency_overrides[auth.get_current_user] = lambda: {"username": "t"}

    async def _no_bind():
        return {"username": "t"}
    app.dependency_overrides[bind_navidrome_creds] = _no_bind
    return TestClient(app), calls, state


def test_unowned_track_gets_200_owned_false_and_no_analysis(env):
    client, calls, _ = env
    r = client.get("/api/bpm/track", params={"name": "Nope", "artist": "Nobody"})
    assert r.status_code == 200
    assert r.json()["owned"] is False
    assert calls["analyze"] == []


def test_second_ask_for_unowned_track_does_no_lookup(env):
    client, calls, _ = env
    p = {"name": "Nope", "artist": "Nobody"}
    client.get("/api/bpm/track", params=p)
    first = (calls["find_song_id"], calls["find_file"])
    r = client.get("/api/bpm/track", params={"name": "NOPE", "artist": "nobody"})
    assert r.json()["owned"] is False
    assert (calls["find_song_id"], calls["find_file"]) == first == (1, 1)


def test_negative_entry_expires(env, monkeypatch):
    client, calls, _ = env
    p = {"name": "Nope", "artist": "Nobody"}
    client.get("/api/bpm/track", params=p)
    for k in list(bpm_router._not_owned):
        bpm_router._not_owned[k] = 0.0  # already expired
    client.get("/api/bpm/track", params=p)
    assert calls["find_song_id"] == 2


def test_navidrome_track_is_analysed(env):
    client, calls, state = env
    state["song_id"] = "sid-1"
    r = client.get("/api/bpm/track", params={"name": "A", "artist": "B"})
    assert r.status_code == 200 and r.json()["bpm"] == 120.0
    assert calls["analyze"] == [("sid-1", "A", "B")]


def test_local_file_without_navidrome_id_is_still_analysed(env):
    # downloaded but not yet scanned by Navidrome: owned, so it must not be refused
    client, calls, state = env
    state["file"] = "/music/x.flac"
    r = client.get("/api/bpm/track", params={"name": "A", "artist": "B"})
    assert r.status_code == 200 and r.json().get("bpm") == 120.0
    assert len(calls["analyze"]) == 1


def test_owned_track_whose_analysis_fails_is_not_negative_cached(env, monkeypatch):
    client, calls, state = env
    state["song_id"] = "sid-1"

    async def failing(*a, **k):
        return None
    monkeypatch.setattr(bpm, "analyze_track", failing)
    r = client.get("/api/bpm/track", params={"name": "A", "artist": "B"})
    assert r.status_code == 404
    assert bpm_router._not_owned == {}


def test_negative_cache_is_bounded(env, monkeypatch):
    client, _, _ = env
    monkeypatch.setattr(bpm_router, "NOT_OWNED_MAX", 5)
    for i in range(20):
        client.get("/api/bpm/track", params={"name": f"n{i}", "artist": "x"})
    assert len(bpm_router._not_owned) <= 5


def test_playlist_entries_are_marked_owned(monkeypatch):
    import asyncio
    import httpx

    payload = {"subsonic-response": {"status": "ok", "playlist": {
        "id": "p", "name": "n", "entry": [{"id": "1", "title": "t", "artist": "a"}]}}}

    class FakeClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, *a, **k):
            return httpx.Response(200, json=payload, request=httpx.Request("GET", "http://x"))

    monkeypatch.setattr(library, "NAVIDROME_PASSWORD", "x")
    monkeypatch.setattr(library.httpx, "AsyncClient", FakeClient)
    pl = asyncio.run(library.get_playlist("p"))
    assert pl["tracks"][0]["owned"] is True


# ── review round 2 ──

def test_stale_cached_entry_without_audio_is_returned_not_owned_false(env, monkeypatch):
    client, calls, _ = env
    stale = {"name": "Stara", "artist": "Skladba", "bpm": 128.0}  # no feature_version
    monkeypatch.setattr(bpm, "get_cached_bpm", lambda n, a: stale)
    r = client.get("/api/bpm/track", params={"name": "Stara", "artist": "Skladba"})
    assert r.status_code == 200 and r.json() == stale
    assert bpm_router._not_owned == {}


def test_a_stale_entry_is_answered_at_once_and_refreshed_behind(env, monkeypatch):
    # The player asks this before it starts a track: a feature refresh must not hold it.
    client, calls, _ = env
    stale = {"name": "Stara", "artist": "Skladba", "bpm": 88.0, "energy": 0.6, "feature_version": bpm.FEATURE_VERSION - 1}
    monkeypatch.setattr(bpm, "get_cached_bpm", lambda n, a: stale)
    kicked = []
    monkeypatch.setattr(bpm, "backfill_in_background", lambda n, a: kicked.append((n, a)))
    r = client.get("/api/bpm/track", params={"name": "Stara", "artist": "Skladba"})
    assert r.status_code == 200 and r.json() == stale
    assert kicked == [("Stara", "Skladba")] and calls["analyze"] == [] and calls["find_song_id"] == 0


def test_force_bypasses_negative_cache(env):
    client, calls, state = env
    p = {"name": "N", "artist": "A"}
    assert client.get("/api/bpm/track", params=p).json()["owned"] is False
    state["file"] = "/music/x.flac"  # downloaded meanwhile
    r = client.get("/api/bpm/track", params={**p, "force": "true"})
    assert r.json().get("bpm") == 120.0
    assert len(calls["analyze"]) == 1


def test_client_song_id_does_not_skip_the_ownership_check(env):
    client, calls, _ = env
    r = client.get("/api/bpm/track", params={"name": "N", "artist": "A", "song_id": "whatever"})
    assert r.json()["owned"] is False
    assert calls["analyze"] == []
    assert calls["find_song_id"] == 1


def test_negative_key_keeps_artists_apart(env):
    client, calls, state = env
    assert client.get("/api/bpm/track", params={"name": "Intro", "artist": "Nobody"}).json()["owned"] is False
    state["song_id"] = "sid-2"
    r = client.get("/api/bpm/track", params={"name": "Intro", "artist": "Somebody"})
    assert r.json().get("bpm") == 120.0
    assert calls["analyze"] == [("sid-2", "Intro", "Somebody")]


def test_negative_ttl_is_the_documented_300_seconds(env, monkeypatch):
    client, calls, _ = env
    now = [1000.0]
    monkeypatch.setattr(bpm_router.time, "monotonic", lambda: now[0])
    p = {"name": "T", "artist": "A"}
    client.get("/api/bpm/track", params=p)
    now[0] += 299
    client.get("/api/bpm/track", params=p)
    assert calls["find_song_id"] == 1  # still remembered
    now[0] += 2
    client.get("/api/bpm/track", params=p)
    assert calls["find_song_id"] == 2  # expired after 300 s


def test_long_names_do_not_grow_the_key(env):
    client, _, _ = env
    client.get("/api/bpm/track", params={"name": "x" * 20000, "artist": "y" * 20000})
    (k,) = bpm_router._not_owned
    assert len(k[0]) <= 200 and len(k[1]) <= 200


def test_zero_cap_does_not_crash(env, monkeypatch):
    client, _, _ = env
    monkeypatch.setattr(bpm_router, "NOT_OWNED_MAX", 0)
    for i in range(2):
        r = client.get("/api/bpm/track", params={"name": f"z{i}", "artist": "q"})
        assert r.status_code == 200 and r.json()["owned"] is False


def test_file_walk_runs_off_the_event_loop(env, monkeypatch):
    import threading
    client, _, _ = env
    loop_thread, walk_thread = [], []

    async def on_loop(name, artist, album=""):
        loop_thread.append(threading.get_ident())
        return None

    def walk(name, artist):
        walk_thread.append(threading.get_ident())
        return None
    monkeypatch.setattr(library, "find_song_id", on_loop)
    monkeypatch.setattr(bpm, "find_track_file", walk)
    client.get("/api/bpm/track", params={"name": "W", "artist": "A"})
    assert loop_thread and walk_thread
    assert walk_thread[0] != loop_thread[0]
