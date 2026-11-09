"""Tests for slskd API robustness: retries, empty bodies, enqueue payload/encoding, peer fallback."""
import asyncio
import json
import sys
import types

import httpx
import pytest

from app.services import downloader

_RealAsyncClient = httpx.AsyncClient
_real_sleep = asyncio.sleep


async def _no_sleep(*_args, **_kwargs):
    return None


@pytest.fixture
def slskd(monkeypatch, tmp_path):
    """Route downloader's httpx calls to a handler; returns a dict to install it and read calls."""
    state = {"handler": None, "calls": []}

    async def dispatch(request: httpx.Request) -> httpx.Response:
        state["calls"].append(request)
        return await state["handler"](request)

    def make_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(dispatch)
        return _RealAsyncClient(*args, **kwargs)

    monkeypatch.setattr(downloader.httpx, "AsyncClient", make_client)
    monkeypatch.setattr(downloader.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(downloader, "MUSIC_DIR", str(tmp_path / "music"))
    # BPM tagging is best-effort and irrelevant here; keep librosa out of the test.
    fake_bpm = types.ModuleType("app.services.bpm")

    async def analyze_and_tag(*_a, **_k):
        return None

    fake_bpm.analyze_and_tag = analyze_and_tag
    monkeypatch.setitem(sys.modules, "app.services.bpm", fake_bpm)
    import app.services as services_pkg
    monkeypatch.setattr(services_pkg, "bpm", fake_bpm, raising=False)
    return state


# --- _slskd_api ---


def test_retries_429_then_succeeds(slskd):
    codes = iter([429, 503, 200])

    async def handler(request):
        return httpx.Response(next(codes), json={"ok": True})

    slskd["handler"] = handler
    assert asyncio.run(downloader._slskd_api("GET", "searches/abc")) == {"ok": True}
    assert len(slskd["calls"]) == 3


def test_gives_up_after_retries(slskd):
    async def handler(request):
        return httpx.Response(429, text="Only one concurrent operation is permitted")

    slskd["handler"] = handler
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(downloader._slskd_api("GET", "searches/abc"))
    assert len(slskd["calls"]) == downloader._SLSKD_RETRIES + 1


def test_non_retryable_error_is_not_retried(slskd):
    async def handler(request):
        return httpx.Response(500, text="boom")

    slskd["handler"] = handler
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(downloader._slskd_api("POST", "transfers/downloads/peer", [{}]))
    assert len(slskd["calls"]) == 1


def test_empty_body_returns_none(slskd):
    async def handler(request):
        return httpx.Response(201)

    slskd["handler"] = handler
    assert asyncio.run(downloader._slskd_api("POST", "transfers/downloads/peer", [{}])) is None


# --- enqueue ---


def test_enqueue_encodes_peer_and_sends_minimal_payload(slskd):
    async def handler(request):
        return httpx.Response(201, json={"enqueued": [], "failed": []})

    slskd["handler"] = handler
    file_info = {"filename": r"Music\Artist\Song.mp3", "size": 5_000_000, "bitRate": 320,
                 "isLocked": False, "extension": "mp3", "length": 200}
    asyncio.run(downloader._slskd_enqueue("dj shadow/remix #1?", file_info))

    request = slskd["calls"][0]
    assert request.method == "POST"
    assert request.url.raw_path == b"/api/v0/transfers/downloads/dj%20shadow%2Fremix%20%231%3F"
    assert json.loads(request.content) == [{"filename": r"Music\Artist\Song.mp3", "size": 5_000_000}]


def test_enqueue_lock_serializes_concurrent_calls(slskd, monkeypatch):
    monkeypatch.setattr(downloader.asyncio, "sleep", _real_sleep)
    in_flight = {"now": 0, "max": 0}

    async def handler(request):
        in_flight["now"] += 1
        in_flight["max"] = max(in_flight["max"], in_flight["now"])
        await _real_sleep(0.01)
        in_flight["now"] -= 1
        return httpx.Response(201)

    slskd["handler"] = handler

    async def run_three():
        await asyncio.gather(*(
            downloader._slskd_enqueue(f"peer{i}", {"filename": f"song{i}.mp3", "size": 1})
            for i in range(3)
        ))

    asyncio.run(run_three())
    assert len(slskd["calls"]) == 3
    assert in_flight["max"] == 1


# --- _download_track_slskd ---


def _search_handler(peers, *, enqueue_status=None, transfer_state=None):
    """Fake slskd: one completed search returning `peers`; per-peer enqueue status / transfer state."""
    enqueue_status = enqueue_status or {}
    transfer_state = transfer_state or {}
    enqueued = []

    async def handler(request):
        path = request.url.path
        if request.method == "POST" and path == "/api/v0/searches":
            return httpx.Response(200, json={"id": "s1"})
        if request.method == "GET" and path == "/api/v0/searches/s1":
            return httpx.Response(200, json={"state": "Completed, Succeeded"})
        if request.method == "GET" and path == "/api/v0/searches/s1/responses":
            return httpx.Response(200, json=[
                {"username": name, "files": [{"filename": fname, "size": 6_000_000, "bitRate": br}]}
                for name, fname, br in peers
            ])
        if path.startswith("/api/v0/transfers/downloads/"):
            peer = path.rsplit("/", 1)[-1]
            if request.method == "POST":
                enqueued.append(peer)
                code = enqueue_status.get(peer, 201)
                return httpx.Response(code, text="" if code < 400 else "peer offline")
            files = [{"filename": f, "state": transfer_state.get(n, "Completed, Succeeded")}
                     for n, f, _ in peers if n == peer]
            return httpx.Response(200, json={"username": peer, "directories": [{"files": files}]})
        return httpx.Response(404)

    handler.enqueued = enqueued
    return handler


def _completed_file(tmp_path, name):
    d = tmp_path / "slskd-downloads"
    d.mkdir(exist_ok=True)
    f = d / name
    f.write_bytes(b"audio")
    return str(f)


def test_enqueue_failure_falls_back_to_next_peer(slskd, tmp_path, monkeypatch):
    handler = _search_handler(
        [("best", r"a\Song.mp3", 320), ("second", r"b\Song.mp3", 256)],
        enqueue_status={"best": 500},
    )
    slskd["handler"] = handler
    found = _completed_file(tmp_path, "Song.mp3")
    monkeypatch.setattr(downloader, "_find_completed_slskd_file", lambda _b: found)

    ok = asyncio.run(downloader._download_track_slskd("Artist", "Song", "Album", "mp3"))

    assert ok is True
    assert handler.enqueued == ["best", "second"]
    assert (tmp_path / "music" / "Artist" / "Album" / "Song.mp3").exists()


def test_failed_transfer_falls_back_to_next_peer(slskd, tmp_path, monkeypatch):
    handler = _search_handler(
        [("best", r"a\Song.mp3", 320), ("second", r"b\Song.mp3", 256)],
        transfer_state={"best": "Completed, Rejected"},
    )
    slskd["handler"] = handler
    found = _completed_file(tmp_path, "Song.mp3")
    monkeypatch.setattr(downloader, "_find_completed_slskd_file", lambda _b: found)

    ok = asyncio.run(downloader._download_track_slskd("Artist", "Song", "Album", "mp3"))

    assert ok is True
    assert handler.enqueued == ["best", "second"]


def test_peer_fallback_is_capped(slskd, monkeypatch):
    peers = [(f"p{i:02d}", rf"x\Song{i}.mp3", 320 - i) for i in range(12)]
    handler = _search_handler(peers, enqueue_status={name: 500 for name, _, _ in peers})
    slskd["handler"] = handler

    ok = asyncio.run(downloader._download_track_slskd("Artist", "Song", "Album", "mp3"))

    assert ok is False
    assert len(handler.enqueued) == downloader._SLSKD_MAX_PEER_TRIES


def test_search_errors_return_false_instead_of_raising(slskd):
    async def handler(request):
        return httpx.Response(500, text="boom")

    slskd["handler"] = handler
    assert asyncio.run(downloader._download_track_slskd("Artist", "Song", "Album", "mp3")) is False


def test_empty_search_response_returns_false(slskd):
    async def handler(request):
        return httpx.Response(200)

    slskd["handler"] = handler
    assert asyncio.run(downloader._download_track_slskd("Artist", "Song", "Album", "mp3")) is False
