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
