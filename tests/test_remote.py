"""Device → device remote control: the broker and its HTTP surface.

The broker is one process's memory, so these tests drive it directly: a
connection is `remote.register_listener(...)`, what it would stream is
`remote.listen(conn, token)`. The HTTP endpoints run through TestClient with
the session dependency overridden (the user is whoever the fixture says).
"""
import asyncio
import json
import re
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import bind_navidrome_creds
from app.routers import player as player_router
from app.routers import remote as remote_router
from app.services import auth, player, remote


USERS = {
    "alice": {"devices": {"phone": {"name": "Phone"}, "pc": {"name": "PC"}}},
    "bob": {"devices": {"tablet": {"name": "Tablet"}}},
    # A pair the old flat queue names confused: claude + device test_x
    # = claude_test + device x = `claude_test_x.json`.
    "claude": {"devices": {"test_x": {"name": "Attacker"}}},
    "claude_test": {"devices": {"x": {"name": "Victim"}}},
}


@pytest.fixture(autouse=True)
def broker(monkeypatch, tmp_path):
    users = {k: json.loads(json.dumps(v)) for k, v in USERS.items()}
    monkeypatch.setattr(auth, "_load_users", lambda: users)
    monkeypatch.setattr(player, "PLAYER_DIR", tmp_path)
    remote._reset_for_tests()
    yield users
    remote._reset_for_tests()


def client_for(username: str) -> TestClient:
    app = FastAPI()
    app.include_router(remote_router.router)
    app.include_router(player_router.router)

    async def _user():
        return {"username": username}
    app.dependency_overrides[bind_navidrome_creds] = _user
    app.dependency_overrides[auth.get_current_user] = _user
    return TestClient(app)


def drain(conn) -> list[dict]:
    out = list(conn.cmds)
    conn.cmds.clear()
    conn.devices_dirty = False
    return out


def commands(conn) -> list[dict]:
    return drain(conn)


def report(username, device, tab, **state):
    remote.update_state(username, device, remote.sanitize_state(state), tab_id=tab)


async def collect(conn, token, ping=0.05, limit=1.0, max_events=50):
    """Run listen() until it ends by itself or `limit` seconds pass. Returns
    (events, ended_by_itself)."""
    events = []

    async def run():
        async for ev in remote.listen(conn, token, ping_interval=ping):
            events.append(ev)
            if len(events) >= max_events:
                return

    try:
        await asyncio.wait_for(run(), timeout=limit)
        return events, True
    except asyncio.TimeoutError:
        return events, False


# ── delivery: one device, one tab ──

def test_a_command_reaches_only_the_target_device():
    phone = remote.register_listener("alice", "phone", "t1")
    pc = remote.register_listener("alice", "pc", "t1")
    drain(phone), drain(pc)

    cmd = remote.send_command("alice", "pc", "next", None, from_device="phone")

    assert [c["action"] for c in commands(pc)] == ["next"]
    assert commands(phone) == []
    assert cmd["from"] == "phone" and cmd["id"] == 1 and abs(cmd["ts"] - time.time()) < 2


def test_a_command_reaches_one_tab_the_one_that_plays():
    old = remote.register_listener("alice", "pc", "tabA")
    new = remote.register_listener("alice", "pc", "tabB")
    report("alice", "pc", "tabA", playing=True)
    report("alice", "pc", "tabB", playing=False)
    drain(old), drain(new)

    remote.send_command("alice", "pc", "pause")
    assert [c["action"] for c in commands(old)] == ["pause"]
    assert commands(new) == []

    # Nobody has played yet → the newest connection gets it, and only it.
    remote._reset_for_tests()
    a = remote.register_listener("alice", "pc", "tabA")
    b = remote.register_listener("alice", "pc", "tabB")
    drain(a), drain(b)
    remote.send_command("alice", "pc", "play")
    assert commands(a) == []
    assert [c["action"] for c in commands(b)] == ["play"]


def test_the_tab_that_started_playing_last_wins_and_does_not_flip():
    a = remote.register_listener("alice", "pc", "tabA")
    b = remote.register_listener("alice", "pc", "tabB")
    report("alice", "pc", "tabA", playing=True)
    time.sleep(0.01)
    report("alice", "pc", "tabB", playing=True)
    time.sleep(0.01)
    report("alice", "pc", "tabA", playing=True)   # A's routine 3 s report
    drain(a), drain(b)

    remote.send_command("alice", "pc", "next")
    assert commands(a) == []
    assert len(commands(b)) == 1


def test_the_snapshot_shows_the_delivery_tab_not_the_last_report():
    a = remote.register_listener("alice", "pc", "tabA")
    remote.register_listener("alice", "pc", "tabB")
    report("alice", "pc", "tabA", playing=True, track={"name": "Playing one"})
    report("alice", "pc", "tabB", playing=False, track={"name": "Idle tab"})

    dev = remote.snapshot("alice")["pc"]
    assert dev["track"]["name"] == "Playing one"
    assert dev["playing"] is True
    assert dev["online"] is True and dev["name"] == "PC"
    assert "server_time" in dev and dev["updated_at"] > 0
    assert not any(k.startswith("_") for k in dev)
    assert a.tab_id == "tabA"


# ── connections: reconnect, eviction, re-authentication ──

def test_a_reconnect_of_the_same_tab_replaces_the_old_connection():
    first = remote.register_listener("alice", "pc", "tabA")
    second = remote.register_listener("alice", "pc", "tabA")

    assert first.closed.is_set()
    assert not second.closed.is_set()
    assert remote._listeners["alice"]["pc"] == [second]
    drain(first), drain(second)
    remote.send_command("alice", "pc", "next")
    assert commands(first) == [] and len(commands(second)) == 1


def test_an_evicted_connection_ends_its_stream():
    token = auth.create_remote_token("alice", "pc")

    async def scenario():
        victim = remote.register_listener("alice", "pc", "victim")
        task = asyncio.ensure_future(collect(victim, token, ping=0.05, limit=2.0))
        await asyncio.sleep(0.1)
        for i in range(remote._MAX_QUEUES_PER_DEVICE):
            remote.register_listener("alice", "pc", f"t{i}")
        events, ended = await task
        return victim, events, ended

    victim, events, ended = asyncio.run(scenario())
    assert ended, "the evicted generator kept running (deaf, still pinging)"
    assert victim.closed.is_set()
    assert victim not in remote._listeners["alice"]["pc"]
    assert len(remote._listeners["alice"]["pc"]) == remote._MAX_QUEUES_PER_DEVICE


