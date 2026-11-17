"""Followed DJs and the downloaded-mixes list.

Follows are per user; auto-download takes only what a DJ uploads AFTER the
follow, at most three per DJ and run, above the user's quality and length
thresholds, and never for an account that may not use yt-dlp. The library list
and delete stay inside `<user>/Mixes`. No network: fetchers are stand-ins.
"""
import asyncio
import json
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import bind_navidrome_creds
from app.routers import mixes as mixes_router
from app.services import auth, downloader, mix_follows, mix_sources, mixes


def _up(n, kbps=160, minutes=60, title=None):
    return mix_sources.make_item("soundcloud", f"https://soundcloud.com/dj/mix-{n}", title or f"Mix {n}",
                                 "DJ", "dj", "", "", minutes * 60, mixes.nominal_quality("AAC", kbps, True))


@pytest.fixture
def store(monkeypatch, tmp_path):
    monkeypatch.setattr(mix_follows, "FOLLOWS_FILE", tmp_path / "mix_follows.json")
    mix_follows._locks.clear()   # a lock belongs to the event loop that used it
    monkeypatch.setattr(auth, "_load_users", lambda: {
        "claude_test": {"allowed_methods": ["yt-dlp"]},
        "lidarr_only": {"allowed_methods": ["lidarr"]},
    })
    return tmp_path


# ── storage ──

def test_follows_are_per_user_and_written_atomically(store):
    f = mix_follows.add_follow("claude_test", "soundcloud", "dj", "DJ", seen_urls=[])
    assert f["auto_download"] is False and f["min_kbps"] == 128 and f["min_minutes"] == 20
    assert mix_follows.add_follow("claude_test", "soundcloud", "dj", seen_urls=[]) is None
    assert mix_follows.get_follows("someone_else") == []
    assert [x["user_id"] for x in mix_follows.get_follows("claude_test")] == ["dj"]
    on_disk = json.loads((store / "mix_follows.json").read_text())
    assert list(on_disk) == ["claude_test"]
    # tmp + os.replace in the same directory: nothing left behind.
    assert sorted(p.name for p in store.iterdir()) == ["mix_follows.json"]
    assert mix_follows.update_follow("claude_test", "soundcloud", "dj", auto_download=True,
                                     min_kbps=192, min_minutes=45)["min_kbps"] == 192
    assert mix_follows.remove_follow("claude_test", "soundcloud", "dj") is True
    assert mix_follows.remove_follow("claude_test", "soundcloud", "dj") is False


def test_seen_keeps_the_newest_300(store):
    mix_follows.add_follow("claude_test", "soundcloud", "dj", seen_urls=[f"u{i}" for i in range(310)])
    raw = json.loads((store / "mix_follows.json").read_text())["claude_test"][0]["seen"]
    assert len(raw) == 300 and raw[0] == "u10" and raw[-1] == "u309"
    mix_follows.mark_seen("claude_test", "soundcloud", "dj", ["u50", "new"])
    raw = json.loads((store / "mix_follows.json").read_text())["claude_test"][0]["seen"]
    assert raw[-2:] == ["u50", "new"] and raw.count("u50") == 1 and len(raw) == 300


# ── the check ──

def _run_check(username, uploads, owned=(), started=None):
    started = [] if started is None else started

    async def fetch(source, uid, limit):
        return list(uploads)

    async def in_library(name, artist, album=""):
        if name == "boom":
            raise RuntimeError("navidrome down")
        return "id" if name in owned else None

    def start(user, item):
        started.append((user, item["url"]))

    return asyncio.run(mix_follows.check_user(username, fetch, in_library, start)), started


def _follow(username="claude_test", seen=(), auto=True, **kw):
    mix_follows.add_follow(username, "soundcloud", "dj", seen_urls=list(seen))
    mix_follows.update_follow(username, "soundcloud", "dj", auto_download=auto, **kw)


def _seen(username="claude_test"):
    return set(json.loads(mix_follows.FOLLOWS_FILE.read_text())[username][0]["seen"])


def _inflight(username="claude_test"):
    return json.loads(mix_follows.FOLLOWS_FILE.read_text())[username][0].get("inflight", {})


def test_uploads_present_at_follow_time_are_never_downloaded(store):
    ups = [_up(i) for i in range(5)]
    _follow(seen=[u["url"] for u in ups])
    r, started = _run_check("claude_test", ups)
    assert started == [] and r["checked"] == 1


