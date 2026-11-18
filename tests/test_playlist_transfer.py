"""Playlist manager: move / copy / reorder one track (POST /api/library/playlist-transfer).

Navidrome is faked at the HTTP level (httpx.MockTransport) with Subsonic's real
semantics — songIdToAdd appends, songIndexToRemove removes by position in the
list as it was before the request — so reorder_playlist and update_playlist run
as they do in production.
"""
import asyncio

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import bind_navidrome_creds
from app.routers import library as library_router
from app.services import auth, library


class FakeNavidrome:
    def __init__(self, playlists: dict[str, list[str]], readonly=()):
        self.pl = {k: list(v) for k, v in playlists.items()}
        self.readonly = set(readonly)
        self.refuse_ids = set()      # songIdToAdd values Navidrome answers "failed" to
        self.html_on_add = False     # an append answered by a non-JSON page (a proxy error)
        self.lose_strip_reply = False  # a removal applied, but its answer never arrives
        self.writes = []
        self.params = []             # (playlistId, n_add, n_remove) per write
        self.owner = {}              # playlist id -> Navidrome owner (default "alice")

    async def handler(self, request: httpx.Request) -> httpx.Response:
        # Yield first, as a network round trip would: concurrent writers can
        # then interleave between their requests unless something serialises them.
        await asyncio.sleep(0)
        q = request.url.params
        path = request.url.path
        if path == "/rest/getPlaylist":
            pid = q.get("id")
            if pid not in self.pl:
                return httpx.Response(200, json={"subsonic-response": {"status": "failed"}})
            entries = [{"id": s, "title": f"T{s}", "artist": "A"} for s in self.pl[pid]]
            return httpx.Response(200, json={"subsonic-response": {"status": "ok", "playlist": {
                "id": pid, "name": pid, "songCount": len(entries), "entry": entries,
                "owner": self.owner.get(pid, "alice")}}})
        if path == "/rest/getPlaylists":
            return httpx.Response(200, json={"subsonic-response": {"status": "ok", "playlists": {
                "playlist": [{"id": pid, "name": pid, "songCount": len(rows),
                              "owner": self.owner.get(pid, "alice")} for pid, rows in self.pl.items()]}}})
        if path == "/rest/updatePlaylist":
            pid = q.get("playlistId")
            self.writes.append(pid)
            adds, rems = q.get_list("songIdToAdd"), q.get_list("songIndexToRemove")
            self.params.append((pid, len(adds), len(rems)))
            if pid not in self.pl or pid in self.readonly or self.refuse_ids & set(adds):
                return httpx.Response(200, json={"subsonic-response": {"status": "failed"}})
            rows = self.pl[pid]
            drop = {int(i) for i in q.get_list("songIndexToRemove")}
            rows = [s for i, s in enumerate(rows) if i not in drop]
            rows += q.get_list("songIdToAdd")
            self.pl[pid] = rows
            if adds and self.html_on_add:
                return httpx.Response(200, text="<html>502 Bad Gateway</html>")
            if rems and self.lose_strip_reply:
                raise httpx.ReadTimeout("lost", request=request)
            return httpx.Response(200, json={"subsonic-response": {"status": "ok"}})
        return httpx.Response(404)


@pytest.fixture
def env(monkeypatch):
    fake = FakeNavidrome({"A": ["1", "2", "3", "4"], "B": ["7", "8", "9"], "R": ["5"]}, readonly={"R"})
    real = httpx.AsyncClient
    transport = httpx.MockTransport(fake.handler)
    monkeypatch.setattr(library.httpx, "AsyncClient",
                        lambda *a, **kw: real(*a, **{**kw, "transport": transport}))
    monkeypatch.setattr(library, "NAVIDROME_PASSWORD", "x")
    app = FastAPI()
    app.include_router(library_router.router)
    who = {"username": "alice"}
    app.dependency_overrides[auth.get_current_user] = lambda: who

    async def _bind():
        # As bind_navidrome_creds does for a provisioned user; with who["creds"]
        # None the request talks through the shared service account.
        library.set_request_creds(who.get("creds", {"username": who["username"], "password": "x"}))
        return who
    app.dependency_overrides[bind_navidrome_creds] = _bind
    fake.who = who
    return fake, TestClient(app)