def test_the_stream_ends_when_the_user_is_deleted(broker):
    token = auth.create_remote_token("alice", "pc")

    async def scenario():
        conn = remote.register_listener("alice", "pc", "tabA")
        task = asyncio.ensure_future(collect(conn, token, ping=0.05, limit=2.0))
        await asyncio.sleep(0.12)
        del broker["alice"]
        return await task

    events, ended = asyncio.run(scenario())
    assert ended
    assert ("ping" in [e for e, _ in events])
    assert not remote.is_online("alice", "pc")


def test_the_stream_ends_when_the_token_expires():
    token = auth.create_remote_token("alice", "pc", ttl=1)

    async def scenario():
        conn = remote.register_listener("alice", "pc", "tabA")
        return await collect(conn, token, ping=0.2, limit=4.0, max_events=1000)

    events, ended = asyncio.run(scenario())
    assert ended


def test_the_re_check_runs_even_when_events_never_stop(broker):
    """State reports arrive every 3 s, so the 15 s wait never times out; the
    re-check must run by the clock anyway."""
    token = auth.create_remote_token("alice", "pc")

    async def scenario():
        conn = remote.register_listener("alice", "pc", "tabA")
        task = asyncio.ensure_future(collect(conn, token, ping=0.2, limit=3.0, max_events=10_000))
        await asyncio.sleep(0.05)
        del broker["alice"]
        start = time.monotonic()
        # A steady stream of devices events, never a quiet 0.2 s, for up to 2 s.
        while not task.done() and time.monotonic() - start < 2.0:
            remote._broadcast_devices("alice")
            await asyncio.sleep(0.01)
        _, ended = await task
        return ended, time.monotonic() - start

    ended, elapsed = asyncio.run(scenario())
    assert ended and elapsed < 2.0, "the stream only ended once the events stopped"


def test_events_and_pings_carry_the_server_time():
    token = auth.create_remote_token("alice", "pc")

    async def scenario():
        conn = remote.register_listener("alice", "pc", "tabA")
        return await collect(conn, token, ping=0.05, limit=0.3)

    events, _ = asyncio.run(scenario())
    kinds = {e: d for e, d in events}
    assert abs(kinds["devices"]["server_time"] - time.time()) < 5
    assert "pc" in kinds["devices"]["devices"]
    assert abs(kinds["ping"]["server_time"] - time.time()) < 5


def test_a_command_that_waited_over_5_s_is_dropped():
    token = auth.create_remote_token("alice", "pc")

    async def scenario():
        conn = remote.register_listener("alice", "pc", "tabA")
        stale = remote.send_command("alice", "pc", "next")
        stale["ts"] -= remote.COMMAND_MAX_AGE + 1      # it sat in the queue 6 s
        remote.send_command("alice", "pc", "pause")
        return await collect(conn, token, ping=0.05, limit=0.3)

    events, _ = asyncio.run(scenario())
    got = [d["action"] for e, d in events if e == "command"]
    assert got == ["pause"]


# ── /events authentication ──

def test_events_refuse_a_session_token_and_a_deleted_user(broker):
    c = client_for("alice")
    session = auth._create_token("alice", False)
    r = c.get("/api/remote/events", params={"token": session, "device_id": "pc"})
    assert r.status_code == 401

    gone = auth.create_remote_token("carol", "pc")     # not in users
    r = c.get("/api/remote/events", params={"token": gone, "device_id": "pc"})
    assert r.status_code == 401

    # A stream token (in every <audio> URL) does not open the remote stream (R3 M3),
    # nor does a remote token minted for another device.
    stream = auth.create_stream_token("alice")
    r = c.get("/api/remote/events", params={"token": stream, "device_id": "pc"})
    assert r.status_code == 401
    other = auth.create_remote_token("alice", "phone")
    r = c.get("/api/remote/events", params={"token": other, "device_id": "pc"})
    assert r.status_code == 401

    ok = auth.create_remote_token("alice", "pc")
    r = c.get("/api/remote/events", params={"token": ok, "device_id": "pc", "tab_id": "bad tab!"})
    assert r.status_code == 400
    assert not remote.is_online("alice", "pc")


# ── /command ──

def test_users_are_isolated():
    alice_pc = remote.register_listener("alice", "pc", "tabA")
    drain(alice_pc)
    report("alice", "pc", "tabA", playing=True, track={"name": "Alice's"})

    r = client_for("bob").post("/api/remote/command",
                               json={"target_device_id": "pc", "action": "pause"},
                               headers={"X-Device-ID": "tablet"})
    assert r.status_code == 404
    assert commands(alice_pc) == []
    assert "pc" not in remote.snapshot("bob")
    assert client_for("bob").get("/api/remote/devices").json()["devices"].keys() == {"tablet"}


def test_an_offline_target_gets_404_and_no_queue_file(tmp_path):
    r = client_for("alice").post("/api/remote/command", json={
        "target_device_id": "pc", "action": "transfer",
        "value": {"queue": [{"name": "x"}], "current_index": 0}},
        headers={"X-Device-ID": "phone"})
    assert r.status_code == 404
    assert not (tmp_path / "alice_pc.json").exists()


def test_a_target_that_is_controlling_refuses_with_409(tmp_path):
    pc = remote.register_listener("alice", "pc", "tabA")
    report("alice", "pc", "tabA", controlling="phone")
    drain(pc)

    r = client_for("alice").post("/api/remote/command", json={
        "target_device_id": "pc", "action": "transfer",
        "value": {"queue": [{"name": "x"}], "current_index": 0}},
        headers={"X-Device-ID": "phone"})
    assert r.status_code == 409
    assert r.json()["detail"] == "Device is controlling another device"
    assert commands(pc) == []
    assert not (tmp_path / "alice_pc.json").exists()

    report("alice", "pc", "tabA", controlling=None)
    r = client_for("alice").post("/api/remote/command",
                                 json={"target_device_id": "pc", "action": "toggle"},
                                 headers={"X-Device-ID": "phone"})
    assert r.status_code == 202
    assert [c["action"] for c in commands(pc)] == ["toggle"]


def _save(device, **data):
    player.save_queue("alice", data, device)


def _transfer(value, headers=None):
    return client_for("alice").post("/api/remote/command", json={
        "target_device_id": "pc", "action": "transfer", "value": value},
        headers=headers or {"X-Device-ID": "phone"})


