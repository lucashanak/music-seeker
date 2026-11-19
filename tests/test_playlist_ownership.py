"""Ownership on the legacy playlist write endpoints (app/routers/library.py).

Every endpoint that changes a Navidrome playlist (or its app-side cover) asks
`_own_playlist` first: 404 when Navidrome does not show the playlist, 403 when
it is someone else's — and in both cases NOTHING is written. The rule is
`library.owns_playlist`, the same one the playlist manager uses:

- a bound user owns the playlists their own Navidrome account owns;
- the admin on the shared service account owns that account's playlists;
- anyone else on the service account owns none of them, EXCEPT their own
  per-device temp queues (`__upnext_<user>_<dev>`, `__radio_<user>_<dev>`).

Navidrome is faked at the HTTP level (httpx.MockTransport), as in
test_playlist_transfer.py; every updatePlaylist / deletePlaylist that reaches it
is recorded, and the cover file lives in tmp_path.
"""
import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import bind_navidrome_creds
from app.routers import library as library_router
from app.services import auth, library, navidrome_admin

SVC = "svc"        # the shared service account (NAVIDROME_USER)
ADMIN = "boss"     # the app admin (NAVIDROME_ADMIN_USER)
FOUND_ID = "99"    # what find_song_id answers for every track


class FakeNavidrome:
    def __init__(self):
        # id -> {"name", "owner", "rows"}
        self.pl = {}
        self.writes = []   # (endpoint, playlist id)

    def add(self, pid, name, owner, rows=("1", "2", "3")):
        self.pl[pid] = {"name": name, "owner": owner, "rows": list(rows)}

    async def handler(self, request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0)
        q = request.url.params
        path = request.url.path
        ok = httpx.Response(200, json={"subsonic-response": {"status": "ok"}})
        failed = httpx.Response(200, json={"subsonic-response": {"status": "failed"}})
        if path == "/rest/getPlaylist":
            p = self.pl.get(q.get("id"))
            if p is None:
                return failed
            entries = [{"id": s, "title": f"T{s}", "artist": "A"} for s in p["rows"]]
            return httpx.Response(200, json={"subsonic-response": {"status": "ok", "playlist": {
                "id": q.get("id"), "name": p["name"], "owner": p["owner"],
                "songCount": len(entries), "entry": entries}}})
        if path == "/rest/updatePlaylist":
            pid = q.get("playlistId")
            self.writes.append(("updatePlaylist", pid))
            p = self.pl.get(pid)
            if p is None:
                return failed
            drop = {int(i) for i in q.get_list("songIndexToRemove")}
            p["rows"] = [s for i, s in enumerate(p["rows"]) if i not in drop]
            p["rows"] += q.get_list("songIdToAdd")
            if q.get("name") is not None:
                p["name"] = q.get("name")
            return ok
        if path == "/rest/deletePlaylist":
            pid = q.get("id")
            self.writes.append(("deletePlaylist", pid))
            return ok if self.pl.pop(pid, None) is not None else failed
        return httpx.Response(404)


@pytest.fixture
def env(monkeypatch, tmp_path):
    fake = FakeNavidrome()
    real = httpx.AsyncClient
    transport = httpx.MockTransport(fake.handler)
    monkeypatch.setattr(library.httpx, "AsyncClient",
                        lambda *a, **kw: real(*a, **{**kw, "transport": transport}))
    monkeypatch.setattr(library, "NAVIDROME_PASSWORD", "x")
    monkeypatch.setattr(library, "NAVIDROME_USER", SVC)
    monkeypatch.setattr(navidrome_admin, "NAVIDROME_ADMIN_USER", ADMIN)
    covers = tmp_path / "playlist_covers.json"
    monkeypatch.setattr(library_router, "PLAYLIST_COVERS_FILE", str(covers))

    async def _find(name, artist="", album=""):
        return FOUND_ID
    monkeypatch.setattr(library, "find_song_id", _find)

    jobs = []

    def _create_job(**kw):
        class _J:
            id = f"job{len(jobs)}"
        jobs.append(kw)
        return _J()

    async def _run(job):
        return None
    monkeypatch.setattr(library_router, "create_job", _create_job)
    monkeypatch.setattr(library_router.downloader, "run_download", _run)

    app = FastAPI()
    app.include_router(library_router.router)
    who = {"username": "alice"}
    app.dependency_overrides[auth.get_current_user] = lambda: who

    async def _bind():
        # who["creds"] None = the request talks through the service account.
        library.set_request_creds(who.get("creds", {"username": who["username"], "password": "x"}))
        return who
    app.dependency_overrides[bind_navidrome_creds] = _bind
    fake.who = who
    fake.covers = covers
    fake.jobs = jobs
    return fake, TestClient(app)