def _post(client, **kw):
    return client.post("/api/library/playlist-transfer", json=kw)


def ids(tracks):
    return [t["id"] for t in tracks]


def test_reorder_within_one_playlist(env):
    fake, c = env
    r = _post(c, from_id="A", from_index=0, song_id="1", to_id="A", to_index=2)
    assert r.status_code == 200, r.text
    assert fake.pl["A"] == ["2", "3", "1", "4"]
    assert r.json()["status"] == "reordered"
    assert ids(r.json()["to"]) == ["2", "3", "1", "4"]


def test_reorder_to_the_end_and_to_the_top(env):
    fake, c = env
    assert _post(c, from_id="A", from_index=1, song_id="2", to_id="A").status_code == 200
    assert fake.pl["A"] == ["1", "3", "4", "2"]
    assert _post(c, from_id="A", from_index=3, song_id="2", to_id="A", to_index=0).status_code == 200
    assert fake.pl["A"] == ["2", "1", "3", "4"]


def test_dropping_a_row_where_it_already_is_writes_nothing(env):
    fake, c = env
    r = _post(c, from_id="A", from_index=1, song_id="2", to_id="A", to_index=1)
    assert r.json()["status"] == "unchanged"
    assert fake.writes == []


def test_move_to_a_position_in_another_playlist(env):
    fake, c = env
    r = _post(c, from_id="A", from_index=1, song_id="2", to_id="B", to_index=1)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "moved" and body["removed"] and body["placed"]
    assert fake.pl["A"] == ["1", "3", "4"]
    assert fake.pl["B"] == ["7", "2", "8", "9"]
    assert ids(body["from"]) == fake.pl["A"] and ids(body["to"]) == fake.pl["B"]


def test_move_without_position_appends(env):
    fake, c = env
    _post(c, from_id="A", from_index=3, song_id="4", to_id="B")
    assert fake.pl["B"] == ["7", "8", "9", "4"]
    assert fake.pl["A"] == ["1", "2", "3"]


def test_copy_leaves_the_source_alone(env):
    fake, c = env
    r = _post(c, from_id="A", from_index=0, song_id="1", to_id="B", to_index=0, mode="copy")
    assert r.json()["status"] == "copied" and not r.json()["removed"]
    assert fake.pl["A"] == ["1", "2", "3", "4"]
    assert fake.pl["B"] == ["1", "7", "8", "9"]


def test_a_stale_row_is_refused_and_nothing_is_written(env):
    fake, c = env
    # The client drew A as it was before; index 0 now holds a different song.
    r = _post(c, from_id="A", from_index=0, song_id="3", to_id="B")
    assert r.status_code == 409
    assert fake.writes == []
    assert _post(c, from_id="A", from_index=9, song_id="1", to_id="B").status_code == 409
    assert _post(c, from_id="A", from_index=-1, song_id="1", to_id="B").status_code == 409


def test_a_track_already_in_the_target_is_not_added_twice(env):
    fake, c = env
    fake.pl["B"].append("2")
    r = _post(c, from_id="A", from_index=1, song_id="2", to_id="B", to_index=0)
    assert r.json()["status"] == "already"
    assert fake.pl["B"].count("2") == 1
    # A move still takes it out of the source: the user wants it in B, not in A.
    assert fake.pl["A"] == ["1", "3", "4"]


def test_a_refused_add_removes_nothing(env):
    fake, c = env
    r = _post(c, from_id="A", from_index=0, song_id="1", to_id="R")
    assert r.status_code == 502
    assert fake.pl["A"] == ["1", "2", "3", "4"]


def test_a_source_that_cannot_be_written_leaves_a_copy_and_says_so(env):
    fake, c = env
    r = _post(c, from_id="R", from_index=0, song_id="5", to_id="B")
    assert r.status_code == 200
    assert r.json()["removed"] is False
    assert fake.pl["R"] == ["5"] and fake.pl["B"][-1] == "5"


