"""Clips: cutting a passage out of a downloaded set into an ordinary library track.
No ffmpeg on the test machine (or the CI one): every subprocess is a fake."""
import asyncio
import base64
import json
import os
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mutagen.flac import FLAC

from app import dependencies
from app.dependencies import bind_navidrome_creds
from app.routers import clips as clips_router
from app.services import auth, clips, downloader, mixes, player

SET_SECONDS = 120


class FakeProc:
    def __init__(self, stdout=b"", rc=0, pieces=None, on_run=None, hang=False, gate=None):
        self._data, self.returncode, self._rc = stdout, None, rc
        self._pieces = pieces
        self._on_run = on_run
        self.killed = False
        self._hang, self._gate = hang, gate
        self.stdout = self

    async def read(self, n):
        await asyncio.sleep(0)
        if self._hang:
            await asyncio.sleep(3600)
        if self._gate is not None:
            await self._gate.wait()
        if not self._data:
            return b""
        size = self._pieces.pop(0) if self._pieces else n
        size = min(size, n)
        out, self._data = self._data[:size], self._data[size:]
        return out

    async def communicate(self):
        if self._hang:
            await asyncio.sleep(3600)
        if self._on_run:
            self._on_run()
        self.returncode = self._rc
        return self._data, b"boom"

    async def wait(self):
        if self.returncode is None:
            self.returncode = self._rc
        return self.returncode

    def kill(self):
        self.killed = True


def _pcm(seconds_amp):
    """s16le at 8 kHz: [(seconds, amplitude), ...]."""
    return b"".join(np.full(int(s * 8000), a, dtype="<i2").tobytes() for s, a in seconds_amp)


@pytest.fixture
def env(monkeypatch, tmp_path):
    music = tmp_path / "music"
    data = tmp_path / "data"
    music.mkdir()
    monkeypatch.setenv("MUSIC_DIR", str(music))
    monkeypatch.setattr(mixes, "DATA_DIR", data)
    monkeypatch.setattr(mixes, "REGISTRY_FILE", data / "mixes.json")
    monkeypatch.setattr(mixes, "_registry", None)
    monkeypatch.setattr(player, "MUSIC_DIR", music)
    spawned, procs = [], []
    state = {"cut_rc": 0, "cut_writes": True, "wave": _pcm([(3, 1000), (1, 0), (2, 16000)]), "wave_rc": 0,
             "pieces": None, "wave_hang": False, "cut_hang": False, "gate": None}
    # Module-level semaphores bind to the first loop that waits on them; each test has its own.
    monkeypatch.setattr(clips, "_WAVE_SEM", asyncio.Semaphore(1))
    monkeypatch.setattr(clips, "_BEATS_SEM", asyncio.Semaphore(2))
    monkeypatch.setattr(clips, "_wave_tasks", {})
    monkeypatch.setattr(downloader, "_check_quota", lambda username: True)

    def write_flac(path):
        sf.write(path, np.zeros(8000 * 12, dtype="int16"), 8000, format="FLAC")

    async def fake_exec(*argv, **kw):
        spawned.append(argv)
        if "s16le" in argv:
            proc = FakeProc(state["wave"], state["wave_rc"], pieces=list(state["pieces"] or []),
                            hang=state["wave_hang"], gate=state["gate"])
        elif "f32le" in argv:
            proc = FakeProc(b"", 1)
        else:
            out = argv[-1]
            proc = FakeProc(rc=state["cut_rc"], hang=state["cut_hang"],
                            on_run=lambda: state["cut_writes"] and write_flac(out))
        procs.append(proc)
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    async def no_scan():
        return None
    monkeypatch.setattr(downloader, "_trigger_navidrome_scan", no_scan)

    def make_mix(user="alice", dj="DJ Alpha", name="Set.flac"):
        d = music / user / dj / "DJ Sets"
        d.mkdir(parents=True, exist_ok=True)
        p = d / name
        sf.write(str(p), np.zeros(8000 * SET_SECONDS, dtype="int16"), 8000, format="FLAC")
        f = FLAC(str(p))
        f["title"], f["artist"], f["comment"] = ["Sunday set"], ["DJ Alpha"], ["https://www.mixcloud.com/a/b/"]
        f.save()
        return p

    # /audio authenticates by query token, the way /api/player/stream does.
    monkeypatch.setattr(auth, "_decode_token", lambda t: {"sub": t} if t in ("alice", "bob") else None)
    monkeypatch.setattr(auth, "_load_users", lambda: {"alice": {}, "bob": {}})

    async def no_creds(user):
        return None
    monkeypatch.setattr(dependencies, "_resolve_navidrome_creds", no_creds)

    app = FastAPI()
    app.include_router(clips_router.router)
    who = {"username": "alice"}
    app.dependency_overrides[auth.get_current_user] = lambda: who

    async def _no_bind():
        return who
    app.dependency_overrides[bind_navidrome_creds] = _no_bind
    return type("Env", (), dict(music=music, data=data, spawned=spawned, procs=procs, state=state, make_mix=staticmethod(make_mix),
                                client=TestClient(app), who=who))


def _body(**kw):
    b = {"dj": "DJ Alpha", "file": "Set.flac", "start": 10, "end": 40, "title": "Drop", "artist": ""}
    b.update(kw)
    return b


def _no_scratch(env):
    return not (env.music / ".clip-dl").exists() or not list((env.music / ".clip-dl").iterdir())


# ── waveform ──

def test_waveform_buckets_are_normalised_and_silence_is_zero(env):
    env.make_mix()
    r = env.client.get("/api/clips/waveform", params={"dj": "DJ Alpha", "file": "Set.flac"})
    assert r.status_code == 200
    j = r.json()
    peaks = base64.b64decode(j["peaks"])
    assert j["rate"] == 10 and j["duration"] == 6.0
    assert len(peaks) == 60
    assert max(peaks) == 255
    assert set(peaks[30:40]) == {0}                      # the silent second
    assert peaks[0] == round(1000 * 255 / 16000)         # relative dynamics kept


def test_reducer_takes_pieces_that_split_a_sample(env):
    pcm = _pcm([(2, 1000), (1, 0), (1, 16000)])
    whole = clips.PeakReducer()
    whole.feed(pcm)
    odd = clips.PeakReducer()
    for i in range(0, len(pcm), 7):                      # 7 bytes: splits samples and buckets
        odd.feed(pcm[i:i + 7])
    assert odd.result() == whole.result()
    assert whole.result()[0] == 4.0


def test_the_decoded_stream_is_reduced_in_chunks(env, monkeypatch):
    env.make_mix()
    env.state["wave"] = _pcm([(10, 5000)])               # 160 kB, far above one chunk
    sizes = []
    orig = clips.PeakReducer.feed

    def spy(self, data):
        sizes.append(len(data))
        return orig(self, data)
    monkeypatch.setattr(clips.PeakReducer, "feed", spy)
    env.state["pieces"] = [3, 5001, 17]                  # odd-sized pieces first
    assert env.client.get("/api/clips/waveform", params={"dj": "DJ Alpha", "file": "Set.flac"}).status_code == 200
    assert len(sizes) > 3 and max(sizes) <= clips.READ_CHUNK