def test_a_transfer_merges_and_keeps_the_targets_volume_and_up_next():
    remote.register_listener("alice", "pc", "tabA")
    _save("pc", queue=[{"name": "old"}], current_index=0, volume=0.8,
          playlist_mode={"id": "pl-upnext-pc", "name": "Up Next"},
          shuffle_order={"played": [0], "tail": []}, radio_mode=True, radio_seed={"name": "s"})

    r = _transfer({"queue": [{"name": "a"}, {"name": "b"}], "current_index": 1,
                   "position_seconds": 42.5, "volume": 0.0,
                   "playlist_mode": {"id": "pl-upnext-phone", "name": "Up Next"}})
    assert r.status_code == 202

    saved = player.load_queue("alice", "pc")
    assert saved["volume"] == 0.8                                   # target's own
    assert saved["playlist_mode"] == {"id": "pl-upnext-pc", "name": "Up Next"}
    assert [t["name"] for t in saved["queue"]] == ["a", "b"]
    assert saved["current_index"] == 1 and saved["position_seconds"] == 42.5
    assert saved["shuffle_order"] is None                          # belonged to the old queue
    assert saved["radio_mode"] is False and saved["radio_seed"] is None


def test_a_transfer_adopts_a_named_playlist_and_the_radio():
    remote.register_listener("alice", "pc", "tabA")
    _save("pc", queue=[], current_index=-1, volume=0.5,
          playlist_mode={"id": "pl-upnext-pc", "name": "Up Next"})

    r = _transfer({"queue": [{"name": "a"}], "current_index": 0,
                   "playlist_mode": {"id": "pl-42", "name": "MyZouk"},
                   "radio_mode": True, "radio_seed": {"name": "seed", "artist": "x"},
                   "shuffle_order": {"played": [0], "tail": []}})
    assert r.status_code == 202
    saved = player.load_queue("alice", "pc")
    assert saved["playlist_mode"] == {"id": "pl-42", "name": "MyZouk"}
    assert saved["radio_mode"] is True and saved["radio_seed"]["name"] == "seed"
    assert saved["shuffle_order"] == {"played": [0], "tail": []}
    assert saved["volume"] == 0.5


@pytest.mark.parametrize("mode", [
    {"id": "x1", "name": "Radio"},
    {"id": "__radio_phone", "name": "whatever"},
    {"id": "x2", "name": "__upnext_phone"},
    None,
])
def test_a_temporary_playlist_is_never_adopted(mode):
    remote.register_listener("alice", "pc", "tabA")
    mine = {"id": "pl-upnext-pc", "name": "Up Next"}
    _save("pc", queue=[], current_index=-1, volume=0.5, playlist_mode=mine)
    assert _transfer({"queue": [{"name": "a"}], "current_index": 0,
                      "playlist_mode": mode}).status_code == 202
    assert player.load_queue("alice", "pc")["playlist_mode"] == mine


def test_a_temporary_transfer_drops_the_targets_named_playlist():
    """The target's MyZouk is no longer what it plays; keeping it would mirror
    the new queue into MyZouk."""
    remote.register_listener("alice", "pc", "tabA")
    _save("pc", queue=[{"name": "z"}], current_index=0, volume=0.5,
          playlist_mode={"id": "pl-42", "name": "MyZouk"})
    assert _transfer({"queue": [{"name": "a"}], "current_index": 0,
                      "playlist_mode": {"id": "u", "name": "Up Next"}}).status_code == 202
    assert player.load_queue("alice", "pc")["playlist_mode"] is None


def test_an_old_client_transfer_merges_the_controllers_file():
    remote.register_listener("alice", "pc", "tabA")
    _save("phone", queue=[{"name": "p1"}, {"name": "p2"}], current_index=1,
          position_seconds=10.0, volume=0.0,
          playlist_mode={"id": "pl-upnext-phone", "name": "Up Next"})
    _save("pc", queue=[], current_index=-1, volume=0.9,
          playlist_mode={"id": "pl-upnext-pc", "name": "Up Next"})

    assert _transfer(None).status_code == 202
    saved = player.load_queue("alice", "pc")
    assert [t["name"] for t in saved["queue"]] == ["p1", "p2"]
    assert saved["current_index"] == 1 and saved["position_seconds"] == 10.0
    assert saved["volume"] == 0.9
    assert saved["playlist_mode"]["id"] == "pl-upnext-pc"


@pytest.mark.parametrize("value", [
    "nope",
    {"queue": "nope"},
    {"queue": [1, 2]},
    {"queue": [{"name": "a"}], "current_index": "0"},
    {"queue": [{"name": "a"}], "current_index": True},
    {"queue": [{"name": "a"}], "position_seconds": "x"},
    {"queue": [{"name": "a"}], "shuffle_order": [1]},
    {"queue": [{"name": "a"}], "radio_mode": "yes"},
    {"queue": [{"name": "a"}], "playlist_mode": "MyZouk"},
    {"queue": [{"name": "a"}] * 5001},
])
def test_a_garbage_transfer_is_refused_and_writes_nothing(value, tmp_path):
    pc = remote.register_listener("alice", "pc", "tabA")
    drain(pc)
    assert _transfer(value).status_code == 400
    assert not (tmp_path / "alice_pc.json").exists()
    assert commands(pc) == []


def test_an_out_of_range_index_is_clamped():
    remote.register_listener("alice", "pc", "tabA")
    assert _transfer({"queue": [{"name": "a"}, {"name": "b"}], "current_index": 9}).status_code == 202
    assert player.load_queue("alice", "pc")["current_index"] == 1


@pytest.mark.parametrize("action,value,status,sent", [
    ("seek", 30, 202, 30.0),
    ("seek", -1, 400, None),
    ("seek", True, 400, None),
    ("volume", 1.7, 202, 1.0),
    ("mute", True, 202, True),
    ("mute", "yes", 400, None),
    ("shuffle", False, 202, False),
    ("repeat", "one", 202, "one"),
    ("repeat", "sometimes", 400, None),
    ("energy_dir", "up", 202, "up"),
    ("energy_dir", "sideways", 400, None),
    ("toggle", "ignored", 202, None),
    ("explode", None, 400, None),
    ("enqueue", [{"name": "a"}] * 250, 202, 200),
    ("enqueue", ["a"], 400, None),
    ("queue_op", {"op": "remove", "index": 3, "name": "x" * 500, "artist": "y", "evil": 1}, 202,
     {"op": "remove", "index": 3, "name": "x" * 300, "artist": "y"}),
    ("queue_op", {"op": "move", "from": 1, "to": 4}, 202,
     {"op": "move", "from": 1, "to": 4, "name": "", "artist": ""}),
    ("queue_op", {"op": "jump", "index": -1}, 400, None),
    ("queue_op", {"op": "insert_next", "items": [{"name": "a"}]}, 202,
     {"op": "insert_next", "items": [{"name": "a"}]}),
    ("queue_op", {"op": "clear", "x": 1}, 202, {"op": "clear"}),
    ("queue_op", {"op": "format_disk"}, 400, None),
])
def test_command_values_are_validated(action, value, status, sent):
    pc = remote.register_listener("alice", "pc", "tabA")
    drain(pc)
    r = client_for("alice").post("/api/remote/command",
                                 json={"target_device_id": "pc", "action": action, "value": value},
                                 headers={"X-Device-ID": "phone"})
    assert r.status_code == status, r.text
    got = commands(pc)
    if status != 202:
        assert got == []
        return
    assert len(got) == 1 and got[0]["action"] == action and got[0]["from"] == "phone"
    if action == "enqueue":
        assert len(got[0]["value"]) == sent
    else:
        assert got[0]["value"] == sent
    assert r.json()["id"] == got[0]["id"] and r.json()["ok"] is True


