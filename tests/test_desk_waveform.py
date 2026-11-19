"""GET /api/desk/waveform: owned-file waveform, owned:false otherwise, never YouTube."""
import asyncio
import base64
import unicodedata

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import bind_navidrome_creds
from app.routers import desk
from app.services import auth, bpm, clips, mixes, player


def _pcm(parts):
    import numpy as np
    return b"".join(np.full(int(8000 * s), v, dtype="<i2").tobytes() for s, v in parts)


class FakeProc:
    def __init__(self, data):
        self._data, self.returncode = data, 0
        outer = self

        class Out:
            async def read(self, n):
                chunk, outer._data = outer._data[:n], outer._data[n:]
                return chunk
        self.stdout = Out()

    async def wait(self):
        return 0

    def kill(self):
        pass


@pytest.fixture
def env(monkeypatch, tmp_path):
    data = tmp_path / "data"
    monkeypatch.setattr(mixes, "DATA_DIR", data)
    monkeypatch.setattr(clips, "_WAVE_SEM", asyncio.Semaphore(1))
    monkeypatch.setattr(clips, "_wave_tasks", {})
    audio = tmp_path / "Track.flac"
    audio.write_bytes(b"x")
    state = {"file": str(audio), "asked": [], "spawned": 0, "dropped": []}

    def fake_find(name, artist):
        state["asked"].append((name, artist))
        return state["file"]

    async def fake_exec(*argv, **kw):
        state["spawned"] += 1
        return FakeProc(_pcm([(3, 1000), (1, 0), (2, 16000)]))

    monkeypatch.setattr(player, "find_track_file", fake_find)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(bpm, "drop_file_cache", lambda p: state["dropped"].append(p))
    music = tmp_path / "music"
    music.mkdir()
    state["music"] = music
    monkeypatch.setattr(desk, "_music_dir", lambda: str(music))
    monkeypatch.setattr(clips, "_track_memo", {})
    monkeypatch.setattr(clips, "_miss_memo", {})
    app = FastAPI()
    app.include_router(desk.router)
    app.dependency_overrides[auth.get_current_user] = lambda: {"username": "t"}

    async def _no_bind():
        return {"username": "t"}
    app.dependency_overrides[bind_navidrome_creds] = _no_bind
    return TestClient(app), state, data


def test_owned_track_gets_a_waveform(env):
    client, state, data = env
    r = client.get("/api/desk/waveform", params={"name": "T", "artist": "A"})
    assert r.status_code == 200
    j = r.json()
    assert j["step"] == 0.1 and j["duration"] == 6.0
    peaks = base64.b64decode(j["peaks"])
    assert len(peaks) == 60 and max(peaks) == 255 and set(peaks[30:40]) == {0}
    assert list((data / "waveforms").glob("*.json"))
    assert state["dropped"] == [state["file"]]


def test_cache_hit_spawns_no_ffmpeg(env):
    client, state, _ = env
    q = {"name": "T", "artist": "A"}
    a = client.get("/api/desk/waveform", params=q).json()
    assert client.get("/api/desk/waveform", params=q).json() == a
    assert state["spawned"] == 1


def test_no_local_file_is_owned_false_and_no_work(env):
    client, state, _ = env
    state["file"] = None
    r = client.get("/api/desk/waveform", params={"name": "T", "artist": "A"})
    assert r.status_code == 200 and r.json()["owned"] is False
    assert state["spawned"] == 0 and state["dropped"] == []


def test_names_are_folded_to_nfc(env):
    client, state, _ = env
    decomposed = unicodedata.normalize("NFD", "Divoká")
    client.get("/api/desk/waveform", params={"name": decomposed, "artist": decomposed})
    assert state["asked"] == [("Divoká", "Divoká")]


def test_decode_failure_is_502(env, monkeypatch):
    client, state, _ = env

    async def empty(*a, **k):
        return FakeProc(b"")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", empty)
    r = client.get("/api/desk/waveform", params={"name": "T", "artist": "A"})
    assert r.status_code == 502


def test_the_callers_own_copy_comes_first(env):
    """Another user's copy (what the player's lookup answers first) must not be drawn."""
    client, state, _ = env
    own = state["music"] / "t" / "A" / "T.flac"
    own.parent.mkdir(parents=True)
    own.write_bytes(b"x")
    r = client.get("/api/desk/waveform", params={"name": "T", "artist": "A"})
    assert r.status_code == 200 and "peaks" in r.json()
    assert state["asked"] == [], "the player's library-wide lookup was not needed"
    assert state["dropped"] == [str(own)]


def test_not_in_own_folder_falls_back_to_the_players_lookup(env):
    client, state, _ = env
    (state["music"] / "t").mkdir()
    r = client.get("/api/desk/waveform", params={"name": "T", "artist": "A"})
    assert r.status_code == 200 and "peaks" in r.json()
    assert state["asked"] == [("T", "A")]
    assert state["dropped"] == [state["file"]]


def test_cancelled_while_waiting_still_drops_after_the_build_read_the_file(env):
    """A request cancelled while the build waits for the semaphore: the cache is given
    back once ffmpeg has read the file — not before (nothing to drop yet) and not never."""
    _, state, _ = env
    order = []
    real_spawned = asyncio.create_subprocess_exec

    async def spy_exec(*a, **k):
        order.append("read")
        return await real_spawned(*a, **k)

    def spy_drop(p):
        order.append("drop")
        state["dropped"].append(p)

    async def main():
        import app.routers.desk as d
        sem = clips._WAVE_SEM
        await sem.acquire()                       # another build holds the decoder
        asyncio_exec, bpm_drop = asyncio.create_subprocess_exec, bpm.drop_file_cache
        asyncio.create_subprocess_exec, bpm.drop_file_cache = spy_exec, spy_drop
        try:
            req = asyncio.create_task(d.desk_waveform(name="T", artist="A", user={"username": "t"}))
            for _ in range(20):
                await asyncio.sleep(0.01)
            assert not req.done()
            req.cancel()
            with pytest.raises(asyncio.CancelledError):
                await req
            assert order == [], "nothing read yet, nothing dropped yet"
            sem.release()
            for _ in range(200):
                if "drop" in order:
                    break
                await asyncio.sleep(0.01)
            # the build and the drop outlived the request
            assert order == ["read", "drop"]
            assert not d._pending_drops
        finally:
            asyncio.create_subprocess_exec, bpm.drop_file_cache = asyncio_exec, bpm_drop
    asyncio.run(main())
    assert state["dropped"] == [state["file"]]