def test_waveform_cache_hit_spawns_no_ffmpeg(env):
    env.make_mix()
    q = {"dj": "DJ Alpha", "file": "Set.flac"}
    a = env.client.get("/api/clips/waveform", params=q).json()
    assert len(env.spawned) == 1
    assert list((env.data / "waveforms").glob("*.json"))
    assert env.client.get("/api/clips/waveform", params=q).json() == a
    assert len(env.spawned) == 1


def test_concurrent_waveform_requests_share_one_ffmpeg(env):
    p = env.make_mix()
    async def both():
        return await asyncio.gather(clips.get_waveform(str(p)), clips.get_waveform(str(p)))
    out = asyncio.run(both())
    assert out[0] == out[1] and len(env.spawned) == 1


def test_waveform_failure_is_a_502_and_not_cached(env):
    env.make_mix()
    env.state["wave_rc"] = 1
    r = env.client.get("/api/clips/waveform", params={"dj": "DJ Alpha", "file": "Set.flac"})
    assert r.status_code == 502
    env.state.update(wave_rc=0, wave=b"")
    assert env.client.get("/api/clips/waveform", params={"dj": "DJ Alpha", "file": "Set.flac"}).status_code == 502
    assert not (env.data / "waveforms").exists() or not list((env.data / "waveforms").glob("*.json"))


def test_waveform_refuses_traversal_and_missing(env):
    env.make_mix()
    for dj, f in (("..", "Set.flac"), ("DJ Alpha", "../Set.flac"), (".hidden", "Set.flac"), ("DJ Alpha", "a.txt")):
        assert env.client.get("/api/clips/waveform", params={"dj": dj, "file": f}).status_code == 400
    assert env.client.get("/api/clips/waveform", params={"dj": "DJ Alpha", "file": "None.flac"}).status_code == 404


def test_beats_answer_is_empty_when_decoding_fails(env):
    env.make_mix()
    r = env.client.get("/api/clips/beats", params={"dj": "DJ Alpha", "file": "Set.flac", "t": 50})
    assert r.status_code == 200 and r.json() == {"bpm": None, "beats": []}
    ss = env.spawned[0][env.spawned[0].index("-ss") + 1]
    assert ss == "35.000"
    env.client.get("/api/clips/beats", params={"dj": "DJ Alpha", "file": "Set.flac", "t": 3})
    assert env.spawned[1][env.spawned[1].index("-ss") + 1] == "0.000"      # clamped


# ── create ──

def test_a_clip_is_cut_tagged_and_found_by_the_player(env):
    mix = env.make_mix()
    r = env.client.post("/api/clips", json=_body(title="Drop: the  best?"))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["album"] == "Clips" and j["artist"] == "DJ Alpha" and j["dir"] == "DJ Alpha"
    assert j["file"] == player._sanitize(player.nfc("Drop: the  best?")) + ".flac"
    path = env.music / "alice" / "DJ Alpha" / "Clips" / j["file"]
    assert path.is_file()
    t = FLAC(str(path))
    assert t["title"] == ["Drop: the  best?"] and t["albumartist"] == ["DJ Alpha"] and t["album"] == ["Clips"]
    assert t["comment"][0].startswith("msclip|Sunday set|DJ Alpha|10.000|40.000|FLAC")
    assert player._resolve_local_file(j["name"], j["artist"])["path"] == str(path)
    cmd = env.spawned[-1]
    assert cmd[cmd.index("-ss") + 1] == "10.000" and cmd[cmd.index("-t") + 1] == "30.000"
    assert "afade=t=out:st=29.995:d=0.005" in cmd[cmd.index("-af") + 1]
    assert _no_scratch(env)
    assert mix.is_file()
    assert not mixes.is_mix(j["name"], j["artist"])    # stays out of the mixes registry


def test_decomposed_title_is_folded(env):
    env.make_mix()
    r = env.client.post("/api/clips", json=_body(title="Divoká"))
    assert r.json()["file"] == "Divoká.flac"


def test_duplicate_is_409(env):
    env.make_mix()
    assert env.client.post("/api/clips", json=_body()).status_code == 200
    r = env.client.post("/api/clips", json=_body())
    assert r.status_code == 409 and "already exists" in r.json()["detail"]