def test_command_ids_grow_per_user():
    remote.register_listener("alice", "pc", "tabA")
    remote.register_listener("bob", "tablet", "t")
    c = client_for("alice")
    ids = [c.post("/api/remote/command", json={"target_device_id": "pc", "action": "next"}).json()["id"]
           for _ in range(3)]
    assert ids == sorted(ids) and len(set(ids)) == 3
    assert client_for("bob").post("/api/remote/command",
                                  json={"target_device_id": "tablet", "action": "next"}).json()["id"] == 1


# ── /state ──

def test_state_fields_are_whitelisted_and_capped():
    c = client_for("alice")
    remote.register_listener("alice", "pc", "tabA")
    r = c.post("/api/remote/state", headers={"X-Device-ID": "pc"}, json={
        "tab_id": "tabA", "playing": True, "position_seconds": 12, "volume": 7,
        "duration": 200, "muted": True, "shuffle": True, "repeat": "all",
        "index": 3, "queue_len": 9, "queue_rev": 4, "engine": "v3",
        "track": {"name": "n" * 1000, "artist": "a", "lyrics": "x" * 100000, "duration_ms": 1000},
        "next": {"name": "nx", "image": {"nested": "no"}},
        "dj": {"smart_queue": True, "energy_dir": "up", "secret": "s"},
        "controlling": "../etc", "casting": "c" * 400, "radio": True, "ack": 7,
        "junk": "x" * 100000,
    })
    assert r.status_code == 200
    dev = remote.snapshot("alice")["pc"]
    assert "junk" not in dev and "tab_id" not in dev
    assert dev["track"] == {"name": "n" * 300, "artist": "a", "duration_ms": 1000.0}
    assert dev["next"] == {"name": "nx", "image": None}
    assert dev["dj"] == {"smart_queue": True, "energy_dir": "up"}
    assert dev["volume"] == 1.0 and dev["controlling"] is None
    assert len(dev["casting"]) == 300
    assert (dev["playing"], dev["muted"], dev["shuffle"], dev["repeat"]) == (True, True, True, "all")
    assert (dev["index"], dev["queue_len"], dev["queue_rev"], dev["ack"]) == (3, 9, 4, 7)
    assert dev["engine"] == "v3" and dev["radio"] is True and dev["duration"] == 200.0
    assert all(len(json.dumps(v)) < 2000 for v in dev.values())


def test_an_old_clients_state_body_is_still_accepted():
    c = client_for("alice")
    r = c.post("/api/remote/state", headers={"X-Device-ID": "pc"}, json={
        "playing": True, "position_seconds": 3.5, "volume": 0.4,
        "track": {"name": "t", "artist": "a"}})
    assert r.status_code == 200
    dev = remote.snapshot("alice")["pc"]
    assert dev["playing"] is True and dev["position_seconds"] == 3.5
    assert dev["volume"] == 0.4 and dev["track"] == {"name": "t", "artist": "a"}
    assert "default" in remote._states["alice"]["pc"]
    assert c.post("/api/remote/state", headers={"X-Device-ID": "pc"}, json=[1]).status_code == 400


# ── /queue and radio persistence ──

def test_the_remote_queue_is_the_callers_own_device_file():
    _save("pc", queue=[{"name": "a"}], current_index=0, volume=0.3,
          playlist_mode={"id": "p", "name": "MyZouk"}, radio_mode=True,
          radio_seed={"name": "seed"}, shuffle_order={"played": [0], "tail": []})
    player.save_queue("bob", {"queue": [{"name": "bob's"}], "current_index": 0}, "pc")

    r = client_for("alice").get("/api/remote/queue", params={"device": "pc"})
    assert r.status_code == 200
    assert r.json() == {"queue": [{"name": "a"}], "current_index": 0,
                        "shuffle_order": {"played": [0], "tail": []},
                        "playlist_mode": {"id": "p", "name": "MyZouk"}, "radio_mode": True,
                        "radio_seed": {"name": "seed"}}

    assert client_for("bob").get("/api/remote/queue", params={"device": "pc"}).json()["queue"] \
        == [{"name": "bob's"}]
    assert client_for("carol").get("/api/remote/queue", params={"device": "pc"}).json()["queue"] == []
    assert client_for("alice").get("/api/remote/queue",
                                   params={"device": "../bob_pc"}).status_code == 400


def test_the_saved_queue_keeps_the_radio():
    c = client_for("alice")
    r = c.put("/api/player/queue", headers={"X-Device-ID": "pc"}, json={
        "queue": [{"name": "a"}], "current_index": 0,
        "radio_mode": True, "radio_seed": {"name": "seed"}})
    assert r.status_code == 200
    saved = c.get("/api/player/queue", headers={"X-Device-ID": "pc"}).json()
    assert saved["radio_mode"] is True and saved["radio_seed"] == {"name": "seed"}


def test_the_events_endpoint_streams_and_cleans_up():
    """The real endpoint, driven without a server: register on the first read,
    the command in SSE form, unregister when the client goes away."""
    token = auth.create_remote_token("alice", "pc")

    async def scenario():
        resp = await remote_router.remote_events(token=token, device_id="pc", tab_id="tabA")
        it = resp.body_iterator
        first = await it.__anext__()
        online = remote.is_online("alice", "pc")
        remote.send_command("alice", "pc", "pause", from_device="phone")
        chunks = [await asyncio.wait_for(it.__anext__(), 2)]
        await it.aclose()
        return first, online, chunks

    first, online, chunks = asyncio.run(scenario())
    assert first.startswith("event: devices\n") and online
    cmd = [c for c in chunks if c.startswith("event: command\n")]
    assert cmd, chunks
    data = json.loads(cmd[0].split("data: ", 1)[1])
    assert data["action"] == "pause" and data["from"] == "phone" and "ts" in data and "id" in data
    assert not remote.is_online("alice", "pc")