def test_only_new_uploads_above_both_thresholds_are_taken_three_at_most(store):
    old = _up(0)
    _follow(seen=[old["url"]])
    new = [_up(1, kbps=64), _up(2, minutes=10), _up(3), _up(4), _up(5, title="owned"), _up(6), _up(7)]
    r, started = _run_check("claude_test", [old] + new, owned={"owned"})
    assert [u for _, u in started] == [_up(3)["url"], _up(4)["url"], _up(6)["url"]]
    assert all(user == "claude_test" for user, _ in started)
    seen = _seen()
    # Turned down for quality or length, and the one already owned: seen, never retried.
    for n in (1, 2, 5):
        assert _up(n)["url"] in seen
    # Started: in flight, not seen yet.
    assert set(_inflight()) == {_up(3)["url"], _up(4)["url"], _up(6)["url"]}
    # Over the cap: left for the next run.
    assert _up(7)["url"] not in seen and _up(7)["url"] not in _inflight()
    # Next run: the stand-in jobs are unknown to this process (as after a
    # restart), so they count as done; the one over the cap is taken now.
    r, started = _run_check("claude_test", [old] + new, owned={"owned"})
    assert [u for _, u in started] == [_up(7)["url"]]
    assert {_up(3)["url"], _up(4)["url"], _up(6)["url"]} <= _seen()


def test_thresholds_are_the_users_own(store):
    _follow(min_kbps=192, min_minutes=45)
    _, started = _run_check("claude_test", [_up(1, kbps=160), _up(2, kbps=192, minutes=44), _up(3, kbps=192)])
    assert [u for _, u in started] == [_up(3)["url"]]


def test_follows_without_auto_download_are_left_alone(store):
    _follow(auto=False)
    r, started = _run_check("claude_test", [_up(1)])
    assert started == [] and r["checked"] == 0 and _seen() == set()


def test_an_account_without_ytdlp_downloads_nothing(store):
    _follow(username="lidarr_only")
    r, started = _run_check("lidarr_only", [_up(1)])
    assert started == [] and "account" in r["errors"]


def test_an_unseeded_follow_marks_the_history_on_its_first_check(store):
    mix_follows.add_follow("claude_test", "soundcloud", "dj", seen_urls=None)
    mix_follows.update_follow("claude_test", "soundcloud", "dj", auto_download=True)
    ups = [_up(1), _up(2)]
    _, started = _run_check("claude_test", ups)
    assert started == [] and _seen() == {u["url"] for u in ups}
    _, started = _run_check("claude_test", ups + [_up(3)])
    assert [u for _, u in started] == [_up(3)["url"]]


def test_a_library_lookup_failure_still_queues_and_the_job_rechecks(store):
    _follow()
    _, started = _run_check("claude_test", [_up(1, title="boom")])
    assert len(started) == 1


def test_one_dj_failing_does_not_stop_the_others(store):
    _follow()
    mix_follows.add_follow("claude_test", "hearthis", "other", seen_urls=[])
    mix_follows.update_follow("claude_test", "hearthis", "other", auto_download=True)

    async def fetch(source, uid, limit):
        if source == "soundcloud":
            raise RuntimeError("SoundCloud down")
        return [_up(9)]

    async def nothing_owned(n, a, album=""):
        return None

    started = []
    r = asyncio.run(mix_follows.check_user("claude_test", fetch, nothing_owned,
                                           lambda u, it: started.append(it["url"])))
    assert r["errors"] == {"soundcloud/dj": "SoundCloud down"} and len(started) == 1


def test_the_job_is_an_ordinary_mix_job(monkeypatch):
    seen = {}

    async def fake_run(job):
        seen["job"] = job

    monkeypatch.setattr(downloader, "run_download", fake_run)

    async def go():
        job = mix_follows.start_mix_job("claude_test", _up(1))
        await asyncio.sleep(0)
        return job

    job = asyncio.run(go())
    assert (job.type, job.method, job.format, job.username) == ("mix", "yt-dlp", "original", "claude_test")
    assert job.url == _up(1)["url"] and job.title == "DJ - Mix 1"
    assert seen["job"] is job


# ── the downloaded mixes ──