def test_missing_playlist_is_404(env):
    _, c = env
    assert _post(c, from_id="nope", from_index=0, song_id="1", to_id="B").status_code == 404
    assert _post(c, from_id="A", from_index=0, song_id="1", to_id="nope").status_code == 404


def test_duplicate_rows_move_the_named_one(env):
    fake, c = env
    fake.pl["A"] = ["1", "2", "1", "3"]
    _post(c, from_id="A", from_index=2, song_id="1", to_id="B")
    assert fake.pl["A"] == ["1", "2", "3"]


def test_a_reorder_rewrites_only_from_the_first_change(env):
    fake, c = env
    fake.pl["L"] = [str(i) for i in range(100)]
    r = _post(c, from_id="L", from_index=99, song_id="99", to_id="L", to_index=97)
    assert r.status_code == 200
    assert fake.pl["L"] == [str(i) for i in range(97)] + ["99", "97", "98"]
    added = sum(a for _, a, _ in fake.params)
    removed = sum(r for _, _, r in fake.params)
    assert (added, removed) == (3, 3)


def test_a_refused_append_during_a_reorder_leaves_the_playlist_as_it_was(env):
    fake, c = env
    fake.pl["L"] = [str(i) for i in range(30)]
    fake.refuse_ids = {"25"}            # the second batch of 20 carries it
    r = _post(c, from_id="L", from_index=29, song_id="29", to_id="L", to_index=0)
    assert r.status_code == 502
    assert fake.pl["L"] == [str(i) for i in range(30)]


def test_a_failed_placement_in_the_target_keeps_the_track_at_the_end(env):
    fake, c = env
    fake.pl["B"] = [str(i) for i in range(10, 40)]
    fake.refuse_ids = {"25"}            # the placing reorder's second batch fails
    r = _post(c, from_id="A", from_index=0, song_id="1", to_id="B", to_index=0)
    body = r.json()
    assert r.status_code == 200 and body["placed"] is False and body["removed"] is True
    assert fake.pl["B"] == [str(i) for i in range(10, 40)] + ["1"]
    assert fake.pl["A"] == ["2", "3", "4"]


def test_reordering_a_playlist_that_cannot_be_written_is_an_error(env):
    fake, c = env
    fake.pl["R"] = ["5", "6"]
    r = _post(c, from_id="R", from_index=0, song_id="5", to_id="R", to_index=1)
    assert r.status_code == 502
    assert fake.pl["R"] == ["5", "6"]


def test_concurrent_writes_to_one_playlist_do_not_interleave(env):
    fake, _ = env
    fake.pl["L"] = [str(i) for i in range(50)]
    fake.pl["B"] = []

    async def all_at_once():
        return await asyncio.gather(
            library.transfer_track("L", 0, "0", "L", None),
            library.reorder_playlist("L", [str(i) for i in range(49, -1, -1)]),
            library.transfer_track("L", 49, "49", "B", 0),
            library.transfer_track("L", 5, "5", "L", 40),
            return_exceptions=True,
        )
    results = asyncio.run(all_at_once())
    # Some may be refused as stale (an earlier write moved their row) — but no
    # write may run inside another: every song is in exactly one place, once.
    assert all(not isinstance(r, Exception) or isinstance(r, library.TransferStale) for r in results), results
    together = fake.pl["L"] + fake.pl["B"]
    assert sorted(together, key=int) == [str(i) for i in range(50)]


def test_remove_at_names_the_row_by_index_and_song(env):
    fake, c = env
    r = c.post("/api/library/playlist-remove", json={"playlist_id": "A", "index": 1, "song_id": "2"})
    assert r.status_code == 200 and [t["id"] for t in r.json()["tracks"]] == ["1", "3", "4"]
    r = c.post("/api/library/playlist-remove", json={"playlist_id": "A", "index": 1, "song_id": "2"})
    assert r.status_code == 409
    assert fake.pl["A"] == ["1", "3", "4"]