# ── R3 M1: queue files live in a directory per user ──

def test_two_users_with_a_prefix_name_never_share_a_queue_file(tmp_path):
    player.save_queue("claude_test", {"queue": [{"name": "victim's"}], "volume": 0.5}, "x")
    player.save_queue("claude", {"queue": [{"name": "PWNED"}]}, "test_x")

    assert player.load_queue("claude_test", "x")["queue"] == [{"name": "victim's"}]
    assert player.load_queue("claude", "test_x")["queue"] == [{"name": "PWNED"}]
    assert (tmp_path / "users" / "claude_test" / "x.json").exists()
    assert (tmp_path / "users" / "claude" / "test_x.json").exists()
    assert not list(tmp_path.glob("*.json")), "a flat file was written"


def test_an_ambiguous_legacy_file_is_never_read(tmp_path):
    """The victim's pre-directory files `claude_test_x.json` and `claude_test.json`
    look like claude's devices test_x and test. claude must read neither."""
    (tmp_path / "claude_test_x.json").write_text(json.dumps({"queue": [{"name": "victim x"}]}))
    (tmp_path / "claude_test.json").write_text(json.dumps({"queue": [{"name": "victim default"}]}))

    assert player.load_queue("claude", "test_x")["queue"] == []
    assert player.load_queue("claude", "test")["queue"] == []
    r = client_for("claude").get("/api/remote/queue", params={"device": "test_x"})
    assert r.json()["queue"] == []
    # `claude_test_x.json`: both claude (device test_x) and claude_test (device x)
    # have the device registered, so nobody reads it. `claude_test.json`: claude
    # has no device `test`, so it is claude_test's default file.
    assert player.load_queue("claude_test", "x", fallback=False) == {}
    assert player.load_queue("claude_test", "default")["queue"] == [{"name": "victim default"}]


def test_a_transfer_cannot_write_another_users_file(tmp_path):
    (tmp_path / "claude_test_x.json").write_text(json.dumps({"queue": [{"name": "victim x"}]}))
    remote.register_listener("claude", "test_x", "t")
    r = client_for("claude").post("/api/remote/command", json={
        "target_device_id": "test_x", "action": "transfer",
        "value": {"queue": [{"name": "PWNED"}], "current_index": 0}})
    assert r.status_code == 202
    assert json.loads((tmp_path / "claude_test_x.json").read_text())["queue"] == [{"name": "victim x"}]
    player.save_queue("claude_test", {"queue": [{"name": "victim new"}]}, "x")
    remote.register_listener("claude", "test_x", "t")
    assert client_for("claude").post("/api/remote/command", json={
        "target_device_id": "test_x", "action": "transfer",
        "value": {"queue": [{"name": "PWNED"}], "current_index": 0}}).status_code == 202
    assert player.load_queue("claude_test", "x")["queue"] == [{"name": "victim new"}]


def test_an_unambiguous_legacy_file_still_loads_and_is_not_rewritten(tmp_path):
    (tmp_path / "alice_phone.json").write_text(json.dumps({"queue": [{"name": "old phone"}]}))
    (tmp_path / "alice.json").write_text(json.dumps({"queue": [{"name": "old default"}]}))

    assert player.load_queue("alice", "phone")["queue"] == [{"name": "old phone"}]
    assert player.load_queue("alice", "default")["queue"] == [{"name": "old default"}]
    assert player.load_queue("alice", "newdevice")["queue"] == [{"name": "old default"}]

    player.save_queue("alice", {"queue": [{"name": "new"}]}, "phone")
    assert json.loads((tmp_path / "alice_phone.json").read_text())["queue"] == [{"name": "old phone"}]
    assert player.load_queue("alice", "phone")["queue"] == [{"name": "new"}]


def test_clearing_a_queue_removes_its_legacy_file_but_never_a_foreign_one(tmp_path):
    (tmp_path / "alice_phone.json").write_text(json.dumps({"queue": [{"name": "old"}]}))
    player.save_queue("alice", {"queue": [{"name": "new"}]}, "phone")
    player.clear_queue("alice", "phone")
    assert player.load_queue("alice", "phone")["queue"] == []

    (tmp_path / "claude_test_x.json").write_text("{}")
    player.clear_queue("claude", "test_x")
    assert (tmp_path / "claude_test_x.json").exists()


def test_removing_a_device_never_deletes_another_users_file(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "_save_users", lambda users: None)
    (tmp_path / "claude_test_x.json").write_text("{}")
    player.save_queue("claude", {"queue": [{"name": "mine"}]}, "test_x")

    assert auth.remove_device("claude", "test_x") is True
    assert (tmp_path / "claude_test_x.json").exists()
    assert not (tmp_path / "users" / "claude" / "test_x.json").exists()


@pytest.mark.parametrize("name", ["alice_x", "claude_test_y", "bob_1", "claude"])
def test_create_user_refuses_a_name_in_a_prefix_relation(name, monkeypatch, broker):
    broker.pop("claude")          # "claude" then clashes as the SHORTER name
    monkeypatch.setattr(auth, "_save_users", lambda users: pytest.fail("saved"))
    with pytest.raises(ValueError, match="too similar"):
        auth.create_user(name, "longenoughpassword")


def test_create_user_accepts_an_unrelated_name(monkeypatch):
    saved = []
    monkeypatch.setattr(auth, "_save_users", lambda users: saved.append(set(users)))
    assert auth.create_user("alicex", "longenoughpassword") is True    # no "_" between
    assert "alicex" in saved[0]


def test_a_queue_file_is_written_atomically_and_compact(tmp_path, monkeypatch):
    player.save_queue("alice", {"queue": [{"name": "kept"}]}, "pc")
    path = tmp_path / "users" / "alice" / "pc.json"
    assert "\n" not in path.read_text() and ": " not in path.read_text()

    def boom(*a, **k):
        raise RuntimeError("killed mid-write")
    monkeypatch.setattr(player.os, "replace", boom)
    with pytest.raises(RuntimeError):
        player.save_queue("alice", {"queue": [{"name": "lost"}]}, "pc")
    assert json.loads(path.read_text())["queue"] == [{"name": "kept"}]
    assert [p.name for p in path.parent.iterdir()] == ["pc.json"]