@pytest.fixture
def lib(monkeypatch, tmp_path):
    music = tmp_path / "music"
    root = music / "claude_test"
    (root / "Martin Šmoldas" / "DJ Sets").mkdir(parents=True)
    (root / "Martin Šmoldas" / "Some Album").mkdir()          # an ordinary album of the same artist
    (root / "Martin Šmoldas" / "Some Album" / "Song.flac").write_bytes(b"s")
    (root / "DJ Two" / "DJ Sets").mkdir(parents=True)
    (root / ".hidden" / "DJ Sets").mkdir(parents=True)
    (root / ".hidden" / "DJ Sets" / "h.m4a").write_bytes(b"h")
    (root / "Podcasts" / "Show").mkdir(parents=True)
    (root / "Podcasts" / "Show" / "ep.mp3").write_bytes(b"p")
    (music / ".mix-dl" / "dl-abc").mkdir(parents=True)
    (music / ".mix-dl" / "dl-abc" / "mix.m4a").write_bytes(b"partial")
    a = root / "Martin Šmoldas" / "DJ Sets" / "Zouktime Sunday.m4a"
    a.write_bytes(b"x" * 2048)
    (root / "Martin Šmoldas" / "DJ Sets" / "cover.jpg").write_bytes(b"jpg")
    b = root / "DJ Two" / "DJ Sets" / "Set.mp3"
    b.write_bytes(b"y" * 1024)
    _comment(b, "https://soundcloud.com/djtwo/set")     # not in the registry: known by its COMMENT
    (music / "other_user" / "X" / "DJ Sets").mkdir(parents=True)
    theirs = music / "other_user" / "X" / "DJ Sets" / "theirs.m4a"
    theirs.write_bytes(b"z")
    monkeypatch.setattr(mixes, "REGISTRY_FILE", tmp_path / "mixes.json")
    monkeypatch.setattr(mixes, "_registry", None)
    mixes.remember_mix({"title": "Zouktime Sunday", "uploader": "Martin Šmoldas",
                        "url": "https://www.mixcloud.com/m/z/", "source": "mixcloud",
                        "thumbnail": "https://t/1.jpg"}, str(a), "Mixcloud · AAC 64 kbps")
    mixes.remember_mix({"title": "theirs", "uploader": "X", "url": "https://www.mixcloud.com/x/t/"},
                       str(theirs), "q")
    return music, a, b


def _comment(path, text, title=""):
    """ID3 COMMENT (and TITLE) on a stand-in .mp3 — what write_tags leaves there."""
    from mutagen.id3 import ID3, COMM, TIT2
    t = ID3()
    t.add(COMM(encoding=3, lang="eng", desc="", text=text))
    if title:
        t.add(TIT2(encoding=3, text=title))
    t.save(str(path))


def test_the_library_lists_mixes_by_dj_with_registry_quality(lib):
    music, a, b = lib
    data = mixes.list_library(str(music), "claude_test")
    assert [d["name"] for d in data["djs"]] == ["DJ Two", "Martin Šmoldas"]
    assert data["count"] == 2 and data["total_size"] == 2048 + os.path.getsize(b)
    sm = data["djs"][1]["mixes"]
    assert len(sm) == 1    # cover.jpg is not a mix
    m = sm[0]
    assert m["file"] == "Zouktime Sunday.m4a" and m["dj"] == "Martin Šmoldas"
    # Not a real audio file, so no tags: title and DJ fall back to the names.
    assert m["title"] == "Zouktime Sunday" and m["artist"] == "Martin Šmoldas"
    assert m["quality"] == "Mixcloud · AAC 64 kbps" and m["url"] == "https://www.mixcloud.com/m/z/"
    assert m["source"] == "mixcloud" and m["thumbnail"] == "https://t/1.jpg" and m["size"] == 2048
    # Nothing hidden, no ordinary album, no podcast, nothing from another user.
    files = [x["file"] for d in data["djs"] for x in d["mixes"]]
    assert sorted(files) == ["Set.mp3", "Zouktime Sunday.m4a"]


def test_an_empty_or_missing_library_is_empty(tmp_path):
    assert mixes.list_library(str(tmp_path), "nobody") == {"djs": [], "total_size": 0, "count": 0}