def _covers(fake) -> dict:
    return json.loads(fake.covers.read_text()) if fake.covers.exists() else {}


# Each endpoint: (name, call(client, pid) -> response, wrote(fake, pid) -> bool, prepare(fake, pid)).
# `prepare` puts the state an endpoint needs to have something to write (a cover to clear).

def _nav_wrote(fake, pid):
    return any(p == pid for _, p in fake.writes)


def _cover_set(fake, pid):
    return pid in _covers(fake)


def _cover_cleared(fake, pid):
    return pid not in _covers(fake)


def _seed_cover(fake, pid):
    fake.covers.write_text(json.dumps({pid: "https://img/x.jpg"}))


def _noop(fake, pid):
    pass


ENDPOINTS = [
    ("replace-by-name",
     lambda c, pid: c.post(f"/api/library/playlist/{pid}/replace-by-name",
                           json={"tracks": [{"name": "X", "artist": "A"}]}),
     _nav_wrote, _noop),
    ("put-tracks",
     lambda c, pid: c.put(f"/api/library/playlist/{pid}/tracks", json={"song_ids": ["42"]}),
     _nav_wrote, _noop),
    ("add-by-name",
     lambda c, pid: c.post(f"/api/library/playlist/{pid}/add-by-name", json={"name": "X", "artist": "A"}),
     _nav_wrote, _noop),
    ("delete-tracks",
     lambda c, pid: c.request("DELETE", f"/api/library/playlist/{pid}/tracks", json={"indices": [0]}),
     _nav_wrote, _noop),
    ("rename",
     lambda c, pid: c.put(f"/api/library/playlist/{pid}/rename", json={"name": "New name"}),
     _nav_wrote, _noop),
    ("details",
     lambda c, pid: c.put(f"/api/library/playlist/{pid}/details", json={"description": "d"}),
     _nav_wrote, _noop),
    ("cover-set",
     lambda c, pid: c.post(f"/api/library/playlist/{pid}/cover", json={"image_url": "https://img/y.jpg"}),
     _cover_set, _noop),
    ("cover-delete",
     lambda c, pid: c.delete(f"/api/library/playlist/{pid}/cover"),
     _cover_cleared, _seed_cover),
    ("reorder",
     lambda c, pid: c.put(f"/api/library/playlist/{pid}/reorder", json={"song_ids": ["3", "2", "1"]}),
     _nav_wrote, _noop),
    ("remove-by-name",
     lambda c, pid: c.post(f"/api/library/playlist/{pid}/remove-by-name",
                           json={"name": "T2", "artist": "A", "index": 1}),
     _nav_wrote, _noop),
    ("add-and-download",
     lambda c, pid: c.post(f"/api/library/playlist/{pid}/add-and-download", json={"name": "X", "artist": "A"}),
     _nav_wrote, _noop),
    ("add-and-download-batch",
     lambda c, pid: c.post(f"/api/library/playlist/{pid}/add-and-download-batch",
                           json={"tracks": [{"name": "X", "artist": "A"}]}),
     _nav_wrote, _noop),
    ("delete-playlist",
     lambda c, pid: c.delete(f"/api/library/playlist/{pid}"),
     _nav_wrote, _noop),
]
IDS = [e[0] for e in ENDPOINTS]


def test_all_thirteen_write_endpoints_are_covered():
    assert len(ENDPOINTS) == 13


def _assert_passes(fake, c, ep, pid):
    _, call, wrote, prepare = ep
    prepare(fake, pid)
    r = call(c, pid)
    assert 200 <= r.status_code < 300, r.text
    assert wrote(fake, pid), f"{ep[0]}: answered {r.status_code} but nothing was written"