def test_the_transfer_runs_its_file_io_in_a_thread(monkeypatch):
    calls = []
    real = asyncio.to_thread

    async def spy(fn, *a, **k):
        calls.append(fn.__name__)
        return await real(fn, *a, **k)
    monkeypatch.setattr(remote_router.asyncio, "to_thread", spy)
    remote.register_listener("alice", "pc", "t")
    assert _transfer({"queue": [{"name": "a"}], "current_index": 0}).status_code == 202
    assert calls == ["_apply_transfer"]


# ── R3 M2: bounded state, coalesced snapshots ──

def test_states_are_capped_per_user_and_per_device():
    for i in range(remote.MAX_STATE_DEVICES + 5):
        report("alice", f"dev{i}", "t", playing=False)
    devices = remote._states["alice"]
    assert len(devices) == remote.MAX_STATE_DEVICES
    assert "dev0" not in devices and f"dev{remote.MAX_STATE_DEVICES + 4}" in devices

    for i in range(remote.MAX_STATE_TABS + 4):
        report("alice", "pc", f"tab{i}", playing=False)
    tabs = remote._states["alice"]["pc"]
    assert len(tabs) == remote.MAX_STATE_TABS and "tab0" not in tabs and "tab11" in tabs


def test_a_stalled_connection_holds_no_snapshots():
    stalled = remote.register_listener("alice", "pc", "t")
    for i in range(500):
        report("alice", "phone", "t", playing=bool(i % 2))
    assert len(stalled.cmds) == 0
    assert stalled.devices_dirty is True


def test_many_updates_reach_a_reader_as_one_devices_event():
    token = auth.create_remote_token("alice", "pc")

    async def scenario():
        conn = remote.register_listener("alice", "pc", "t")
        gen = remote.listen(conn, token, ping_interval=60)
        first = await gen.__anext__()
        for i in range(100):
            report("alice", "phone", "t", position_seconds=i)
        second = await asyncio.wait_for(gen.__anext__(), 1)
        try:
            await asyncio.wait_for(gen.__anext__(), 0.2)
            more = True
        except asyncio.TimeoutError:
            more = False
        await gen.aclose()
        return first, second, more

    first, second, more = asyncio.run(scenario())
    assert first[0] == "devices" and second[0] == "devices"
    assert second[1]["devices"]["phone"]["position_seconds"] == 99.0   # built at send time
    assert not more


def test_too_many_online_devices_are_refused():
    for i in range(remote.MAX_LISTENING_DEVICES):
        remote.register_listener("alice", f"d{i}", "t")
    assert not remote.may_register("alice", "one-more")
    assert remote.may_register("alice", "d0")             # a known device reconnects
    token = auth.create_remote_token("alice", "one-more")
    r = client_for("alice").get("/api/remote/events",
                                params={"token": token, "device_id": "one-more"})
    assert r.status_code == 429


# ── R3 M3: a remote token of its own ──

def test_the_token_endpoint_mints_a_device_bound_remote_token():
    c = client_for("alice")
    r = c.get("/api/remote/token", params={"device_id": "pc"})
    assert r.status_code == 200
    body = r.json()
    assert body["expires_in"] == 3600
    p = auth._decode_token(body["token"])
    assert p["aud"] == "remote" and p["dev"] == "pc" and p["sub"] == "alice"
    assert 3500 < p["exp"] - time.time() <= 3600
    assert c.get("/api/remote/token", params={"device_id": "../x"}).status_code == 400


def test_a_remote_token_is_not_a_session():
    app = FastAPI()
    app.include_router(remote_router.router)       # real get_current_user
    c = TestClient(app)
    remote_tok = auth.create_remote_token("alice", "pc")
    r = c.get("/api/remote/token", params={"device_id": "pc"},
              headers={"Authorization": f"Bearer {remote_tok}"})
    assert r.status_code == 401
    session = auth._create_token("alice", False)
    r = c.get("/api/remote/token", params={"device_id": "pc"},
              headers={"Authorization": f"Bearer {session}"})
    assert r.status_code == 200


def test_the_re_check_refuses_a_token_for_another_device():
    token = auth.create_remote_token("alice", "phone")

    async def scenario():
        conn = remote.register_listener("alice", "pc", "t")
        return await collect(conn, token, ping=0.05, limit=1.0)

    _, ended = asyncio.run(scenario())
    assert ended
    assert not remote.token_still_valid(auth.create_stream_token("alice"), "alice", "pc")


# ── R3 L1, L2, L4, L5 ──

def test_a_huge_integer_is_a_400_not_a_500():
    pc = remote.register_listener("alice", "pc", "t")
    c = client_for("alice")
    huge = int("9" * 400)
    for action in ("seek", "volume"):
        r = c.post("/api/remote/command",
                   json={"target_device_id": "pc", "action": action, "value": huge})
        assert r.status_code == 400
    assert _transfer({"queue": [], "position_seconds": huge}).status_code == 400
    r = c.post("/api/remote/state", headers={"X-Device-ID": "pc"},
               json={"position_seconds": huge, "index": huge, "track": {"duration_ms": huge},
                     "dj": {"fade_beats": huge}})
    assert r.status_code == 200
    dev = remote.snapshot("alice")["pc"]
    assert dev["position_seconds"] == 0.0 and dev["index"] == -1
    assert dev["dj"]["fade_beats"] is None
    assert commands(pc) == []


def test_queue_items_are_bounded():
    pc = remote.register_listener("alice", "pc", "t")
    drain(pc)
    item = {"name": "n" * 5000, "artist": "a", "duration_ms": 1000, "inLibrary": True,
            "nested": {"deep": "x" * 10_000}, "bad key!": 1, "tags": ["a", {"x": 1}, "b"],
            **{f"k{i}": i for i in range(100)}}
    r = client_for("alice").post("/api/remote/command",
                                 json={"target_device_id": "pc", "action": "enqueue", "value": [item]})
    assert r.status_code == 202
    got = commands(pc)[0]["value"][0]
    assert got["name"] == "n" * 1000 and got["artist"] == "a" and got["inLibrary"] is True
    assert "nested" not in got and "bad key!" not in got
    assert got["tags"] == ["a", "b"]
    assert len(got) <= 40

    assert _transfer({"queue": [item], "current_index": 0}).status_code == 202
    saved = player.load_queue("alice", "pc")["queue"][0]
    assert saved == got