def test_deleting_the_last_mix_removes_empty_folders_but_never_another_album(lib):
    music, a, b = lib
    assert mixes.is_mix("Zouktime Sunday", "Martin Šmoldas")
    assert mixes.delete_library_file(str(music), "claude_test", "Martin Šmoldas", "Zouktime Sunday.m4a")
    assert not a.exists()
    # cover.jpg keeps "DJ Sets"; the artist's other album keeps the artist folder.
    assert (music / "claude_test" / "Martin Šmoldas" / "DJ Sets").exists()
    assert "martin šmoldas:zouktime sunday" not in mixes._load_registry()
    (music / "claude_test" / "Martin Šmoldas" / "DJ Sets" / "cover.jpg").unlink()
    x = music / "claude_test" / "Martin Šmoldas" / "DJ Sets" / "x.m4a"
    x.write_bytes(b"x")
    mixes.remember_mix({"title": "x", "uploader": "Martin Šmoldas", "url": "https://www.mixcloud.com/m/x/"}, str(x), "q")
    assert mixes.delete_library_file(str(music), "claude_test", "Martin Šmoldas", "x.m4a")
    assert not (music / "claude_test" / "Martin Šmoldas" / "DJ Sets").exists()
    assert (music / "claude_test" / "Martin Šmoldas" / "Some Album" / "Song.flac").exists()
    # A DJ with nothing else: "DJ Sets" and the DJ folder both go.
    assert mixes.delete_library_file(str(music), "claude_test", "DJ Two", "Set.mp3")
    assert not (music / "claude_test" / "DJ Two").exists()
    assert mixes.delete_library_file(str(music), "claude_test", "DJ Two", "Set.mp3") is None


@pytest.mark.parametrize("dj,file", [
    ("..", "Set.mp3"),
    ("DJ Two", "../../../other_user/X/DJ Sets/theirs.m4a"),
    ("../other_user/X", "theirs.m4a"),
    ("DJ Two/..", "Set.mp3"),
    (".hidden", "h.m4a"),
    ("..", ".mix-dl"),
    ("DJ Two", ".hidden.m4a"),
    ("DJ Two", ""),
    ("Martin Šmoldas", "cover.jpg"),
    ("/etc", "passwd"),
])
def test_delete_cannot_leave_the_users_dj_sets(lib, dj, file):
    music, a, b = lib
    with pytest.raises(mixes.MixPathError):
        mixes.delete_library_file(str(music), "claude_test", dj, file)
    assert (music / "other_user" / "X" / "DJ Sets" / "theirs.m4a").exists()
    assert (music / ".mix-dl" / "dl-abc" / "mix.m4a").exists()
    assert (music / "claude_test" / ".hidden" / "DJ Sets" / "h.m4a").exists()


def test_only_files_inside_dj_sets_can_be_deleted(lib):
    """An ordinary album of the same artist is not a mix — the path is always
    <user>/<dj>/DJ Sets/<file>, so "Some Album/Song.flac" cannot be named."""
    music, a, b = lib
    assert mixes.delete_library_file(str(music), "claude_test", "Martin Šmoldas", "Song.flac") is None
    assert (music / "claude_test" / "Martin Šmoldas" / "Some Album" / "Song.flac").exists()


def test_a_symlinked_dj_folder_pointing_outside_is_refused(lib, tmp_path):
    music, a, b = lib
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "x.m4a").write_bytes(b"keep")
    (outside / "DJ Sets").mkdir()
    (outside / "DJ Sets" / "x.m4a").write_bytes(b"keep")
    os.symlink(outside, music / "claude_test" / "Link")
    with pytest.raises(mixes.MixPathError):
        mixes.delete_library_file(str(music), "claude_test", "Link", "x.m4a")
    assert (outside / "DJ Sets" / "x.m4a").exists()


# ── the API ──

def _client(user, monkeypatch, music_dir=None):
    app = FastAPI()
    app.include_router(mixes_router.router)
    app.dependency_overrides[auth.get_current_user] = lambda: user

    async def _no_bind():
        return user
    app.dependency_overrides[bind_navidrome_creds] = _no_bind
    if music_dir:
        monkeypatch.setenv("MUSIC_DIR", str(music_dir))
    return TestClient(app)


NO_YTDLP = {"username": "u", "allowed_methods": ["lidarr"]}
OK = {"username": "claude_test", "allowed_methods": ["yt-dlp"]}


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/mixes/search?q=zouk", None),
    ("POST", "/api/mixes/follows", {"source": "soundcloud", "user_id": "dj"}),
    ("POST", "/api/mixes/follows/check", None),
    ("GET", "/api/mixes/follows/soundcloud/dj/uploads", None),
    ("PUT", "/api/mixes/follows/soundcloud/dj", {"auto_download": True}),
])
def test_everything_that_leads_to_a_download_needs_ytdlp(monkeypatch, store, method, path, body):
    client = _client(NO_YTDLP, monkeypatch)
    r = client.request(method, path, json=body)
    assert r.status_code == 403