def _assert_refused(fake, c, ep, pid, status):
    _, call, wrote, prepare = ep
    prepare(fake, pid)
    before = _covers(fake)
    r = call(c, pid)
    assert r.status_code == status, r.text
    assert not _nav_wrote(fake, pid), f"{ep[0]}: refused but wrote {fake.writes}"
    assert _covers(fake) == before, f"{ep[0]}: refused but the cover file changed"
    assert fake.jobs == [], f"{ep[0]}: refused but started a download"


# --- (1) the owner passes -------------------------------------------------------

@pytest.mark.parametrize("ep", ENDPOINTS, ids=IDS)
def test_bound_owner_writes_own_playlist(env, ep):
    fake, c = env
    fake.add("P", "Mine", "alice")
    _assert_passes(fake, c, ep, "P")


# --- (2) another user's playlist: 403, nothing written ---------------------------

@pytest.mark.parametrize("ep", ENDPOINTS, ids=IDS)
def test_another_users_playlist_is_403_and_untouched(env, ep):
    fake, c = env
    fake.add("Q", "Bob's", "bob")
    _assert_refused(fake, c, ep, "Q", 403)
    assert fake.pl["Q"] == {"name": "Bob's", "owner": "bob", "rows": ["1", "2", "3"]}


# --- (3) a service-account user's own temp queue of another device passes --------

@pytest.mark.parametrize("prefix", ["__upnext_", "__radio_"])
@pytest.mark.parametrize("ep", ENDPOINTS, ids=IDS)
def test_service_account_user_writes_own_temp_queue_of_another_device(env, ep, prefix):
    fake, c = env
    fake.who["creds"] = None
    fake.add("T", f"{prefix}alice_otherdev", SVC)
    _assert_passes(fake, c, ep, "T")


# --- the rest of the rule --------------------------------------------------------

@pytest.mark.parametrize("ep", ENDPOINTS, ids=IDS)
def test_service_account_non_admin_owns_no_normal_service_playlist(env, ep):
    fake, c = env
    fake.who["creds"] = None
    fake.add("S", "Shared", SVC)
    _assert_refused(fake, c, ep, "S", 403)


@pytest.mark.parametrize("ep", ENDPOINTS, ids=IDS)
def test_service_account_user_cannot_write_another_users_temp_queue(env, ep):
    fake, c = env
    fake.who["creds"] = None
    fake.add("U", "__upnext_bob_dev", SVC)
    _assert_refused(fake, c, ep, "U", 403)


@pytest.mark.parametrize("ep", ENDPOINTS, ids=IDS)
def test_admin_on_service_account_writes_service_playlist(env, ep):
    fake, c = env
    fake.who.update({"username": ADMIN, "creds": None})
    fake.add("S", "Shared", SVC)
    _assert_passes(fake, c, ep, "S")


@pytest.mark.parametrize("ep", ENDPOINTS, ids=IDS)
def test_missing_playlist_is_404_and_nothing_written(env, ep):
    fake, c = env
    _assert_refused(fake, c, ep, "nope", 404)
    # The ownership check's own 404, not a later "track not found" one.
    assert ep[1](c, "nope").json()["detail"] == "Playlist not found"


@pytest.mark.parametrize("ep", ENDPOINTS, ids=IDS)
def test_username_prefix_does_not_match_a_longer_name(env, ep):
    fake, c = env
    fake.who.update({"username": "bob", "creds": None})
    fake.add("U", "__upnext_bobby_dev", SVC)
    _assert_refused(fake, c, ep, "U", 403)


@pytest.mark.parametrize("ep", ENDPOINTS, ids=IDS)
def test_bound_user_does_not_get_service_temp_queues(env, ep):
    # The temp-queue exception is for service-account callers only: a bound
    # user's own temp queues are owned by their own account.
    fake, c = env
    fake.add("T", "__upnext_alice_otherdev", SVC)
    _assert_refused(fake, c, ep, "T", 403)


def test_temp_queue_with_another_owner_is_refused(env):
    # The name alone is not enough: the queue must be the service account's.
    fake, c = env
    fake.who["creds"] = None
    fake.add("T", "__upnext_alice_dev", "mallory")
    r = c.put("/api/library/playlist/T/tracks", json={"song_ids": ["42"]})
    assert r.status_code == 403
    assert fake.writes == []