def test_playlist_mode_and_shuffle_order_are_checked():
    remote.register_listener("alice", "pc", "t")
    bad_id = {"queue": [{"name": "a"}], "playlist_mode": {"id": "../../x", "name": "P"}}
    assert _transfer(bad_id).status_code == 400
    not_str = {"queue": [{"name": "a"}], "playlist_mode": {"id": 5, "name": "P"}}
    assert _transfer(not_str).status_code == 400
    assert _transfer({"queue": [{"name": "a"}], "shuffle_order": {"played": ["0"]}}).status_code == 400

    q = [{"name": str(i)} for i in range(3)]
    assert _transfer({"queue": q, "current_index": 0,
                      "shuffle_order": {"played": [0, 0, 7], "tail": [2, -1, 1], "evil": [1]}}
                     ).status_code == 202
    assert player.load_queue("alice", "pc")["shuffle_order"] == {"played": [0], "tail": [2, 1]}


def test_a_command_already_waiting_is_delivered_even_if_the_connection_closes():
    token = auth.create_remote_token("alice", "pc")

    async def scenario():
        conn = remote.register_listener("alice", "pc", "t")
        gen = remote.listen(conn, token, ping_interval=60)
        await gen.__anext__()                                  # devices
        remote.send_command("alice", "pc", "pause")
        conn.close()                                           # both ready at once
        events = [ev async for ev in gen]
        return events

    events = asyncio.run(scenario())
    assert [d["action"] for e, d in events if e == "command"] == ["pause"]


def test_a_reconnect_takes_over_the_pending_commands():
    old = remote.register_listener("alice", "pc", "t")
    remote.send_command("alice", "pc", "next")
    new = remote.register_listener("alice", "pc", "t")
    assert [c["action"] for c in commands(new)] == ["next"]
    assert commands(old) == []


def test_idle_users_are_swept():
    report("bob", "tablet", "t", playing=False)
    remote._cmd_ids["bob"] = 7
    for tabs in remote._states["bob"].values():
        for st in tabs.values():
            st["updated_at"] -= remote._STATE_TTL + 1
    remote._last_sweep = 0.0
    report("alice", "pc", "t", playing=False)
    assert "bob" not in remote._states
    assert "bob" not in remote._cmd_ids



# ── adversarial review: empty transfer, transfer payload, fresh tabs, epoch ──

def test_an_empty_transfer_is_refused_and_writes_nothing(tmp_path):
    pc = remote.register_listener("alice", "pc", "t")
    drain(pc)
    r = _transfer({"queue": [], "current_index": -1})
    assert r.status_code == 400 and r.json()["detail"] == "Nothing to transfer"
    assert not (tmp_path / "users" / "alice" / "pc.json").exists()
    assert commands(pc) == []
    _save("phone", queue=[], current_index=-1)               # an old client, empty file
    assert _transfer(None).status_code == 400


def test_the_transfer_command_carries_the_merged_queue():
    pc = remote.register_listener("alice", "pc", "t")
    drain(pc)
    _save("pc", queue=[{"name": "old"}], current_index=0, volume=0.7,
          playlist_mode={"id": "upnext-pc", "name": "Up Next"})

    r = _transfer({"queue": [{"name": "a", "nested": {"x": 1}}, {"name": "b"}], "current_index": 1,
                   "position_seconds": 12.0, "volume": 0.0, "radio_mode": True,
                   "radio_seed": {"name": "s"}, "shuffle_order": {"played": [1], "tail": [0]},
                   "playlist_mode": {"id": "upnext-phone", "name": "Up Next"}})
    assert r.status_code == 202
    [cmd] = commands(pc)
    v = cmd["value"]
    assert set(v) == {"transfer_id", "queue", "current_index", "position_seconds",
                      "shuffle_order", "playlist_mode", "radio_mode", "radio_seed"}
    assert v["queue"] == [{"name": "a"}, {"name": "b"}]                 # sanitised
    assert (v["current_index"], v["position_seconds"]) == (1, 12.0)
    assert v["playlist_mode"] == {"id": "upnext-pc", "name": "Up Next"}  # the target's own
    assert v["radio_mode"] is True and v["radio_seed"] == {"name": "s"}
    assert v["shuffle_order"] == {"played": [1], "tail": [0]}
    saved = player.load_queue("alice", "pc")
    assert saved["transfer_id"] == v["transfer_id"] and len(v["transfer_id"]) == 32
    assert saved["volume"] == 0.7
    assert {k: saved[k] for k in v} == v

    _transfer({"queue": [{"name": "c"}], "current_index": 0})
    assert commands(pc)[0]["value"]["transfer_id"] != v["transfer_id"]


def test_a_silent_tab_does_not_swallow_commands(monkeypatch):
    frozen = remote.register_listener("alice", "pc", "frozen")
    report("alice", "pc", "frozen", playing=True)           # played last …
    awake = remote.register_listener("alice", "pc", "awake")
    report("alice", "pc", "awake", playing=False)
    drain(frozen), drain(awake)
    remote.send_command("alice", "pc", "next")
    assert len(commands(frozen)) == 1                        # both fresh: the player wins

    later = time.time() + remote.FRESH_FOR + 1               # … then froze
    monkeypatch.setattr(remote.time, "time", lambda: later)
    remote._states["alice"]["pc"]["awake"]["updated_at"] = later
    remote.send_command("alice", "pc", "next")
    assert commands(frozen) == []
    assert len(commands(awake)) == 1
    assert remote.snapshot("alice")["pc"]["playing"] is False   # the view follows too


def test_a_just_opened_connection_counts_as_fresh(monkeypatch):
    old = remote.register_listener("alice", "pc", "old")
    report("alice", "pc", "old", playing=True)
    later = time.time() + remote.FRESH_FOR + 1
    monkeypatch.setattr(remote.time, "time", lambda: later)
    new = remote.register_listener("alice", "pc", "new")     # opened now, no report yet
    drain(old), drain(new)
    remote.send_command("alice", "pc", "pause")
    assert commands(old) == [] and len(commands(new)) == 1


def test_commands_carry_the_process_epoch():
    pc = remote.register_listener("alice", "pc", "t")
    drain(pc)
    r = client_for("alice").post("/api/remote/command",
                                 json={"target_device_id": "pc", "action": "next"})
    body = r.json()
    [cmd] = commands(pc)
    assert body["epoch"] == cmd["epoch"] == remote.EPOCH and body["id"] == cmd["id"]
    assert re.fullmatch(r"[0-9a-f]{8}", remote.EPOCH)