def test_follow_marks_current_uploads_seen_and_refuses_bad_ids(monkeypatch, store):
    async def fake_uploads(source, uid, limit=10):
        return [_up(1), _up(2)]

    monkeypatch.setattr(mix_sources, "uploads", fake_uploads)
    client = _client(OK, monkeypatch)
    r = client.post("/api/mixes/follows", json={"source": "soundcloud", "user_id": "dj", "name": "DJ"})
    assert r.status_code == 200 and r.json()["seen_count"] == 2 and "seen" not in r.json()
    assert client.post("/api/mixes/follows", json={"source": "soundcloud", "user_id": "dj"}).status_code == 409
    assert client.post("/api/mixes/follows", json={"source": "youtube", "user_id": "@handle"}).status_code == 400
    assert client.post("/api/mixes/follows", json={"source": "audiomack", "user_id": "x"}).status_code == 400
    assert [f["user_id"] for f in client.get("/api/mixes/follows").json()["follows"]] == ["dj"]
    assert client.put("/api/mixes/follows/soundcloud/dj", json={"auto_download": True}).json()["auto_download"] is True
    assert client.delete("/api/mixes/follows/soundcloud/dj").status_code == 200
    assert client.delete("/api/mixes/follows/soundcloud/dj").status_code == 404


def test_a_follow_made_while_the_site_is_down_is_unseeded(monkeypatch, store):
    async def down(source, uid, limit=10):
        raise RuntimeError("down")

    monkeypatch.setattr(mix_sources, "uploads", down)
    client = _client(OK, monkeypatch)
    assert client.post("/api/mixes/follows", json={"source": "soundcloud", "user_id": "dj"}).json()["seeded"] is False


def test_uploads_say_which_are_in_the_library(monkeypatch, store):
    async def fake_uploads(source, uid, limit=10):
        return [_up(1), _up(2, title="owned")]

    async def owned(name, artist, album=""):
        return "id" if name == "owned" else None

    from app.services import library
    monkeypatch.setattr(mix_sources, "uploads", fake_uploads)
    monkeypatch.setattr(library, "find_song_id", owned)
    r = _client(OK, monkeypatch).get("/api/mixes/follows/soundcloud/dj/uploads?limit=5")
    assert r.status_code == 200
    assert [u["in_library"] for u in r.json()["uploads"]] == [False, True]


def test_search_needs_a_query_and_a_known_source(monkeypatch, store):
    client = _client(OK, monkeypatch)
    assert client.get("/api/mixes/search?q=%20").status_code == 400
    assert client.get("/api/mixes/search?q=x&sources=audiomack").status_code == 400


def test_library_api_lists_and_deletes_only_the_callers_mixes(monkeypatch, lib):
    music, a, b = lib
    scans, forgotten = [], []

    async def fake_scan():
        scans.append(1)

    from app.services import player
    monkeypatch.setattr(downloader, "_trigger_navidrome_scan", fake_scan)
    monkeypatch.setattr(player, "invalidate_cache", lambda n, a: forgotten.append((n, a)))
    client = _client({"username": "claude_test"}, monkeypatch, music)
    data = client.get("/api/mixes/library").json()
    assert data["count"] == 2
    r = client.request("DELETE", "/api/mixes/library", json={"dj": "..", "file": "x.m4a"})
    assert r.status_code == 400
    r = client.request("DELETE", "/api/mixes/library", json={"dj": "DJ Two", "file": "Nope.mp3"})
    assert r.status_code == 404
    r = client.request("DELETE", "/api/mixes/library", json={"dj": "DJ Two", "file": "Set.mp3"})
    assert r.status_code == 200 and scans == [1] and not b.exists()
    # The player's remembered source for that track is dropped with the file.
    assert forgotten == [("Set", "DJ Two")]
    # Another user sees none of claude_test's mixes and cannot delete them.
    other = _client({"username": "other_user"}, monkeypatch, music)
    assert [d["name"] for d in other.get("/api/mixes/library").json()["djs"]] == ["X"]
    r = other.request("DELETE", "/api/mixes/library", json={"dj": "Martin Šmoldas", "file": "Zouktime Sunday.m4a"})
    assert r.status_code == 404 and a.exists()