@pytest.mark.parametrize("start,end", [(0, 9.9), (0, 1201), (-1, 30), (30, 30), (50, 20), (100, 130), (0, float("inf"))])
def test_length_and_range_limits(env, start, end):
    env.make_mix()
    r = env.client.post("/api/clips", content=json.dumps(_body(start=start, end=end), allow_nan=True),
                        headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert env.spawned == [] and _no_scratch(env)


def test_a_clip_to_the_very_end_is_allowed(env):
    env.make_mix()
    assert env.client.post("/api/clips", json=_body(start=100, end=SET_SECONDS + 0.4)).status_code == 200


@pytest.mark.parametrize("over", [
    {"title": "   "}, {"title": ".."}, {"title": ".hidden"}, {"title": "x" * 300},
    {"artist": ".."}, {"artist": ".hidden"}, {"dj": "../bob"}, {"file": "../../etc/passwd"},
    {"dj": "DJ Alpha/..", "file": "Set.flac"},
])
def test_traversal_and_bad_names_are_refused(env, over):
    env.make_mix()
    r = env.client.post("/api/clips", json=_body(**over))
    assert r.status_code == 400
    assert env.spawned == []
    assert [p for p in env.music.rglob("*") if p.suffix == ".flac" and "Clips" in p.parts] == []


def test_slashes_in_title_and_artist_cannot_escape(env):
    env.make_mix()
    r = env.client.post("/api/clips", json=_body(title="x/../../y", artist="a/../../b"))
    assert r.status_code == 200
    p = env.music / "alice" / r.json()["dir"] / "Clips" / r.json()["file"]
    assert p.is_file() and p.resolve().is_relative_to((env.music / "alice").resolve())


def test_another_users_mix_cannot_be_cut(env):
    env.make_mix(user="bob")
    assert env.client.post("/api/clips", json=_body()).status_code == 404
    assert env.client.get("/api/clips/waveform", params={"dj": "DJ Alpha", "file": "Set.flac"}).status_code == 404
    assert env.spawned == []


def test_a_symlinked_artist_folder_cannot_leave_the_users_folder(env, tmp_path):
    env.make_mix()
    outside = tmp_path / "outside"
    outside.mkdir()
    (env.music / "alice" / "Evil").symlink_to(outside)
    r = env.client.post("/api/clips", json=_body(artist="Evil"))
    assert r.status_code == 400 and not list(outside.rglob("*"))


def test_failed_ffmpeg_leaves_nothing(env):
    env.make_mix()
    env.state["cut_rc"] = 1
    assert env.client.post("/api/clips", json=_body()).status_code == 502
    env.state.update(cut_rc=0, cut_writes=False)
    assert env.client.post("/api/clips", json=_body()).status_code == 502
    assert not (env.music / "alice" / "DJ Alpha" / "Clips").exists() and _no_scratch(env)


def test_a_title_equal_to_a_downloaded_set_is_refused(env):
    p = env.make_mix()
    mixes.remember_mix({"title": "Sunday set", "uploader": "DJ Alpha", "url": "u", "source": "mixcloud"}, str(p), "AAC")
    r = env.client.post("/api/clips", json=_body(title="Sunday set"))
    assert r.status_code == 400 and "same title as a downloaded set" in r.json()["detail"]


# ── list / delete ──

def _make_clip(env, title="Drop", **kw):
    r = env.client.post("/api/clips", json=_body(title=title, **kw))
    assert r.status_code == 200, r.text
    return r.json()


def test_list_shows_only_marked_files_newest_first(env):
    env.make_mix()
    a = _make_clip(env, "First")
    b = _make_clip(env, "Second")
    os.utime(env.music / "alice" / a["dir"] / "Clips" / a["file"], (1, 1))
    real = env.music / "alice" / "Some Band" / "Clips"          # a real album called "Clips"
    real.mkdir(parents=True)
    sf.write(str(real / "song.flac"), np.zeros(800, dtype="int16"), 8000, format="FLAC")
    f = FLAC(str(real / "song.flac"))
    f["comment"] = ["nice record"]
    f.save()
    (env.music / "bob" / "X" / "Clips").mkdir(parents=True)
    j = env.client.get("/api/clips").json()
    assert [c["title"] for c in j["clips"]] == ["Second", "First"] and j["count"] == 2
    c = j["clips"][0]
    assert (c["source_title"], c["source_artist"], c["start"], c["end"]) == ("Sunday set", "DJ Alpha", 10.0, 40.0)
    assert {"dir", "file", "duration", "size", "modified"} <= set(c)
    assert b["file"] == c["file"]


def test_delete_prunes_empty_folders_but_not_others(env):
    env.make_mix()
    a = _make_clip(env, "One")
    b = _make_clip(env, "Two")
    root = env.music / "alice" / "DJ Alpha"
    r = env.client.request("DELETE", "/api/clips", json={"dir": a["dir"], "file": a["file"]})
    assert r.status_code == 200 and r.json() == {"status": "deleted"}
    assert (root / "Clips" / b["file"]).is_file()
    env.client.request("DELETE", "/api/clips", json={"dir": b["dir"], "file": b["file"]})
    assert not (root / "Clips").exists()
    assert (root / "DJ Sets" / "Set.flac").is_file()             # the artist folder still holds the set
    # a Clips folder that holds other content survives, and so does the artist folder
    c = _make_clip(env, "Three")
    (root / "Clips" / "notes.txt").write_text("keep")
    env.client.request("DELETE", "/api/clips", json={"dir": c["dir"], "file": c["file"]})
    assert (root / "Clips" / "notes.txt").is_file()


def test_delete_refuses_unmarked_files_traversal_and_reports_missing(env):
    env.make_mix()
    real = env.music / "alice" / "Band" / "Clips"
    real.mkdir(parents=True)
    sf.write(str(real / "song.flac"), np.zeros(800, dtype="int16"), 8000, format="FLAC")
    d = lambda **kw: env.client.request("DELETE", "/api/clips", json=kw)
    assert d(dir="Band", file="song.flac").status_code == 400
    assert (real / "song.flac").is_file()
    assert d(dir="..", file="x.flac").status_code == 400
    assert d(dir="Band", file="../song.flac").status_code == 400
    assert d(dir="DJ Alpha", file="Set.flac").status_code == 404      # not under Clips/
    assert d(dir="Band", file="none.flac").status_code == 404


# ── /audio: what you hear is what you cut ──

def _audio(env, token="alice", **q):
    params = {"dj": "DJ Alpha", "file": "Set.flac", **q}
    if token:
        params["token"] = token
    return env.client.get("/api/clips/audio", params=params, headers=q.pop("headers", None))


def test_audio_serves_the_set_with_range(env):
    env.make_mix()
    r = _audio(env)
    assert r.status_code == 200 and r.headers["content-type"] == "audio/flac"
    r = env.client.get("/api/clips/audio", params={"dj": "DJ Alpha", "file": "Set.flac", "token": "alice"},
                       headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100


def test_audio_media_type_follows_the_extension(env):
    for name, mt in (("a.m4a", "audio/mp4"), ("a.mp3", "audio/mpeg"), ("a.opus", "audio/ogg"),
                     ("a.wav", "audio/wav"), ("a.aac", "audio/aac"), ("a.webm", "application/octet-stream")):
        d = env.music / "alice" / "DJ Alpha" / "DJ Sets"
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(b"x" * 10)
        assert _audio(env, file=name).headers["content-type"].startswith(mt), name


def test_audio_needs_a_token_and_stays_in_the_owners_folder(env):
    env.make_mix(user="bob")
    assert _audio(env, token="").status_code == 401
    assert _audio(env, token="nobody").status_code == 401
    assert _audio(env, token="alice").status_code == 404          # bob's set, alice's token
    assert _audio(env, token="bob").status_code == 200
    env.make_mix()
    assert _audio(env, dj="..").status_code == 400
    assert _audio(env, file="../Set.flac").status_code == 400
    assert _audio(env, file="a.txt").status_code == 400


def test_other_clip_routes_still_need_header_auth(env):
    # the router no longer carries bind_navidrome_creds as a whole: each route does
    app = FastAPI()
    app.include_router(clips_router.router)
    c = TestClient(app)
    assert c.get("/api/clips").status_code == 401
    assert c.get("/api/clips/waveform", params={"dj": "x", "file": "y.flac", "token": "alice"}).status_code == 401


# ── create: refusals ──

def test_a_clip_cannot_shadow_a_real_track(env):
    env.make_mix()
    real = env.music / "alice" / "DJ Alpha" / "Album"
    real.mkdir(parents=True)
    sf.write(str(real / "Drop.flac"), np.zeros(800, dtype="int16"), 8000, format="FLAC")
    r = env.client.post("/api/clips", json=_body(title="Drop"))
    assert r.status_code == 409 and "already exists in the library" in r.json()["detail"]
    assert env.spawned == []


def test_quota_refusal_is_507_and_cuts_nothing(env, monkeypatch):
    env.make_mix()
    asked = []
    monkeypatch.setattr(downloader, "_check_quota", lambda u: asked.append(u) or False)
    r = env.client.post("/api/clips", json=_body())
    assert r.status_code == 507 and "quota" in r.json()["detail"]
    assert asked == ["alice"] and env.spawned == []


# ── title with brackets is found ──

def test_brackets_in_a_title_are_found_and_plain_titles_unchanged(env):
    d = env.music / "alice" / "Band" / "Album"
    d.mkdir(parents=True)
    title = "Live [2024] (1:00–2:00)"
    fname = player._sanitize(title) + ".flac"
    (d / fname).write_bytes(b"x")
    (d / "Plain song.flac").write_bytes(b"x")
    assert player._resolve_local_file(title, "Band")["path"] == str(d / fname)
    assert player._resolve_local_file(title, "")["path"] == str(d / fname)       # the broad pass too
    assert player._resolve_local_file("Plain song", "Band")["path"] == str(d / "Plain song.flac")
    assert player._resolve_local_file("Plain *", "Band") is None                  # no wildcard from input
    assert player._resolve_local_file("Live [2024]", "Band") is None


# ── cut details ──

def test_cut_argv_seeks_before_the_input_and_maps_one_audio_stream(env):
    env.make_mix()
    assert env.client.post("/api/clips", json=_body()).status_code == 200
    c = env.spawned[-1]
    i = c.index("-i")
    assert c.index("-ss") < i and c.index("-t") < i
    assert c[c.index("-map") + 1] == "0:a:0"
    assert c[c.index("-sample_fmt") + 1] == "s16" and "-nostdin" in c


def test_waveform_and_beats_argv(env):
    env.make_mix()
    env.client.get("/api/clips/waveform", params={"dj": "DJ Alpha", "file": "Set.flac"})
    env.client.get("/api/clips/beats", params={"dj": "DJ Alpha", "file": "Set.flac", "t": 50})
    w, b = env.spawned
    assert "-nostdin" in w and "-nostdin" in b
    assert w[w.index("-map") + 1] == "0:a:0"


def test_ffmpeg_is_killed_when_the_waveform_times_out(env, monkeypatch):
    env.make_mix()
    monkeypatch.setattr(clips, "WAVE_TIMEOUT", 0.05)
    env.state["wave_hang"] = True
    r = env.client.get("/api/clips/waveform", params={"dj": "DJ Alpha", "file": "Set.flac"})
    assert r.status_code == 502
    assert env.procs[0].killed


def test_ffmpeg_is_killed_when_the_cut_times_out(env, monkeypatch):
    env.make_mix()
    monkeypatch.setattr(clips, "CUT_TIMEOUT", 0.05)
    env.state["cut_hang"] = True
    r = env.client.post("/api/clips", json=_body())
    assert r.status_code == 502
    assert env.procs[0].killed and _no_scratch(env)


def test_unknown_source_duration_does_not_refuse_every_clip(env, monkeypatch):
    env.make_mix()
    monkeypatch.setattr(clips, "_duration_of", lambda p: 0.0)
    assert env.client.post("/api/clips", json=_body(start=500, end=530)).status_code == 200


def test_a_name_taken_between_check_and_save_is_409_and_not_overwritten(env, monkeypatch):
    env.make_mix()
    real_link = os.link

    def racing(src, dst, **kw):
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        Path(dst).write_bytes(b"someone else's")
        return real_link(src, dst, **kw)
    monkeypatch.setattr(os, "link", racing)
    r = env.client.post("/api/clips", json=_body())
    assert r.status_code == 409
    assert (env.music / "alice" / "DJ Alpha" / "Clips" / "Drop.flac").read_bytes() == b"someone else's"
    assert _no_scratch(env)


def test_a_mount_without_hard_links_falls_back_to_replace(env, monkeypatch):
    env.make_mix()

    def refuse(*a, **k):
        raise OSError(1, "Operation not permitted")
    monkeypatch.setattr(os, "link", refuse)
    r = env.client.post("/api/clips", json=_body())
    assert r.status_code == 200
    assert (env.music / "alice" / "DJ Alpha" / "Clips" / "Drop.flac").is_file() and _no_scratch(env)


def test_concurrent_cuts_do_not_remove_each_others_scratch(env):
    env.make_mix()
    async def both():
        return await asyncio.gather(
            clips.create_clip(str(env.music), "alice", "DJ Alpha", "Set.flac", 10, 40, "One", ""),
            clips.create_clip(str(env.music), "alice", "DJ Alpha", "Set.flac", 50, 80, "Two", ""))
    a, b = asyncio.run(both())
    assert {a["file"], b["file"]} == {"One.flac", "Two.flac"}


# ── the waveform build outlives the request ──

def test_a_dropped_request_does_not_kill_the_waveform_build(env):
    p = env.make_mix()

    async def run():
        gate = env.state["gate"] = asyncio.Event()
        first = asyncio.create_task(clips.get_waveform(str(p)))
        await asyncio.sleep(0.05)                   # ffmpeg is running
        first.cancel()                              # nginx gave up on it
        with pytest.raises(asyncio.CancelledError):
            await first
        assert len(clips._wave_tasks) == 1 and not env.procs[0].killed
        second = asyncio.create_task(clips.get_waveform(str(p)))   # joins, does not start another
        await asyncio.sleep(0)
        gate.set()
        wave = await second
        await asyncio.sleep(0.05)
        return wave
    wave = asyncio.run(run())
    assert len(env.spawned) == 1
    assert wave["duration"] == 6.0
    assert len(list((env.data / "waveforms").glob("*.json"))) == 1
    assert clips._wave_tasks == {}


def test_a_failed_build_is_forgotten_so_the_next_open_retries(env):
    p = env.make_mix()
    env.state["wave_rc"] = 1

    async def run():
        with pytest.raises(clips.ClipError):
            await clips.get_waveform(str(p))
        await asyncio.sleep(0.01)
        assert clips._wave_tasks == {}
        env.state["wave_rc"] = 0
        return await clips.get_waveform(str(p))
    assert asyncio.run(run())["duration"] == 6.0


# ── POST / DELETE reach the player cache and Navidrome ──

def test_post_and_delete_invalidate_the_cache_and_scan(env, monkeypatch):
    env.make_mix()
    cache, scans = [], []
    real = player.invalidate_cache
    monkeypatch.setattr(player, "invalidate_cache", lambda n, a: (cache.append((n, a)), real(n, a))[1])

    async def scan():
        scans.append(1)
    monkeypatch.setattr(downloader, "_trigger_navidrome_scan", scan)
    made = _make_clip(env, "Spy")
    assert cache == [("Spy", "DJ Alpha")] and len(scans) == 1
    r = env.client.request("DELETE", "/api/clips", json={"dir": made["dir"], "file": made["file"]})
    assert r.status_code == 200
    assert cache == [("Spy", "DJ Alpha")] * 2 and len(scans) == 2


# ── marker: which set a clip came from ──

def test_the_marker_names_the_set_by_dj_and_file_and_survives_a_pipe(env):
    p = env.make_mix()
    f = FLAC(str(p))
    f["title"] = ["Part A|B"]
    f.save()
    made = _make_clip(env, "Piped")
    t = FLAC(str(env.music / "alice" / "DJ Alpha" / "Clips" / made["file"]))
    assert t["comment"][0].endswith("|DJ Alpha|Set.flac")
    assert len(t["comment"][0].split("|")) == 8
    c = env.client.get("/api/clips").json()["clips"][0]
    assert (c["source_title"], c["source_dj"], c["source_file"]) == ("Part A|B", "DJ Alpha", "Set.flac")


def test_an_old_six_field_marker_still_lists(env):
    env.make_mix()
    made = _make_clip(env, "Old")
    path = env.music / "alice" / "DJ Alpha" / "Clips" / made["file"]
    t = FLAC(str(path))
    t["comment"] = ["msclip|Sunday set|DJ Alpha|10.000|40.000|FLAC"]
    t.save()
    c = env.client.get("/api/clips").json()["clips"][0]
    assert (c["source_title"], c["source_dj"], c["source_file"], c["start"], c["end"]) == ("Sunday set", "", "", 10.0, 40.0)


def test_source_title_is_folded_to_nfc(env):
    p = env.make_mix()
    f = FLAC(str(p))
    f["title"] = ["Divoka\u0301 set"]
    f.save()
    _make_clip(env, "Folded")
    assert env.client.get("/api/clips").json()["clips"][0]["source_title"] == "Divoká set"


def test_double_time_beats_are_folded_onto_the_strong_half():
    # 168 BPM ticks: beats (strong) at even positions shifted by one → the ODD half is the beat.
    times = [round(i * 60 / 168, 4) for i in range(40)]
    strengths = [0.2 if i % 2 == 0 else 1.0 for i in range(40)]
    bpm, beats = clips.fold_beats(168.0, times, strengths)
    assert bpm == 84.0
    assert beats == times[1::2]                     # the strong half, not simply "every second one"
    # A tempo already in range is left alone.
    assert clips.fold_beats(84.5, times, strengths) == (84.5, times)
    # Too few ticks to judge: untouched rather than guessed.
    assert clips.fold_beats(168.0, times[:3], strengths[:3]) == (168.0, times[:3])


# ── a track of the user's own library as the source ──

@pytest.fixture
def tracks(env, monkeypatch):
    monkeypatch.setattr(clips, "_track_memo", {})
    monkeypatch.setattr(clips, "_miss_memo", {})
    monkeypatch.setattr(clips, "_flights", {})

    def make_track(user="alice", artist="DJ Viking", album="ZoukTime Brno 2022", fname="Saturday Party.flac",
                   title="ZoukTime Set", tag_artist=None):
        d = env.music / user / artist / album
        d.mkdir(parents=True, exist_ok=True)
        p = d / fname
        sf.write(str(p), np.zeros(8000 * SET_SECONDS, dtype="int16"), 8000, format="FLAC")
        f = FLAC(str(p))
        f["title"], f["artist"] = [title], [tag_artist or artist]
        f.save()
        return p

    scans = []
    orig = clips._scan_artist_folder

    def counting(*a, **kw):
        scans.append(a)
        return orig(*a, **kw)
    monkeypatch.setattr(clips, "_scan_artist_folder", counting)
    return type("T", (), dict(make=staticmethod(make_track), scans=scans))


def _tq(**kw):
    q = {"name": "ZoukTime Set", "artist": "DJ Viking"}
    q.update(kw)
    return q


def test_a_track_in_an_album_folder_is_found_by_the_players_lookup(env, tracks):
    tracks.make(fname="ZoukTime Set.flac")                 # file name = title: the player finds it
    r = env.client.get("/api/clips/waveform", params=_tq())
    assert r.status_code == 200, r.text
    assert r.json()["source"] == {"dj": "@track", "file": "DJ Viking/ZoukTime Brno 2022/ZoukTime Set.flac",
                                  "title": "ZoukTime Set", "artist": "DJ Viking"}
    assert tracks.scans == []


def test_a_file_name_that_differs_from_the_title_tag_is_found_by_the_tag_scan(env, tracks):
    tracks.make(fname="Saturday Party 2022-10-08.flac")
    r = env.client.get("/api/clips/waveform", params=_tq(name="  zouktime   SET "))
    assert r.status_code == 200, r.text
    assert r.json()["source"]["file"] == "DJ Viking/ZoukTime Brno 2022/Saturday Party 2022-10-08.flac"
    assert len(tracks.scans) == 1


def test_the_answer_is_remembered_so_the_next_request_does_not_rescan(env, tracks):
    tracks.make(fname="Saturday Party.flac")
    for _ in range(3):
        assert env.client.get("/api/clips/waveform", params=_tq()).status_code == 200
    assert env.client.get("/api/clips/beats", params=_tq(t=5)).status_code == 200
    assert env.client.get("/api/clips/audio", params=_tq(token="alice")).status_code == 200
    assert len(tracks.scans) == 1


def test_a_memo_pointing_at_a_vanished_file_is_dropped(env, tracks):
    p = tracks.make(fname="Saturday Party.flac")
    assert env.client.get("/api/clips/waveform", params=_tq()).status_code == 200
    p.unlink()
    assert env.client.get("/api/clips/waveform", params=_tq()).status_code == 404
    assert clips._track_memo == {}


def test_the_memo_is_bounded(env, tracks, monkeypatch):
    monkeypatch.setattr(clips, "MEMO_MAX", 3)
    for i in range(5):
        tracks.make(fname=f"f{i}.flac", title=f"Set {i}")
        assert env.client.get("/api/clips/waveform", params=_tq(name=f"Set {i}")).status_code == 200
    assert len(clips._track_memo) == 3


def test_another_users_track_is_never_used(env, tracks):
    tracks.make(user="bob", fname="ZoukTime Set.flac")
    r = env.client.get("/api/clips/waveform", params=_tq())
    assert r.status_code == 404 and "own library" in r.json()["detail"]
    tracks.make(user="bob", artist="DJ Viking", album="B", fname="Other.flac")
    clips._miss_memo.clear()      # the 404 above is remembered for a minute; the next copy is new
    mine = tracks.make(user="alice", fname="Saturday Party.flac")
    ref = clips.resolve_source(str(env.music), "alice", name="ZoukTime Set", artist="DJ Viking")
    assert ref.path == str(mine.resolve()) and "bob" not in ref.path


def test_neither_and_both_source_forms_are_400(env, tracks):
    env.make_mix()
    tracks.make(fname="ZoukTime Set.flac")
    both = {"dj": "DJ Alpha", "file": "Set.flac", **_tq()}
    for path, extra in (("waveform", {}), ("beats", {"t": 1}), ("audio", {"token": "alice"})):
        assert env.client.get(f"/api/clips/{path}", params={**extra}).status_code == 400
        assert env.client.get(f"/api/clips/{path}", params={**both, **extra}).status_code == 400
    assert env.client.post("/api/clips", json={"start": 10, "end": 40, "title": "x"}).status_code == 400
    assert env.client.post("/api/clips", json={**both, "source_artist": "DJ Viking", "start": 10, "end": 40,
                                               "title": "x"}).status_code == 400
    assert env.client.get("/api/clips/waveform", params={"artist": "DJ Viking"}).status_code == 400


def test_a_clip_cannot_be_a_source(env, tracks):
    env.make_mix()
    made = env.client.post("/api/clips", json=_body(title="Drop")).json()
    clip = env.music / "alice" / "DJ Alpha" / "Clips" / made["file"]
    assert clip.is_file()
    r = env.client.get("/api/clips/waveform", params={"name": "Drop", "artist": "DJ Alpha"})
    assert r.status_code == 404
    assert env.client.post("/api/clips", json={"name": "Drop", "source_artist": "DJ Alpha", "start": 10,
                                               "end": 40, "title": "Drop 2"}).status_code == 404


def test_an_unmarked_file_in_a_folder_called_clips_is_still_a_track(env, tracks):
    tracks.make(album="Clips", fname="Real.flac", title="Real album track")
    r = env.client.get("/api/clips/waveform", params=_tq(name="Real album track"))
    assert r.status_code == 200 and r.json()["source"]["file"] == "DJ Viking/Clips/Real.flac"


def test_a_track_source_cuts_a_clip_marked_with_track_and_relpath(env, tracks):
    tracks.make(fname="Saturday Party.flac")
    r = env.client.post("/api/clips", json={"name": "ZoukTime Set", "source_artist": "DJ Viking",
                                            "start": 10, "end": 40, "title": "Peak", "artist": ""})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["artist"] == "DJ Viking"
    path = env.music / "alice" / "DJ Viking" / "Clips" / j["file"]
    t = FLAC(str(path))
    assert t["comment"][0].endswith("|@track|DJ Viking/ZoukTime Brno 2022/Saturday Party.flac")
    assert t["comment"][0].startswith("msclip|ZoukTime Set|DJ Viking|10.000|40.000|FLAC")
    listed = env.client.get("/api/clips").json()["clips"]
    assert [(c["source_dj"], c["source_file"], c["source_title"], c["source_artist"]) for c in listed] == [
        ("@track", "DJ Viking/ZoukTime Brno 2022/Saturday Party.flac", "ZoukTime Set", "DJ Viking")]
    # same limits and 409s as for a set
    assert env.client.post("/api/clips", json={"name": "ZoukTime Set", "source_artist": "DJ Viking",
                                               "start": 10, "end": 40, "title": "Peak"}).status_code == 409
    assert env.client.post("/api/clips", json={"name": "ZoukTime Set", "source_artist": "DJ Viking",
                                               "start": 10, "end": 15, "title": "Short"}).status_code == 400


def test_name_and_artist_cannot_escape_the_users_folder(env, tracks):
    tracks.make(user="alice", artist="other", fname="x.flac", title="Secret")
    tracks.make(user="bob", artist="other", fname="y.flac", title="Secret")
    for q in ({"name": "Secret", "artist": "../other"}, {"name": "../bob/other/y", "artist": "other"},
              {"name": "Secret", "artist": "../../bob/other"}, {"name": "Secret", "artist": ".."},
              {"name": "..", "artist": "."}):
        r = env.client.get("/api/clips/waveform", params=q)
        assert r.status_code in (404, 400), (q, r.text)
    # the plain spelling still works, and resolves inside alice's folder only
    ref = clips.resolve_source(str(env.music), "alice", name="Secret", artist="other")
    assert ref.path.startswith(str((env.music / "alice").resolve()) + os.sep)


def test_a_symlink_out_of_the_users_folder_is_not_a_source(env, tracks, tmp_path):
    outside = tmp_path / "outside.flac"
    sf.write(str(outside), np.zeros(8000, dtype="int16"), 8000, format="FLAC")
    f = FLAC(str(outside))
    f["title"], f["artist"] = ["Linked"], ["DJ Viking"]
    f.save()
    d = env.music / "alice" / "DJ Viking" / "A"
    d.mkdir(parents=True)
    (d / "l.flac").symlink_to(outside)
    assert env.client.get("/api/clips/waveform", params=_tq(name="Linked")).status_code == 404


def test_the_tag_scan_stops_after_the_limit_and_never_leaves_the_artist_folder(env, tracks, monkeypatch):
    monkeypatch.setattr(clips, "SCAN_LIMIT", 3)
    d = env.music / "alice" / "DJ Viking" / "A"
    d.mkdir(parents=True)
    for i in range(3):
        (d / f"a{i}.txt").write_text("x")
    tracks.make(album="B", fname="zz.flac")               # the fourth file: past the limit
    assert env.client.get("/api/clips/waveform", params=_tq()).status_code == 404
    monkeypatch.setattr(clips, "SCAN_LIMIT", 2000)
    # Tagged with the SAME artist as the scanned folder, but stored under another artist's
    # folder: only a scan that stays inside <DJ Viking>/ can miss it.
    tracks.make(artist="Someone Else", fname="q.flac", title="Elsewhere", tag_artist="DJ Viking")
    assert env.client.get("/api/clips/waveform", params=_tq(name="Elsewhere")).status_code == 404


# ── resolving the caller's OWN copy ──

def test_the_callers_copy_is_found_although_another_user_has_the_same_track(env, tracks):
    bob = tracks.make(user="bob", artist="Artist", album="B", fname="Hit.flac", title="Hit")
    mine = tracks.make(user="alice", artist="Various Artists", album="Comp", fname="Hit.flac",
                       title="Hit", tag_artist="Artist")
    ref = clips.resolve_source(str(env.music), "alice", name="Hit", artist="Artist")
    assert ref.path == str(mine.resolve()) and ref.path != str(bob.resolve())
    assert ref.file == "Various Artists/Comp/Hit.flac"
    # and bob's is never returned for alice even when she has nothing
    mine.unlink()
    clips._miss_memo.clear()
    with pytest.raises(clips.ClipError) as e:
        clips.resolve_source(str(env.music), "alice", name="Hit", artist="Artist")
    assert e.value.status == 404


def test_a_same_named_file_under_another_artist_is_refused_when_its_tags_disagree(env, tracks):
    tracks.make(artist="Various Artists", album="Comp", fname="Hit.flac", title="Hit", tag_artist="Someone Else")
    with pytest.raises(clips.ClipError) as e:
        clips.resolve_source(str(env.music), "alice", name="Hit", artist="Artist")
    assert e.value.status == 404


def test_the_album_artist_tag_also_counts(env, tracks):
    p = tracks.make(artist="Various Artists", album="Comp", fname="Hit.flac", title="Hit", tag_artist="Guest")
    f = FLAC(str(p))
    f["albumartist"] = ["Artist"]
    f.save()
    ref = clips.resolve_source(str(env.music), "alice", name="Hit", artist="Artist")
    assert ref.file == "Various Artists/Comp/Hit.flac"


def test_a_remaster_in_the_tag_but_not_in_the_file_name_is_found(env, tracks):
    tracks.make(artist="Artist", album="Hits", fname="Song.flac", title="Song (2011 Remaster)")
    ref = clips.resolve_source(str(env.music), "alice", name="Song (2011 Remaster)", artist="Artist")
    assert ref.file == "Artist/Hits/Song.flac"
    assert len(tracks.scans) == 1


def test_two_concurrent_resolves_of_one_key_scan_once(env, tracks, monkeypatch):
    import threading
    import time as _t
    tracks.make(fname="ZoukTime Set.flac")
    calls = []
    orig = clips._locate

    def slow(*a):
        calls.append(a)
        _t.sleep(0.2)
        return orig(*a)
    monkeypatch.setattr(clips, "_locate", slow)
    out = []
    ts = [threading.Thread(target=lambda: out.append(
        clips.resolve_source(str(env.music), "alice", name="ZoukTime Set", artist="DJ Viking"))) for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(calls) == 1 and len(out) == 2 and out[0].path == out[1].path
    assert clips._flights == {}


def test_a_miss_is_not_rescanned_within_the_ttl_but_is_after_it(env, tracks, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(clips, "_now", lambda: clock[0])
    calls = []
    monkeypatch.setattr(clips, "_locate", lambda *a: calls.append(a))
    for _ in range(3):
        with pytest.raises(clips.ClipError):
            clips.resolve_source(str(env.music), "alice", name="Nope", artist="Nobody")
    assert len(calls) == 1
    clock[0] += clips.MISS_TTL + 1
    with pytest.raises(clips.ClipError):
        clips.resolve_source(str(env.music), "alice", name="Nope", artist="Nobody")
    assert len(calls) == 2


def test_the_miss_memo_is_bounded(env, tracks, monkeypatch):
    monkeypatch.setattr(clips, "MEMO_MAX", 3)
    for i in range(6):
        assert env.client.get("/api/clips/waveform", params=_tq(name=f"Nope {i}")).status_code == 404
    assert len(clips._miss_memo) == 3


def test_an_over_long_name_is_400_and_an_os_error_is_404(env, tracks, monkeypatch):
    for q in ({"name": "x" * 256, "artist": "A"}, {"name": "x", "artist": "é" * 128}):    # 256 bytes
        assert env.client.get("/api/clips/waveform", params=q).status_code == 400
    assert env.client.get("/api/clips/waveform", params={"name": "x" * 255, "artist": "A"}).status_code == 404

    def boom(*a):
        raise OSError(36, "File name too long")
    monkeypatch.setattr(clips, "_locate", boom)
    r = env.client.get("/api/clips/waveform", params=_tq(name="Other"))
    assert r.status_code == 404 and "own library" in r.json()["detail"]


def test_a_real_folder_called_at_track_is_not_a_source(env, tracks):
    for path in ("source", "waveform"):
        assert env.client.get(f"/api/clips/{path}", params={"dj": "@track", "file": "A/B.flac"}).status_code == 400


def test_source_answers_before_the_editor_opens(env, tracks):
    tracks.make(fname="ZoukTime Set.flac")
    r = env.client.get("/api/clips/source", params=_tq())
    assert r.status_code == 200, r.text
    j = r.json()
    assert (j["dj"], j["file"], j["title"], j["artist"]) == (
        "@track", "DJ Viking/ZoukTime Brno 2022/ZoukTime Set.flac", "ZoukTime Set", "DJ Viking")
    assert j["duration"] > 100
    r = env.client.get("/api/clips/source", params=_tq(name="Nothing here"))
    assert r.status_code == 404 and r.json()["detail"] == "Only a track stored in your own library can be cut"
    assert env.client.get("/api/clips/source").status_code == 400


def test_source_says_a_clip_cannot_be_cut_again(env, tracks):
    env.make_mix()
    made = env.client.post("/api/clips", json=_body(title="Drop")).json()
    r = env.client.get("/api/clips/source", params={"name": "Drop", "artist": "DJ Alpha"})
    assert r.status_code == 404 and r.json()["detail"] == "A clip cannot be cut again"
    assert made["file"]


def test_source_accepts_a_downloaded_set_too(env, tracks):
    env.make_mix()
    r = env.client.get("/api/clips/source", params={"dj": "DJ Alpha", "file": "Set.flac"})
    assert r.status_code == 200 and r.json()["dj"] == "DJ Alpha"


# ── the marker survives names with its own separators ──

@pytest.mark.parametrize("text", ["a|b", "a¦b", "100% Zouk", "50%25 ¦|", "Plain Name", "Dvořák"])
def test_a_marker_field_round_trips(text):
    enc = clips._field(text)
    assert "|" not in enc and clips._unfield(enc) == text


def test_an_old_plain_marker_is_read_as_it_is():
    # written before the encoding: '|' had become '¦', every other character was raw
    assert clips._unfield("DJ Viking/Album/Set.flac") == "DJ Viking/Album/Set.flac"
    assert clips._unfield("a¦b") == "a¦b"
    assert clips._field("Dvořák") == "Dvořák"      # ordinary names stay readable in the tag


def test_a_clip_cut_from_a_name_with_separators_lists_its_source_exactly(env, tracks):
    tracks.make(album="Live ¦ 100%", fname="Zouk ¦ 100%.flac", title="Zouk ¦ 100%")
    r = env.client.post("/api/clips", json={"name": "Zouk ¦ 100%", "source_artist": "DJ Viking",
                                            "start": 10, "end": 40, "title": "Peak"})
    assert r.status_code == 200, r.text
    c = env.client.get("/api/clips").json()["clips"][0]
    assert (c["source_dj"], c["source_file"], c["source_title"]) == (
        "@track", "DJ Viking/Live ¦ 100%/Zouk ¦ 100%.flac", "Zouk ¦ 100%")


# ── _accept_track ──

def test_accept_track_refuses_hidden_folders_and_non_audio(env, tracks):
    root = os.path.realpath(env.music / "alice")
    ok = tracks.make(fname="ok.flac")
    assert clips._accept_track(root, str(ok)) == "DJ Viking/ZoukTime Brno 2022/ok.flac"
    hidden = tracks.make(album=".hidden", fname="h.flac")
    assert clips._accept_track(root, str(hidden)) is None
    txt = ok.parent / "notes.txt"
    txt.write_text("x")
    assert clips._accept_track(root, str(txt)) is None
    noext = ok.parent / "flac"
    noext.write_bytes(b"x")
    assert clips._accept_track(root, str(noext)) is None


def test_a_memoised_path_later_replaced_by_a_link_out_is_refused(env, tracks, tmp_path):
    p = tracks.make(fname="ZoukTime Set.flac")
    assert env.client.get("/api/clips/waveform", params=_tq()).status_code == 200
    assert clips._track_memo
    outside = tmp_path / "out.flac"
    outside.write_bytes(p.read_bytes())
    p.unlink()
    p.symlink_to(outside)
    clips._miss_memo.clear()
    r = env.client.get("/api/clips/waveform", params=_tq())
    assert r.status_code == 404
    assert clips._track_memo == {}


# ── saving straight into a playlist ──

def _song(sid, title, artist="DJ Alpha", album="Clips", path=""):
    return {"id": sid, "title": title, "artist": artist, "album": album, "path": path}


@pytest.fixture
def nav(env, monkeypatch):
    """A Navidrome that indexes a clip after `lag` lookups. Search answers like the real
    one: every song whose title shares the query's first word, oldest first."""
    from app.routers import library as library_router
    from app.services import library
    st = {"playlists": [{"id": "p1", "name": "Zouk", "owner": "alice"}, {"id": "t1", "name": "__upnext_dev", "owner": "alice"},
                        {"id": "b1", "name": "Bob's", "owner": "bob"}],
          "lag": 0, "songs": [], "added": [], "lookups": 0, "ok": True}

    async def get_playlists():
        return st["playlists"]

    async def search(name):
        st["lookups"] += 1
        if st["lookups"] <= st["lag"]:
            return []
        return [s for s in st["songs"] if s["title"].split()[0] == name.split()[0]]

    async def update_playlist(pid, song_ids_to_add=None, song_indices_to_remove=None):
        st["added"].append((pid, list(song_ids_to_add or [])))
        return st["ok"]
    monkeypatch.setattr(library, "get_playlists", get_playlists)
    monkeypatch.setattr(clips, "_search_clip_songs", search)
    monkeypatch.setattr(library, "update_playlist", update_playlist)
    monkeypatch.setattr(library_router, "_own_playlists_owner", lambda user: user["username"])
    monkeypatch.setattr(clips, "INDEX_POLL", 0.01)
    env.make_mix()
    return st


def test_a_later_clip_of_the_same_set_is_not_mistaken_for_an_earlier_one(env, nav):
    # To the library's fuzzy match both are "sunday set": the older clip answered first
    # and the new one never reached the playlist.
    nav["songs"] = [_song("old", "Sunday set (0:10–0:40)"), _song("new", "Sunday set (0:50–1:20)")]
    made = _make_clip(env, "Sunday set (0:50–1:20)", start=50, end=80, playlist_id="p1")
    assert made["playlist"]["state"] == "added" and nav["added"] == [("p1", ["new"])]


def test_the_song_must_be_a_clip_of_that_artist_and_ours_by_path():
    pick = clips.pick_indexed_clip
    mine = _song("mine", "Drop", path="alice/DJ Alpha/Clips/Drop.flac")
    theirs = _song("theirs", "Drop", path="bob/DJ Alpha/Clips/Drop.flac")
    assert pick([_song("a", "Drop", album="Greatest Hits")], "Drop", "DJ Alpha") is None
    assert pick([_song("a", "Drop", artist="DJ Beta")], "Drop", "DJ Alpha") is None
    assert pick([_song("", "Drop")], "Drop", "DJ Alpha") is None
    assert pick([theirs, mine], "Drop", "DJ Alpha", "DJ Alpha", "Drop.flac", "alice")["id"] == "mine"
    assert pick([_song("x", "Drop", path="Clips/other.flac"), mine], "Drop", "DJ Alpha", "DJ Alpha", "Drop.flac")["id"] == "mine"
    assert pick([_song("np", "Drop")], "Drop", "DJ Alpha", "DJ Alpha", "Drop.flac")["id"] == "np"   # a server that reports no path


def test_someone_elses_playlist_is_refused_before_anything_is_cut(env, nav):
    r = env.client.post("/api/clips", json=_body(title="Drop", playlist_id="b1"))
    assert r.status_code == 403 and r.json()["detail"] == "Not your playlist"
    assert not (env.music / "alice" / "DJ Alpha" / "Clips").exists() and nav["added"] == []


def test_a_library_that_does_not_answer_saves_nothing(env, nav, monkeypatch):
    import httpx
    from app.services import library

    async def down():
        raise httpx.ConnectError("no")
    monkeypatch.setattr(library, "get_playlists", down)
    assert env.client.post("/api/clips", json=_body(title="Drop", playlist_id="p1")).status_code == 502
    assert not (env.music / "alice" / "DJ Alpha" / "Clips").exists()


def test_a_clip_saved_with_a_playlist_lands_in_it_once_indexed(env, nav):
    nav["songs"], nav["lag"] = [_song("s9", "Drop")], 3
    made = _make_clip(env, "Drop", playlist_id="p1")
    assert made["playlist"] == {"id": "p1", "name": "Zouk", "state": "added"}
    assert nav["added"] == [("p1", ["s9"])] and nav["lookups"] == 4


def test_without_a_playlist_nothing_is_looked_up_or_written(env, nav):
    made = _make_clip(env, "Plain")
    assert "playlist" not in made and nav["lookups"] == 0 and nav["added"] == []


def test_an_unknown_or_internal_playlist_is_refused_before_anything_is_cut(env, nav):
    for pid in ("nope", "t1"):
        r = env.client.post("/api/clips", json=_body(title="Drop", playlist_id=pid))
        assert r.status_code == 404 and r.json()["detail"] == "Playlist not found"
    assert not (env.music / "alice" / "DJ Alpha" / "Clips").exists() and nav["added"] == []


def test_a_similar_title_is_not_taken_for_the_new_clip(env, nav, monkeypatch):
    # The library's match is "one contains the other": "Drop 2" answers a search for "Drop".
    nav["songs"] = [_song("other", "Drop 2")]
    monkeypatch.setattr(clips, "INDEX_WAIT", 0.05)
    made = _make_clip(env, "Drop", playlist_id="p1")
    assert made["playlist"]["state"] == "failed" and nav["added"] == []


def test_a_slow_scan_answers_pending_and_finishes_in_the_background(env, nav, monkeypatch):
    nav["songs"], nav["lag"] = [_song("s1", "Late")], 10 ** 9
    monkeypatch.setattr(clips_router, "PLAYLIST_INLINE_WAIT", 0.05)

    async def run():
        made = await clips.create_clip(str(env.music), "alice", "DJ Alpha", "Set.flac", 10, 40, "Late", "")
        state = await clips_router._into_playlist(made, "p1")
        assert state == "pending" and nav["added"] == [] and len(clips_router._playlist_tasks) == 1
        nav["lag"] = 0                                     # the scan catches up
        await asyncio.gather(*clips_router._playlist_tasks)
        assert nav["added"] == [("p1", ["s1"])] and not clips_router._playlist_tasks
    asyncio.run(run())


def test_a_refused_playlist_write_is_reported_and_the_clip_stays(env, nav):
    nav["songs"], nav["ok"] = [_song("s2", "Kept")], False
    made = _make_clip(env, "Kept", playlist_id="p1")
    assert made["playlist"]["state"] == "failed"
    assert (env.music / "alice" / "DJ Alpha" / "Clips" / made["file"]).is_file()


def test_a_scan_that_missed_the_file_is_asked_again(env, nav, monkeypatch):
    scans = []

    async def scan():
        scans.append(1)
    monkeypatch.setattr(downloader, "_trigger_navidrome_scan", scan)
    monkeypatch.setattr(clips, "INDEX_RESCAN", 0.03)
    nav["songs"], nav["lag"] = [_song("s3", "Again")], 8
    made = _make_clip(env, "Again", playlist_id="p1")
    assert made["playlist"]["state"] == "added" and len(scans) == 2   # the save's own + ONE repeat