def test_a_non_json_reply_to_an_append_is_undone(env):
    fake, c = env
    fake.html_on_add = True
    r = _post(c, from_id="A", from_index=3, song_id="4", to_id="A", to_index=0)
    assert r.status_code == 502
    assert fake.pl["A"] == ["1", "2", "3", "4"]


def test_a_lost_reply_to_the_strip_does_not_strip_again(env):
    fake, _ = env
    fake.pl["L"] = ["A", "B"]
    fake.lose_strip_reply = True
    ok = asyncio.run(library.reorder_playlist("L", ["C", "A", "B"]))
    # The write landed; only its answer was lost. Nothing original may go.
    assert fake.pl["L"] == ["C", "A", "B"]
    assert ok is True


def test_a_task_started_inside_a_locked_region_does_not_inherit_the_lock(env):
    fake, _ = env
    order = []

    async def scenario():
        child = None
        async with library.playlist_lock("A"):
            async def other():
                async with library.playlist_lock("A"):
                    order.append("child")
            child = asyncio.create_task(other())
            await asyncio.sleep(0.01)
            order.append("parent-done")
        await child
    asyncio.run(scenario())
    assert order == ["parent-done", "child"]


# ── Only the user's own playlists ──

def test_playlists_mark_the_users_own(env):
    fake, c = env
    fake.owner["B"] = "bob"
    own = {p["id"]: p["own"] for p in c.get("/api/library/playlists").json()["playlists"]}
    assert own == {"A": True, "B": False, "R": True}


def test_no_transfer_into_or_out_of_someone_elses_playlist(env):
    fake, c = env
    fake.owner["B"] = "bob"
    assert _post(c, from_id="A", from_index=0, song_id="1", to_id="B").status_code == 403
    assert _post(c, from_id="B", from_index=0, song_id="7", to_id="A").status_code == 403
    assert _post(c, from_id="B", from_index=0, song_id="7", to_id="B", to_index=2).status_code == 403
    assert _post(c, from_id="A", from_index=0, song_id="1", to_id="B", mode="copy").status_code == 403
    assert fake.writes == []
    assert fake.pl["A"] == ["1", "2", "3", "4"] and fake.pl["B"] == ["7", "8", "9"]


def test_no_remove_from_someone_elses_playlist(env):
    fake, c = env
    fake.owner["B"] = "bob"
    r = c.post("/api/library/playlist-remove", json={"playlist_id": "B", "index": 0, "song_id": "7"})
    assert r.status_code == 403
    assert fake.writes == [] and fake.pl["B"] == ["7", "8", "9"]


def test_a_user_on_the_shared_account_owns_none_of_its_playlists(env, monkeypatch):
    # Provisioning failed: the request runs as the service account, which can
    # write the admin's playlists. They are still not this user's.
    fake, c = env
    monkeypatch.setattr(library, "NAVIDROME_USER", "lucas")
    fake.who["creds"] = None
    fake.owner.update({"A": "lucas", "B": "lucas"})
    assert not any(p["own"] for p in c.get("/api/library/playlists").json()["playlists"])
    assert _post(c, from_id="A", from_index=0, song_id="1", to_id="B").status_code == 403
    fake.owner["A"] = ""   # no owner reported must not match "owns nothing"
    assert _post(c, from_id="A", from_index=0, song_id="1", to_id="A", to_index=2).status_code == 403
    assert fake.writes == []


def test_the_admin_owns_the_service_accounts_playlists(env, monkeypatch):
    from app.services import navidrome_admin
    fake, c = env
    monkeypatch.setattr(library, "NAVIDROME_USER", "lucas")
    monkeypatch.setattr(navidrome_admin, "NAVIDROME_ADMIN_USER", "lucas")
    fake.who.update({"username": "lucas", "creds": None})
    fake.owner.update({"A": "lucas", "B": "lucas", "R": "bob"})
    own = {p["id"]: p["own"] for p in c.get("/api/library/playlists").json()["playlists"]}
    assert own == {"A": True, "B": True, "R": False}
    assert _post(c, from_id="A", from_index=0, song_id="1", to_id="B").status_code == 200
    assert fake.pl["B"] == ["7", "8", "9", "1"]