# ── review fixes ──

def test_two_checks_at_once_start_each_upload_once(store):
    """"Check now" pressed twice (or during the 6-hourly run): without the per-user
    lock both read `seen` before either wrote, and both started the same upload."""
    _follow()
    started = []

    async def slow_fetch(source, uid, limit):
        await asyncio.sleep(0.02)
        return [_up(1), _up(2)]

    async def nothing_owned(n, a, album=""):
        await asyncio.sleep(0.01)
        return None

    def start(user, item):
        # The URL is already recorded when the job is started.
        assert item["url"] in _inflight()
        started.append(item["url"])

    async def both():
        await asyncio.gather(mix_follows.check_user("claude_test", slow_fetch, nothing_owned, start),
                             mix_follows.check_user("claude_test", slow_fetch, nothing_owned, start))

    asyncio.run(both())
    assert sorted(started) == sorted([_up(1)["url"], _up(2)["url"]])


def test_a_failed_download_is_retried_up_to_three_times(store):
    _follow()
    states = {}
    started = []

    class J:
        def __init__(self, i):
            self.id = i

    def start(user, item):
        started.append(item["url"])
        jid = f"job{len(started)}"
        states[jid] = "failed"
        return J(jid)

    async def fetch(source, uid, limit):
        return [_up(1)]

    async def nothing_owned(n, a, album=""):
        return None

    def run():
        return asyncio.run(mix_follows.check_user("claude_test", fetch, nothing_owned, start,
                                                  status=lambda jid: states.get(jid)))

    run()                       # attempt 1
    assert _inflight()[_up(1)["url"]]["n"] == 1
    run()                       # attempt 2 (job1 failed)
    run()                       # attempt 3
    assert started == [_up(1)["url"]] * 3
    run()                       # given up: seen, never again
    run()
    assert len(started) == 3 and _up(1)["url"] in _seen() and _inflight() == {}


def test_a_running_download_is_left_alone_and_a_finished_one_becomes_seen(store):
    _follow()
    states = {}

    class J:
        id = "j1"

    def start(user, item):
        states["j1"] = "running"
        return J()

    async def fetch(source, uid, limit):
        return [_up(1)]

    async def nothing_owned(n, a, album=""):
        return None

    def run():
        return asyncio.run(mix_follows.check_user("claude_test", fetch, nothing_owned, start,
                                                  status=lambda jid: states.get(jid)))
    run()
    r = run()
    assert r["queued"] == [] and _up(1)["url"] in _inflight()
    states["j1"] = "done"
    run()
    assert _up(1)["url"] in _seen() and _inflight() == {}


def test_an_upload_of_unknown_length_is_not_turned_down(store):
    """A flat YouTube listing could lack `duration`; such an upload must not be
    marked seen as "too short" — it waits until its length is known."""
    _follow()
    nolen = dict(_up(1), duration=0)
    _, started = _run_check("claude_test", [nolen])
    assert started == [] and nolen["url"] not in _seen() and _inflight() == {}


def test_the_user_may_follow_at_most_200(monkeypatch, store):
    for i in range(mix_follows.MAX_FOLLOWS):
        mix_follows.add_follow("claude_test", "soundcloud", f"dj{i}", seen_urls=[])
    with pytest.raises(mix_follows.FollowLimit):
        mix_follows.add_follow("claude_test", "soundcloud", "one-more", seen_urls=[])

    async def fake_uploads(source, uid, limit=10):
        return []

    monkeypatch.setattr(mix_sources, "uploads", fake_uploads)
    r = _client(OK, monkeypatch).post("/api/mixes/follows", json={"source": "soundcloud", "user_id": "one-more"})
    assert r.status_code == 400 and "200" in r.json()["detail"]


def test_the_djs_of_one_user_are_checked_three_at_a_time(store):
    for i in range(5):
        mix_follows.add_follow("claude_test", "soundcloud", f"dj{i}", seen_urls=[])
        mix_follows.update_follow("claude_test", "soundcloud", f"dj{i}", auto_download=True)
    live = {"now": 0, "max": 0}

    async def fetch(source, uid, limit):
        live["now"] += 1
        live["max"] = max(live["max"], live["now"])
        await asyncio.sleep(0.02)
        live["now"] -= 1
        return []

    async def nothing_owned(n, a, album=""):
        return None

    r = asyncio.run(mix_follows.check_user("claude_test", fetch, nothing_owned, lambda u, i: None))
    assert r["checked"] == 5 and live["max"] == 3