def test_underscore_username_does_not_own_another_users_temp_queue(env, monkeypatch):
    # Usernames may contain "_" (auth._USERNAME_RE): "__upnext_claude_test_dev"
    # starts with the prefix of user "claude" too. The longest known user wins.
    monkeypatch.setattr(library, "_known_usernames", lambda: ["claude", "claude_test"])
    fake, c = env
    fake.who.update({"username": "claude", "creds": None})
    fake.add("U", "__upnext_claude_test_dev", SVC)
    r = c.put("/api/library/playlist/U/tracks", json={"song_ids": ["42"]})
    assert r.status_code == 403
    assert fake.writes == []


# --- the playlist manager follows the same rule ---------------------------------

def test_manager_agrees_with_legacy_endpoints_for_bound_owner_and_stranger(env):
    fake, c = env
    fake.add("P", "Mine", "alice")
    fake.add("Q", "Bob's", "bob")
    r = c.post("/api/library/playlist-remove", json={"playlist_id": "Q", "index": 0, "song_id": "1"})
    assert r.status_code == 403
    r = c.post("/api/library/playlist-remove", json={"playlist_id": "P", "index": 0, "song_id": "1"})
    assert r.status_code == 200, r.text


def test_manager_and_legacy_agree_on_service_account_temp_queue(env):
    # One rule: a service-account user's own temp queue passes both the legacy
    # endpoints and the manager; another user's is refused by both.
    fake, c = env
    fake.who["creds"] = None
    fake.add("T", "__upnext_alice_otherdev", SVC)
    fake.add("B", "__upnext_bob_dev", SVC)
    assert c.put("/api/library/playlist/T/tracks", json={"song_ids": ["42"]}).status_code == 200
    r = c.post("/api/library/playlist-remove", json={"playlist_id": "T", "index": 0, "song_id": "1"})
    assert r.status_code == 200, r.text
    assert c.put("/api/library/playlist/B/tracks", json={"song_ids": ["42"]}).status_code == 403
    r = c.post("/api/library/playlist-remove", json={"playlist_id": "B", "index": 0, "song_id": "1"})
    assert r.status_code == 403


# --- temp-queue GC keeps to the caller's own queues ------------------------------

def test_gc_temp_playlists_spares_a_longer_usernames_queues(monkeypatch):
    import asyncio
    monkeypatch.setattr(library, "_known_usernames", lambda: ["bob", "bob_x"])
    pls = [{"id": "1", "name": "__upnext_bob_d1", "changed": "1"},
           {"id": "2", "name": "__upnext_bob_x_d2", "changed": "2"},
           {"id": "3", "name": "__upnext_bob_x_d3", "changed": "3"}]

    async def fake_get():
        return pls
    deleted = []

    async def fake_del(pid):
        deleted.append(pid)
        return True
    monkeypatch.setattr(library, "get_playlists", fake_get)
    monkeypatch.setattr(library, "delete_playlist", fake_del)
    asyncio.run(library.gc_temp_playlists("bob", library.UPNEXT_PREFIX, keep=0))
    assert deleted == ["1"]


def test_temp_queue_user_picks_the_longest_known_name():
    users = ["claude", "claude_test", "bob"]
    assert library.temp_queue_user("__upnext_claude_test_dev", users) == "claude_test"
    assert library.temp_queue_user("__radio_claude_dev_1", users) == "claude"
    assert library.temp_queue_user("__upnext_eve_dev", users) is None
    assert library.temp_queue_user("Mix", users) is None


def test_manager_transfer_between_own_temp_queues_on_service_account(env):
    fake, c = env
    fake.who["creds"] = None
    fake.add("T", "__upnext_alice_dev1", SVC)
    fake.add("R", "__radio_alice_dev2", SVC)
    fake.add("B", "__upnext_bob_dev", SVC)
    body = {"from_id": "T", "from_index": 0, "song_id": "1", "to_id": "R", "mode": "copy"}
    r = c.post("/api/library/playlist-transfer", json=body)
    assert r.status_code == 200, r.text
    r = c.post("/api/library/playlist-transfer", json={**body, "to_id": "B"})
    assert r.status_code == 403