@pytest.mark.parametrize("ack,stored", [
    ("ab12cd34:17", "ab12cd34:17"),
    (17, 17),
    ("ab12cd34:x", 0),
    ("a:b:1", 0),
    ("e" * 33 + ":1", 0),
    ("ab:" + "1" * 16, 0),
    ("ab12cd34:17\n", 0),
    (True, 0),
])
def test_the_ack_is_an_epoch_and_an_id(ack, stored):
    report("alice", "pc", "t", ack=ack)
    assert remote.snapshot("alice")["pc"]["ack"] == stored



# ── R1 N2: the registered devices decide whose legacy file it is ──

def _flat(tmp_path, stem, name):
    (tmp_path / f"{stem}.json").write_text(json.dumps({"queue": [{"name": name}]}))


def test_a_legacy_file_goes_to_the_user_whose_device_it_is(tmp_path, broker):
    _flat(tmp_path, "claude_test_x", "theirs")
    broker["claude"]["devices"] = {}                      # only claude_test has a device x
    assert player.load_queue("claude_test", "x")["queue"] == [{"name": "theirs"}]
    assert player.load_queue("claude", "test_x", fallback=False) == {}


def test_the_other_direction(tmp_path, broker):
    _flat(tmp_path, "claude_test_x", "theirs")
    broker["claude_test"]["devices"] = {}                 # only claude has a device test_x
    assert player.load_queue("claude", "test_x")["queue"] == [{"name": "theirs"}]
    assert player.load_queue("claude_test", "x", fallback=False) == {}


def test_an_ambiguous_file_nobody_registered_is_refused(tmp_path, broker):
    _flat(tmp_path, "claude_test_x", "theirs")
    broker["claude"]["devices"] = {}
    broker["claude_test"]["devices"] = {}
    assert player.load_queue("claude", "test_x", fallback=False) == {}
    assert player.load_queue("claude_test", "x", fallback=False) == {}


def test_a_default_file_is_refused_only_when_another_user_registered_that_device(tmp_path, broker):
    _flat(tmp_path, "claude_test", "default of claude_test")
    assert player.load_queue("claude_test")["queue"] == [{"name": "default of claude_test"}]
    assert player.load_queue("claude", "test", fallback=False) == {}   # claude_test owns it

    broker["claude"]["devices"]["test"] = {"name": "claude's test"}
    assert player.load_queue("claude_test")["queue"] == []
    assert player.load_queue("claude", "test", fallback=False) == {}   # both claim it


def test_unambiguous_legacy_files_need_no_registration(tmp_path):
    _flat(tmp_path, "alice_unregistered", "old")
    assert player.load_queue("alice", "unregistered")["queue"] == [{"name": "old"}]


# ── R1 N3: the remote paths never borrow the default device's queue ──

def test_a_target_without_a_file_starts_empty_not_from_the_default_queue(tmp_path):
    player.save_queue("alice", {"queue": [{"name": "default q"}], "volume": 0.2,
                                "playlist_mode": {"id": "pl-9", "name": "MyZouk"}}, "default")
    assert player.load_queue("alice", "pc")["queue"] == [{"name": "default q"}]   # others unchanged

    r = client_for("alice").get("/api/remote/queue", params={"device": "pc"})
    assert r.json()["queue"] == [] and r.json()["playlist_mode"] is None

    remote.register_listener("alice", "pc", "t")
    assert _transfer({"queue": [{"name": "a"}], "current_index": 0}).status_code == 202
    saved = json.loads((tmp_path / "users" / "alice" / "pc.json").read_text())
    assert "volume" not in saved
    assert saved.get("playlist_mode") is None
    assert saved["queue"] == [{"name": "a"}]


# ── R2 ──

def test_the_ping_and_freshness_cadence():
    """Clients report on every ping; a hidden tab's timers run ~1/min but it still
    answers a ping, so FRESH_FOR must outlast several pings, and the token
    re-check (once per ping) stays at most 15 s apart."""
    assert remote.PING_INTERVAL <= 10.0
    assert remote.FRESH_FOR >= 3 * remote.PING_INTERVAL
    assert remote.FRESH_FOR < 60.0


def test_a_remote_token_is_not_a_stream_credential(monkeypatch):
    from app import dependencies

    async def creds(user):
        return {}
    monkeypatch.setattr(dependencies, "_resolve_navidrome_creds", creds)
    monkeypatch.setattr(dependencies.library_service, "set_request_creds", lambda c: None)

    async def call(token):
        try:
            return await dependencies._stream_auth(None, token)
        except Exception as e:      # HTTPException
            return e

    remote_tok = auth.create_remote_token("alice", "pc")
    r = asyncio.run(call(remote_tok))
    assert getattr(r, "status_code", None) == 401
    ok = asyncio.run(call(auth.create_stream_token("alice")))
    assert ok["username"] == "alice"
    ok = asyncio.run(call(auth._create_token("alice", False)))   # as before: a session works too
    assert ok["username"] == "alice"


def test_a_username_ending_in_json_does_not_collide_with_a_legacy_file(tmp_path, broker):
    broker["a"] = {"devices": {}}
    broker["a.json"] = {"devices": {}}
    (tmp_path / "a.json").write_text(json.dumps({"queue": [{"name": "a's old"}]}))

    player.save_queue("a.json", {"queue": [{"name": "x"}]}, "pc")
    assert player.load_queue("a.json", "pc")["queue"] == [{"name": "x"}]
    assert player.load_queue("a")["queue"] == [{"name": "a's old"}]
    player.save_queue("a", {"queue": [{"name": "a new"}]})
    assert player.load_queue("a")["queue"] == [{"name": "a new"}]


def test_two_transfers_to_one_target_land_in_order(monkeypatch):
    import httpx
    pc = remote.register_listener("alice", "pc", "t")
    drain(pc)
    real_merge = remote_router.merge_transfer

    def slow_merge(saved, src):
        if src["queue"][0]["name"] == "first":
            time.sleep(0.4)         # the first one is slow to merge
        return real_merge(saved, src)
    monkeypatch.setattr(remote_router, "merge_transfer", slow_merge)

    app = client_for("alice").app

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            async def send(name, delay):
                await asyncio.sleep(delay)
                return await c.post("/api/remote/command", json={
                    "target_device_id": "pc", "action": "transfer",
                    "value": {"queue": [{"name": name}], "current_index": 0}})
            return await asyncio.gather(send("first", 0), send("second", 0.1))

    r1, r2 = asyncio.run(scenario())
    assert r1.status_code == r2.status_code == 202
    got = [c["value"]["queue"][0]["name"] for c in commands(pc)]
    assert got == ["first", "second"]
    assert player.load_queue("alice", "pc")["queue"] == [{"name": "second"}]