def test_the_background_run_logs_each_djs_error(store, monkeypatch, caplog):
    _follow()

    async def failing_check(username):
        return {"checked": 0, "queued": [], "errors": {"soundcloud/dj": "SoundCloud down"}}

    monkeypatch.setattr(mix_follows, "check_user", failing_check)
    with caplog.at_level("WARNING", logger="app.services.mix_follows"):
        asyncio.run(mix_follows.check_all())
    assert "soundcloud/dj: SoundCloud down" in caplog.text


def test_a_user_name_that_cleans_up_to_another_users_folder_is_refused(lib, store, monkeypatch):
    """"lucas." would be cleaned to "lucas" and read, delete and download into
    lucas's Mixes."""
    music, a, b = lib
    with pytest.raises(mixes.MixPathError):
        mixes.user_folder("claude_test.")
    assert mixes.list_library(str(music), "claude_test.")["count"] == 0
    with pytest.raises(mixes.MixPathError):
        mixes.delete_library_file(str(music), "claude_test.", "DJ Two", "Set.mp3")
    with pytest.raises(mixes.MixPathError):
        mixes.mix_dir(str(music), "claude_test.", "DJ")
    assert b.exists()
    monkeypatch.setattr(auth, "_load_users", lambda: {"claude_test.": {"allowed_methods": ["yt-dlp"]}})
    assert mix_follows.may_download_mixes("claude_test.") is False
    r = _client({"username": "claude_test."}, monkeypatch, music).request(
        "DELETE", "/api/mixes/library", json={"dj": "DJ Two", "file": "Set.mp3"})
    assert r.status_code == 400 and b.exists()


def test_an_album_called_dj_sets_is_not_a_mix(lib):
    """Only a file the registry recorded, or one whose COMMENT links to one of our
    sources, is a mix; an ordinary album that happens to be titled "DJ Sets"
    is neither listed nor deletable here."""
    music, a, b = lib
    d = music / "claude_test" / "Some Band" / "DJ Sets"
    d.mkdir(parents=True)
    (d / "Track 1.mp3").write_bytes(b"t")                         # no tags at all
    _comment(d / "Track 2.mp3", "Ripped from my CD")              # a comment, not a link
    _comment(d / "Track 3.mp3", "https://open.spotify.com/track/x")   # a link, not our source
    files = [m["file"] for dj in mixes.list_library(str(music), "claude_test")["djs"] for m in dj["mixes"]]
    assert sorted(files) == ["Set.mp3", "Zouktime Sunday.m4a"]
    for f in ("Track 1.mp3", "Track 2.mp3", "Track 3.mp3"):
        with pytest.raises(mixes.MixPathError):
            mixes.delete_library_file(str(music), "claude_test", "Some Band", f)
        assert (d / f).exists()


def test_a_dj_sets_symlink_to_another_album_is_refused(lib):
    """X/DJ Sets → Y/OtherAlbum inside the user's own folder: the resolved path is
    still in the user's tree, so only the folder-name check refuses it."""
    music, a, b = lib
    root = music / "claude_test"
    (root / "Y" / "OtherAlbum").mkdir(parents=True)
    song = root / "Y" / "OtherAlbum" / "song.mp3"
    song.write_bytes(b"s")
    _comment(song, "https://soundcloud.com/y/song")
    (root / "X").mkdir()
    os.symlink(root / "Y" / "OtherAlbum", root / "X" / "DJ Sets")
    with pytest.raises(mixes.MixPathError):
        mixes.delete_library_file(str(music), "claude_test", "X", "song.mp3")
    assert song.exists()


def test_check_now_answers_at_once_while_a_check_runs(monkeypatch, store):
    """Queueing behind the 6-hourly run went past the proxy's 60 s timeout."""
    _follow()

    class HeldLock:          # the 6-hourly run holds the user's lock
        def locked(self):
            return True

        async def __aenter__(self):
            raise AssertionError("Check now must not wait for the running check")

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(mix_follows, "_user_lock", lambda username: HeldLock())
    r = _client(OK, monkeypatch).post("/api/mixes/follows/check")
    assert r.status_code == 200 and r.json()["status"] == "already_running"
    # The background run itself still waits its turn.
    with pytest.raises(AssertionError, match="must not wait"):
        asyncio.run(mix_follows.check_user("claude_test", wait=True))
