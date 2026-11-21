"""The server follows an active cast: it sees a track end, casts the next one, gives
up on a receiver that stopped answering, and survives a restart (review of
2026-11-19, findings 1, 2, 3, 5, 6, 7, 10, 12, 13, 14, 19).

Nothing here touches the network. The renderer is a fake that answers the UPnP
actions the server sends; time is a fake clock the test moves, and the follower's
ticks are driven one by one (`_follow_tick`) except where the real loop is the
point (`stop()` must end it).
"""
import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from app.services import dlna, player

AVT = "urn:schemas-upnp-org:service:AVTransport:1"
RC = "urn:schemas-upnp-org:service:RenderingControl:1"
UDN = "uuid:onkyo"
LOC = "http://192.168.1.45:8888/upnp_descriptor_0"
SK = "lucas:phone1"

A = {"name": "Alpha", "artist": "DJ One", "album": "", "image": "", "duration_ms": 200000}
B = {"name": "Bravo", "artist": "DJ Two", "album": "", "image": "", "duration_ms": 200000}
C = {"name": "Charlie", "artist": "DJ Three", "album": "", "image": "", "duration_ms": 200000}
D = {"name": "Delta", "artist": "DJ Four", "album": "", "image": "", "duration_ms": 200000}


class FakeRenderer:
    """A renderer's AVTransport and RenderingControl, as far as the server asks."""

    def __init__(self):
        self.state = "STOPPED"
        self.pos = 0
        self.dur = 0
        self.volume = 40
        self.fail_av = False
        self.fail_vol = False
        self.uri = ""            # TrackURI: what the renderer says it is playing
        self.echo = None         # how it reports back the URL it was given
        self.on_stop = None
        self.log = []            # every call, in order: ("Play",), ("Seek", unit, target), …
        self.cast = []           # titles given to SetAVTransportURI
        av, rc = FakeService(self), FakeService(self)
        self.services = {AVT: av, RC: rc}

    async def handle(self, name, kw):
        self.log.append((name, kw.get("Unit"), kw.get("Target")) if name == "Seek" else (name,))
        if name in ("GetTransportInfo", "GetPositionInfo") and self.fail_av:
            raise RuntimeError(f"Error during async_call(), action: {name}, status: 501")
        if name == "GetTransportInfo":
            return {"CurrentTransportState": self.state, "CurrentTransportStatus": "OK"}
        if name == "GetPositionInfo":
            return {"RelTime": dlna._hms(self.pos), "TrackURI": self.uri,
                    "TrackDuration": dlna._hms(self.dur) if self.dur else "0:00:00"}
        if name == "GetVolume":
            if self.fail_vol:
                raise RuntimeError("GetVolume failed")
            return {"CurrentVolume": self.volume}
        if name == "Seek":
            return {}
        raise AssertionError(name)


class FakeService:
    def __init__(self, r):
        self.r = r

    def action(self, name):
        r = self.r

        class _A:
            async def async_call(self, **kw):
                return await r.handle(name, kw)
        return _A()


class FakeDmr:
    def __init__(self, r: FakeRenderer):
        self.r = r
        self.device = SimpleNamespace(services=r.services)

    async def async_set_transport_uri(self, url, title, meta_data=None):
        self.r.log.append(("SetAVTransportURI",))
        self.r.cast.append(title)
        self.r.uri = self.r.echo(url) if self.r.echo else url
        self.r.state, self.r.pos = "TRANSITIONING", 0

    async def async_play(self):
        self.r.log.append(("Play",))
        self.r.state = "PLAYING"

    async def async_pause(self):
        self.r.state = "PAUSED_PLAYBACK"

    async def async_stop(self):
        self.r.log.append(("Stop",))
        if self.r.on_stop:
            await self.r.on_stop()
        self.r.state = "STOPPED"

    async def async_set_volume_level(self, level):
        self.r.volume = int(level * 100)


async def _coro(v):
    return v


@pytest.fixture
def env(monkeypatch, tmp_path):
    """One renderer, a fake clock, a private queue directory and sessions file, and a
    follower that does not run by itself (tests call _follow_tick)."""
    dlna._devices.clear()
    dlna._sessions.clear()
    dlna._abandoned.clear()
    dlna._resuming.clear()
    dlna._resume_pending = False
    dlna._devices[UDN] = {"name": "Onkyo", "location": LOC, "udn": UDN, "ip": "192.168.1.45"}
    r = FakeRenderer()
    clock = {"t": 1000.0}
    started = []

    class Factory:
        def __init__(self):
            self.made = []
            self.dead = set()

        async def async_create_device(self, location):
            self.made.append(location)
            if location in self.dead:
                raise asyncio.TimeoutError()
            return SimpleNamespace(udn=UDN, friendly_name="Onkyo")

    factory = Factory()
    import async_upnp_client.profiles.dlna as profile
    monkeypatch.setattr(profile, "DmrDevice", lambda device, state: FakeDmr(r))
    monkeypatch.setattr(dlna, "_get_factory", lambda: _coro(factory))
    monkeypatch.setattr(dlna, "_get_server_url", lambda: "http://10.0.0.5:8090")
    monkeypatch.setattr(dlna, "_resolve_cast_mime", lambda name, artist: _coro("audio/flac"))
    monkeypatch.setattr(dlna, "PLAY_RETRY_DELAYS", (0, 0, 0, 0, 0))
    monkeypatch.setattr(dlna, "SEEK_RETRY_DELAYS", (0,))
    monkeypatch.setattr(dlna, "_now", lambda: clock["t"])
    monkeypatch.setattr(dlna, "SESSIONS_FILE", tmp_path / "dlna_sessions.json")
    monkeypatch.setattr(player, "PLAYER_DIR", tmp_path / "player")
    monkeypatch.setattr(dlna, "_ensure_follower", lambda key, s: started.append(key))
    yield SimpleNamespace(r=r, clock=clock, factory=factory, started=started, tmp=tmp_path)
    for s in dlna._sessions.values():
        dlna._cancel_follower(s)
    dlna._devices.clear()
    dlna._sessions.clear()
    dlna._abandoned.clear()


def save_queue(items, current=0, shuffle_order=None):
    data = {"queue": [dict(i) for i in items], "current_index": current, "position_seconds": 12.0,
            "volume": 1.0}
    if shuffle_order is not None:
        data["shuffle_order"] = shuffle_order
    player.save_queue("lucas", data, "phone1")


def saved_queue():
    return player.load_queue("lucas", "phone1")


async def client_cast(item, qi, nxt=None, repeat="off", shuffle=False, start=0.0):
    return await dlna.cast_to_device(
        SK, UDN, item["name"], item["artist"], "tok", album=item.get("album", ""),
        image=item.get("image", ""), duration_ms=item.get("duration_ms", 0),
        start_seconds=start, queue_index=qi,
        next_item=({**nxt[1], "queue_index": nxt[0]} if nxt else None),
        repeat=repeat, shuffle=shuffle, username="lucas", client_device="phone1", by="client")


async def tick(env, at, state, pos, dur=200):
    env.clock["t"] = at
    env.r.state, env.r.pos, env.r.dur = state, pos, dur
    await dlna._follow_tick(SK, dlna._sessions[SK])


async def play_to_end(env, t0=1000.0, dur=200):
    """The track plays, then the renderer stops at its end."""
    await tick(env, t0 + 2, "PLAYING", 2, dur)
    await tick(env, t0 + 4, "PLAYING", 4, dur)
    await tick(env, t0 + 6 + dur, "STOPPED", 0, dur)


# ── finding 3: the position goes along with the cast ──

def test_cast_with_start_seconds_seeks_after_play(env):
    async def main():
        assert await client_cast(A, 0, start=2725.4)
    asyncio.run(main())
    names = [c[0] for c in env.r.log]
    assert names.index("Play") < names.index("Seek")
    seek = [c for c in env.r.log if c[0] == "Seek"][0]
    assert seek[2] == "00:45:25"


def test_cast_from_zero_sends_no_seek(env):
    asyncio.run(client_cast(A, 0))
    assert not [c for c in env.r.log if c[0] == "Seek"]


# ── finding 2 + 19: what the status reports ──

def test_status_names_the_device_and_the_track(env):
    async def main():
        await client_cast(A, 0)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert st["device_id"] == UDN and st["location"] == LOC and st["device"] == "Onkyo"
    assert st["follow"] is True and st["cast_seq"] == 1
    assert st["track"]["queue_index"] == 0 and st["track"]["by"] == "client"
    assert st["track"]["name"] == "Alpha"
    assert st["duration_seconds"] == 200      # the renderer said 0 → the client's duration
    assert st["queue_ended"] is False and "stale" not in st


def test_volume_is_left_out_when_getvolume_fails_and_kept_between_queries(env, monkeypatch):
    monkeypatch.setattr(dlna, "STATUS_CACHE_TTL", 0)
    monkeypatch.setattr(dlna, "VOLUME_EVERY", 3)

    async def main():
        await client_cast(A, 0)
        out = [(await dlna.get_status(SK)).get("volume", "absent")]      # poll 0: asked → 40
        env.r.fail_vol = True
        env.r.volume = 99
        for _ in range(3):                                  # polls 1, 2: not asked; 3: asked, fails
            env.clock["t"] += 1
            out.append((await dlna.get_status(SK)).get("volume", "absent"))
        return out
    vols = asyncio.run(main())
    assert vols == [40, 40, 40, "absent"]       # unknown → no key (a cached page showed "null%")
    vol_calls = [c for c in env.r.log if c[0] == "GetVolume"]
    assert len(vol_calls) == 2


# ── finding 6: one poll for many askers, calls gathered ──

def test_concurrent_status_requests_share_one_poll(env, monkeypatch):
    monkeypatch.setattr(dlna, "STATUS_CACHE_TTL", 0)

    async def main():
        await client_cast(A, 0)
        env.r.log.clear()
        return await asyncio.gather(*[dlna.get_status(SK) for _ in range(5)])
    sts = asyncio.run(main())
    assert all(s["state"] == "PLAYING" for s in sts)
    assert [c[0] for c in env.r.log].count("GetTransportInfo") == 1


def test_status_is_answered_from_a_fresh_sample(env):
    async def main():
        await client_cast(A, 0)
        await dlna.get_status(SK)
        env.r.log.clear()
        env.clock["t"] += 1.0                  # younger than STATUS_CACHE_TTL
        await dlna.get_status(SK)
    asyncio.run(main())
    assert env.r.log == []


# ── finding 7: a receiver that stopped answering ──

def test_failing_renderer_goes_stale_then_the_session_is_abandoned_once(env, monkeypatch):
    monkeypatch.setattr(dlna, "STATUS_CACHE_TTL", 0)

    async def main():
        await client_cast(A, 0)
        env.r.fail_av = True
        out = []
        for _ in range(int(dlna.STALE_SECONDS // 2)):        # 60 s of failed polls
            env.clock["t"] += 2
            out.append(await dlna.get_status(SK))
        return out
    out = asyncio.run(main())
    assert all(s and s["stale"] is True for s in out[:-1])
    assert out[-1] is None
    assert SK not in dlna._sessions
    msg = dlna.take_abandoned(SK)
    assert msg and "Onkyo" in msg
    assert dlna.take_abandoned(SK) is None          # said once


def test_a_single_failed_poll_does_not_end_anything(env, monkeypatch):
    monkeypatch.setattr(dlna, "STATUS_CACHE_TTL", 0)

    async def main():
        await client_cast(A, 0)
        env.r.fail_av = True
        env.clock["t"] += 2
        s1 = await dlna.get_status(SK)
        env.r.fail_av = False
        env.clock["t"] += 2
        return s1, await dlna.get_status(SK)
    s1, s2 = asyncio.run(main())
    assert s1["stale"] is True and s1["state"] == "unknown"
    assert "stale" not in s2 and s2["state"] == "PLAYING"


# ── finding 1: the server advances the queue ──

def test_end_of_track_casts_the_hinted_next(env):
    save_queue([A, B, C, D], current=0)

    async def main():
        await client_cast(A, 0, nxt=(2, C))
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Alpha", "Charlie"]
    assert st["track"]["name"] == "Charlie" and st["track"]["by"] == "server"
    assert st["track"]["queue_index"] == 2 and st["cast_seq"] == 2
    q = saved_queue()
    assert q["current_index"] == 2 and q["position_seconds"] == 0


def test_without_a_hint_the_saved_queue_is_followed(env):
    save_queue([A, B, C], current=0)

    async def main():
        await client_cast(A, 0)
        await play_to_end(env)
        await play_to_end(env, t0=env.clock["t"])
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Bravo", "Charlie"]
    assert saved_queue()["current_index"] == 2


def test_a_hint_is_used_once_then_the_queue_takes_over(env):
    save_queue([A, B, C, D], current=0)

    async def main():
        await client_cast(A, 0, nxt=(2, C))
        await play_to_end(env)
        await play_to_end(env, t0=env.clock["t"])
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Charlie", "Delta"]


def test_shuffle_takes_the_saved_tail_and_writes_the_order_back(env):
    save_queue([A, B, C, D], current=0, shuffle_order={"played": [], "tail": [3, 1, 2]})

    async def main():
        await client_cast(A, 0, shuffle=True)
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Delta"]
    q = saved_queue()
    assert q["current_index"] == 3
    assert q["shuffle_order"] == {"played": [0], "tail": [1, 2]}


def test_exhausted_shuffle_with_repeat_all_deals_a_new_order(env):
    save_queue([A, B, C], current=2, shuffle_order={"played": [0, 1], "tail": []})

    async def main():
        await client_cast(C, 2, shuffle=True, repeat="all")
        await play_to_end(env)
    asyncio.run(main())
    assert len(env.r.cast) == 2 and env.r.cast[1] in ("Alpha", "Bravo")
    q = saved_queue()
    order = q["shuffle_order"]
    assert order["played"] == [2]
    assert sorted(order["tail"] + [q["current_index"]]) == [0, 1]


def test_repeat_all_wraps_to_the_first_track(env):
    save_queue([A, B, C], current=2)

    async def main():
        await client_cast(C, 2, repeat="all")
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Charlie", "Alpha"]
    assert saved_queue()["current_index"] == 0


def test_repeat_one_plays_the_same_track_again(env):
    save_queue([A, B, C], current=1)

    async def main():
        await client_cast(B, 1, repeat="one")
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Bravo", "Bravo"]


def test_end_of_the_queue_casts_nothing_and_says_so(env):
    save_queue([A, B, C], current=2)

    async def main():
        await client_cast(C, 2)
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie"]
    assert st["queue_ended"] is True
    assert SK in dlna._sessions                  # the session stays


def test_the_current_track_is_found_by_name_when_its_index_moved(env):
    # The client inserted a track before it: index 0 now holds something else.
    save_queue([D, A, B], current=1)

    async def main():
        await client_cast(A, 0)
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Bravo"]


# ── end detection ──

def test_end_is_seen_across_a_gap_in_the_samples(env):
    """PLAYING at 70 s of 300, nothing heard for 240 s, then STOPPED with position
    0: the track ended. Without carrying the position over the gap it looks like a
    stop at 70 s and the queue never moves (the stuck episodes of 2026-11-19)."""
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 70, 300)
        await tick(env, 1242, "STOPPED", 0, 300)
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Bravo"]


def test_a_stop_in_the_middle_does_not_advance(env):
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 70, 300)
        await tick(env, 1004, "STOPPED", 0, 300)
    asyncio.run(main())
    assert env.r.cast == ["Alpha"]


def test_pause_is_not_an_end(env):
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 190, 200)
        await tick(env, 1004, "PAUSED_PLAYBACK", 192, 200)
        await tick(env, 1100, "PAUSED_PLAYBACK", 192, 200)
    asyncio.run(main())
    assert env.r.cast == ["Alpha"]


def test_unknown_duration_short_stop_does_not_advance(env):
    """No duration from the renderer nor the client: switching the receiver to
    another input a few seconds in must not move the queue on (finding 10)."""
    save_queue([dict(A, duration_ms=0), B], current=0)

    async def main():
        await client_cast(dict(A, duration_ms=0), 0)
        for i, t in enumerate(range(1002, 1010, 2)):
            await tick(env, t, "PLAYING", 1 + 2 * i, 0)
        await tick(env, 1012, "STOPPED", 0, 0)
    asyncio.run(main())
    assert env.r.cast == ["Alpha"]


def test_unknown_duration_stop_after_long_play_advances(env):
    save_queue([dict(A, duration_ms=0), B], current=0)

    async def main():
        await client_cast(dict(A, duration_ms=0), 0)
        for i, t in enumerate(range(1002, 1050, 2)):
            await tick(env, t, "PLAYING", 1 + 2 * i, 0)
        await tick(env, 1052, "STOPPED", 0, 0)
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Bravo"]


# ── stall: cast, but it never plays ──

def test_a_track_that_never_starts_is_sent_again_then_skipped_then_given_up(env):
    save_queue([A, B, C], current=0)

    async def main():
        await client_cast(A, 0)
        t = 1000
        while len(env.r.cast) < 3 and t < 1200:
            t += 2
            await tick(env, t, "STOPPED", 0)
        first_skip = list(env.r.cast)
        while SK in dlna._sessions and t < 1400:
            t += 2
            await tick(env, t, "STOPPED", 0)
        return first_skip
    first = asyncio.run(main())
    assert first == ["Alpha", "Alpha", "Bravo"]          # one re-send, then the skip
    assert SK not in dlna._sessions
    assert "did not start" in dlna.take_abandoned(SK)


def test_time_not_watched_is_not_counted_as_a_stall(env):
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1100, "STOPPED", 0)      # 100 s gap: not watched time
        await tick(env, 1102, "STOPPED", 0)
    asyncio.run(main())
    assert env.r.cast == ["Alpha"]


# ── the race with the client ──

def test_client_cast_while_the_server_chooses_wins(env, monkeypatch):
    save_queue([A, B, C], current=0)
    real_choose = dlna._choose_next

    async def choose_then_client_casts(session):
        choice = await real_choose(session)
        await client_cast(D, 3)            # the page woke and cast its own pick
        return choice

    monkeypatch.setattr(dlna, "_choose_next", choose_then_client_casts)

    async def main():
        await client_cast(A, 0)
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Alpha", "Delta"]       # exactly one cast after the end, the client's
    assert st["track"]["name"] == "Delta" and st["track"]["by"] == "client"
    assert saved_queue()["current_index"] == 0    # the server did not move the pointer


def test_client_cast_just_before_the_server_cast_goes_out_wins(env, monkeypatch):
    """The narrowest window: after the follower decided, before its cast starts. Only
    the generation passed into cast_to_device can see it."""
    save_queue([A, B, C, D], current=0)
    from app.services import auth
    real_token = auth.create_stream_token
    fired = []

    def token_and_client_cast(username, ttl=0):
        if not fired and dlna._sessions[SK]["track"]["name"] == "Alpha":
            fired.append(asyncio.get_running_loop().create_task(client_cast(D, 3)))
        return real_token(username, ttl=ttl)

    monkeypatch.setattr(auth, "create_stream_token", token_and_client_cast)

    async def main():
        await client_cast(A, 0)
        await play_to_end(env)
        if fired:
            await fired[0]
    asyncio.run(main())
    assert fired
    assert env.r.cast == ["Alpha", "Delta"]


def test_next_hint_must_name_the_playing_track(env):
    save_queue([A, B, C, D], current=0)

    async def main():
        await client_cast(A, 0)
        stale = await dlna.set_next_hint(SK, 5, {**C, "queue_index": 2})
        ok = await dlna.set_next_hint(SK, 0, {**D, "queue_index": 3})
        none = await dlna.set_next_hint("nobody:x", 0, None)
        await play_to_end(env)
        return stale, ok, none
    stale, ok, none = asyncio.run(main())
    assert (stale, ok, none) == ("stale", "ok", "no_session")
    assert env.r.cast == ["Alpha", "Delta"]


# ── finding 5: seek on a stopped receiver ──

def test_seek_on_a_stopped_renderer_casts_again_at_that_position(env):
    async def main():
        await client_cast(A, 0)
        env.r.state = "STOPPED"
        env.r.log.clear()
        env.clock["t"] += 10
        return await dlna.seek(SK, 600)
    assert asyncio.run(main()) is True
    names = [c[0] for c in env.r.log]
    assert "SetAVTransportURI" in names and names.index("Play") < names.index("Seek")
    assert [c for c in env.r.log if c[0] == "Seek"][0][2] == "00:10:00"
    assert env.r.cast == ["Alpha", "Alpha"]


def test_seek_while_playing_only_seeks(env):
    async def main():
        await client_cast(A, 0)
        env.r.log.clear()
        env.clock["t"] += 10
        return await dlna.seek(SK, 3725)
    assert asyncio.run(main()) is True
    assert [c[0] for c in env.r.log if c[0] != "GetTransportInfo" and c[0] != "GetPositionInfo"
            and c[0] != "GetVolume"] == ["Seek"]
    assert env.r.cast == ["Alpha"]


# ── surviving a restart ──

def test_sessions_are_saved_and_resumed_after_a_restart(env):
    save_queue([A, B, C], current=0)

    async def before():
        await client_cast(A, 0, nxt=(2, C), repeat="all", shuffle=False)
        await tick(env, 1002, "PLAYING", 150, 200)
    asyncio.run(before())
    saved = json.loads((env.tmp / "dlna_sessions.json").read_text())
    assert SK in saved and saved[SK]["device"]["udn"] == UDN
    assert saved[SK]["track"]["name"] == "Alpha" and saved[SK]["hint"]["next"]["name"] == "Charlie"

    # The process restarts: nothing in memory, the receiver kept playing and ended.
    dlna._sessions.clear()
    env.started.clear()
    data = json.loads((env.tmp / "dlna_sessions.json").read_text())
    data[SK]["played"] = True
    data[SK]["last_pos"] = 150
    data[SK]["last_playing"] = True
    data[SK]["last_pos_wall"] = time.time() - 120     # down for two minutes
    (env.tmp / "dlna_sessions.json").write_text(json.dumps(data))

    async def after():
        n = await dlna.resume_sessions()
        s = dlna._sessions[SK]
        assert (s["cast_seq"], s["repeat"], s["track"]["name"]) == (1, "all", "Alpha")
        assert env.started == [SK]
        env.clock["t"] += 2
        env.r.state, env.r.pos, env.r.dur = "STOPPED", 0, 200
        await dlna._follow_tick(SK, s)
        return n
    assert asyncio.run(after()) == 1
    assert env.r.cast == ["Alpha", "Charlie"]       # the hint survived the restart too


def test_an_unreachable_receiver_drops_its_session_on_resume(env):
    asyncio.run(client_cast(A, 0))
    dlna._sessions.clear()
    env.factory.dead.add(LOC)
    assert asyncio.run(dlna.resume_sessions()) == 0
    assert SK not in dlna._sessions
    assert json.loads((env.tmp / "dlna_sessions.json").read_text()) == {}


def test_stop_forgets_the_saved_session(env):
    async def main():
        await client_cast(A, 0)
        await dlna.stop(SK)
    asyncio.run(main())
    assert json.loads((env.tmp / "dlna_sessions.json").read_text()) == {}


# ── the real follower loop ──

def test_stop_ends_the_follower(env, monkeypatch):
    monkeypatch.setattr(dlna, "_ensure_follower", _real_ensure)
    monkeypatch.setattr(dlna, "FOLLOW_TICK", 0.01)
    monkeypatch.setattr(dlna, "FOLLOW_SAMPLE_MAX_AGE", 0)

    async def main():
        save_queue([A, B], current=0)
        await client_cast(A, 0)
        task = dlna._sessions[SK]["follower"]
        assert task is not None and not task.done()
        await asyncio.sleep(0.05)
        polls = len(env.r.log)
        assert polls > 2                          # it is ticking
        await dlna.stop(SK)
        await asyncio.sleep(0)
        assert task.done()
        n = len(env.r.log)
        await asyncio.sleep(0.05)
        return n, len(env.r.log)
    n, later = asyncio.run(main())
    assert n == later                             # nothing asked after stop


def _real_ensure(key, session):
    t = session.get("follower")
    if t and not t.done():
        return
    session["follower"] = asyncio.get_running_loop().create_task(dlna._follow(key))


def test_old_clients_without_queue_index_are_not_followed(env):
    async def main():
        await dlna.cast_to_device(SK, UDN, "Alpha", "DJ One", "tok", username="lucas",
                                  client_device="phone1")
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert st["follow"] is False and env.started == []


def test_another_client_casting_to_the_same_renderer_takes_it_over(env):
    async def main():
        await client_cast(A, 0)
        await dlna.cast_to_device("lucas:desk", UDN, "Bravo", "DJ Two", "tok", queue_index=0,
                                  username="lucas", client_device="desk")
    asyncio.run(main())
    assert SK not in dlna._sessions and "lucas:desk" in dlna._sessions
    assert "another device" in dlna.take_abandoned(SK)


# ── finding 14: a renderer that changed its address ──

def test_a_renderer_seen_at_a_new_address_replaces_its_old_entry(env):
    new_loc = "http://192.168.1.77:8888/upnp_descriptor_0"
    dlna._devices.clear()
    dlna._register_device(LOC, SimpleNamespace(udn=UDN, friendly_name="Onkyo"))
    dlna._register_device(new_loc, SimpleNamespace(udn=UDN, friendly_name="Onkyo"))
    assert [d["location"] for d in dlna.get_devices()] == [new_loc]

    asyncio.run(client_cast(A, 0))
    assert env.factory.made[-1] == new_loc


def test_a_session_follows_the_renderer_to_its_new_address(env, monkeypatch):
    monkeypatch.setattr(dlna, "STATUS_CACHE_TTL", 0)
    new_loc = "http://192.168.1.77:8888/upnp_descriptor_0"

    async def main():
        await client_cast(A, 0)
        dlna._register_device(new_loc, SimpleNamespace(udn=UDN, friendly_name="Onkyo"))
        env.r.fail_av = True
        env.clock["t"] += 2
        await dlna.get_status(SK)               # fails at the old address → rebinds
        env.r.fail_av = False
        env.clock["t"] += 2
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.factory.made[-1] == new_loc
    assert st["location"] == new_loc and "stale" not in st


# ── findings 12, 13: the DIDL type is the type the stream will be ──

@pytest.mark.parametrize("res, mime", [
    (None, "audio/mpeg"),
    ({"source": "youtube", "url": "x"}, "audio/mpeg"),
    ({"source": "local", "path": "/music/u/DJ/DJ Sets/set.m4a"}, "audio/mp4"),
    ({"source": "local", "path": "/music/u/A/B/t.flac"}, "audio/flac"),
    ({"source": "local", "path": "/music/u/A/B/t.mp3"}, "audio/mpeg"),
    ({"source": "navidrome", "song_id": "s1", "raw_ext": "m4a", "ext": "m4a"}, "audio/mp4"),
    ({"source": "navidrome", "song_id": "s2", "ext": "flac"}, "audio/flac"),
])
def test_cast_mime_follows_the_stream(monkeypatch, res, mime):
    monkeypatch.setattr(player, "resolve_stream", lambda n, a: _coro(res))
    assert asyncio.run(dlna._resolve_cast_mime("t", "a")) == mime


def test_cast_mime_of_a_slow_lookup_is_mp3(monkeypatch):
    async def slow(n, a):
        await asyncio.sleep(1)
    monkeypatch.setattr(player, "resolve_stream", slow)
    monkeypatch.setattr(dlna, "CAST_MIME_TIMEOUT", 0.01)
    assert asyncio.run(dlna._resolve_cast_mime("t", "a")) == "audio/mpeg"


# ── the HTTP surface the client relies on ──

@pytest.fixture
def api(env, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import dlna as dlna_router
    from app.services import auth
    app = FastAPI()
    app.include_router(dlna_router.router)
    app.dependency_overrides[auth.get_current_user] = lambda: {"username": "lucas"}
    return TestClient(app, headers={"X-Device-ID": "phone1"})


def test_cast_answers_cast_seq_and_hint_and_status_speak_the_contract(api, env, monkeypatch):
    monkeypatch.setattr(dlna, "STATUS_CACHE_TTL", 0)
    save_queue([A, B, C], current=0)
    r = api.post("/api/dlna/cast", json={"device_id": UDN, **A, "queue_index": 0, "start_seconds": 0,
                                          "next": {**C, "queue_index": 2}, "repeat": "off",
                                          "shuffle": False})
    assert r.status_code == 200
    assert r.json() == {"status": "casting", "cast_seq": 1,
                        "session_id": dlna._sessions[SK]["session_id"]}
    assert dlna._sessions[SK]["username"] == "lucas"
    assert dlna._sessions[SK]["client_device"] == "phone1"

    r = api.post("/api/dlna/next-hint", json={"queue_index": 1, "next": None})
    assert r.status_code == 409 and r.json() == {"stale": True}
    r = api.post("/api/dlna/next-hint", json={"queue_index": 0, "next": {**B, "queue_index": 1},
                                               "repeat": "all", "shuffle": False})
    assert r.status_code == 200
    assert dlna._sessions[SK]["repeat"] == "all"

    st = api.get("/api/dlna/status").json()
    assert st["active"] is True and st["device_id"] == UDN and st["follow"] is True
    assert st["track"]["queue_index"] == 0 and st["cast_seq"] == 1 and st["volume"] == 40
    assert st["session_id"] and st["idle_seconds"] == 0 and "queue_ended_ago" not in st

    env.r.fail_av = True
    for _ in range(int(dlna.STALE_SECONDS // 2) - 1):
        env.clock["t"] += 2
        assert api.get("/api/dlna/status").json()["stale"] is True
    env.clock["t"] += 2
    gone = api.get("/api/dlna/status").json()
    assert gone["active"] is False and "stopped answering" in gone["abandoned"]
    assert api.get("/api/dlna/status").json() == {"active": False}
    assert api.post("/api/dlna/next-hint", json={"queue_index": 0}).status_code == 400


def test_the_running_follower_advances_on_its_own(env, monkeypatch):
    """No page involved: the follower task alone sees the end and casts the next."""
    monkeypatch.setattr(dlna, "_ensure_follower", _real_ensure)
    monkeypatch.setattr(dlna, "FOLLOW_TICK", 0.01)
    monkeypatch.setattr(dlna, "FOLLOW_SAMPLE_MAX_AGE", 0)
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        env.r.pos, env.r.dur = 195, 200
        for _ in range(100):
            await asyncio.sleep(0.01)
            if dlna._sessions[SK]["f"]["last_pos"] == 195:     # it has seen the late position
                break
        env.r.state, env.r.pos = "STOPPED", 0
        for _ in range(1000):          # generous: this machine runs other suites too
            await asyncio.sleep(0.01)
            if len(env.r.cast) == 2:
                break
        await dlna.stop(SK)
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Bravo"]
    assert saved_queue()["current_index"] == 1


# ── review of the server follower (2026-11-19) ──

def test_a_stop_in_the_middle_is_not_a_stall_and_the_follower_waits_quietly(env):
    """Stop on the remote at 70 s of 300, then STOPPED for a minute: no re-send, no
    skip. Before, the stall rule took it for a track that never started and cast
    Alpha, Alpha, Bravo, Bravo."""
    save_queue([A, B, C], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 70, 300)
        t = 1002
        while t < 1002 + 64:
            t += 2
            await tick(env, t, "STOPPED", 0, 300)
        quiet = list(env.r.cast)
        # The receiver plays again on its own and reaches the end: that is followed.
        await tick(env, t + 2, "PLAYING", 75, 300)
        await tick(env, t + 4, "PLAYING", 295, 300)
        await tick(env, t + 6, "STOPPED", 0, 300)
        return quiet
    quiet = asyncio.run(main())
    assert quiet == ["Alpha"]
    assert env.r.cast == ["Alpha", "Bravo"]


def _saved_entry(env, **over):
    save_queue([A, B, C], current=0)
    asyncio.run(client_cast(A, 0))
    data = json.loads((env.tmp / "dlna_sessions.json").read_text())
    data[SK].update(over)
    (env.tmp / "dlna_sessions.json").write_text(json.dumps(data))
    dlna._sessions.clear()
    env.started.clear()


def test_resume_after_a_gap_longer_than_the_track_does_not_advance(env):
    """Saved PLAYING at 150 of 200 s, back three hours later: the receiver has long
    been on something else. Casting the next track there would be a surprise."""
    now = time.time()
    _saved_entry(env, played=True, started=True, last_playing=True, last_pos=150, idle_wall=None,
                 last_pos_wall=now - 3 * 3600, saved_wall=now - 3 * 3600)
    assert asyncio.run(dlna.resume_sessions()) == 0
    assert SK not in dlna._sessions and env.started == []
    assert env.r.cast == ["Alpha"]


def test_resume_of_a_track_that_never_started_after_a_long_gap_is_dropped(env):
    now = time.time()
    _saved_entry(env, played=False, started=False, last_playing=False,
                 last_pos_wall=now - 3600, saved_wall=now - 3600)
    assert asyncio.run(dlna.resume_sessions()) == 0
    assert SK not in dlna._sessions


def test_a_client_cast_during_resume_is_not_overwritten(env):
    now = time.time()
    _saved_entry(env, cast_seq=7, played=True, started=True, last_playing=True, idle_wall=None,
                 last_pos=10, last_pos_wall=now - 5, saved_wall=now - 5)
    gate = {}
    real = env.factory.async_create_device

    async def slow_first(location):
        if "held" not in gate:
            gate["held"] = asyncio.Event()
            gate["entered"].set()
            await gate["held"].wait()          # the resume's connect takes a while …
        return await real(location)
    env.factory.async_create_device = slow_first

    async def main():
        gate["entered"] = asyncio.Event()
        resume = asyncio.create_task(dlna.resume_sessions())
        await gate["entered"].wait()
        await client_cast(B, 1)                # … and the page casts meanwhile
        gate["held"].set()
        return await resume
    assert asyncio.run(main()) == 0
    s = dlna._sessions[SK]
    assert s["track"]["name"] == "Bravo" and s["cast_seq"] == 1


def test_a_receiver_playing_something_else_ends_the_session_without_a_cast(env):
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 30, 200)
        env.r.uri = "x-sonos-spotify:spotify%3atrack%3a123"   # switched to Spotify Connect
        await tick(env, 1004, "PLAYING", 5, 200)
        await tick(env, 1006, "PLAYING", 7, 200)
        assert SK in dlna._sessions                    # two samples: not yet
        await tick(env, 1008, "PLAYING", 9, 200)       # third in a row → given up here
    asyncio.run(main())
    assert env.r.cast == ["Alpha"]
    assert SK not in dlna._sessions
    assert "playing something else" in dlna.take_abandoned(SK)


def test_save_queue_replaces_the_file_atomically(env, monkeypatch):
    import os
    seen = []
    real = os.replace

    def spy(src, dst):
        seen.append(str(dst))
        return real(src, dst)
    monkeypatch.setattr(os, "replace", spy)
    save_queue([A], current=0)
    assert str(player._queue_path("lucas", "phone1")) in seen
    assert saved_queue()["queue"][0]["name"] == "Alpha"


def test_an_unreadable_device_queue_is_retried_not_read_from_another_file(env):
    """A device file caught mid-write must not end the queue, nor send the follower
    to the legacy file (another device's queue)."""
    save_queue([A, B], current=0)
    path = player._queue_path("lucas", "phone1")
    (player.PLAYER_DIR / "lucas.json").write_text(json.dumps({"queue": [A, D], "current_index": 0}))

    async def main():
        await client_cast(A, 0)
        path.write_text('{"queue": [')                 # half written
        await play_to_end(env)
        mid = (list(env.r.cast), dlna._sessions[SK]["queue_ended"])
        save_queue([A, B], current=0)
        await tick(env, env.clock["t"] + 2, "STOPPED", 0)
        return mid
    mid = asyncio.run(main())
    assert mid == (["Alpha"], False)
    assert env.r.cast == ["Alpha", "Bravo"]


def test_unknown_duration_handover_position_is_not_progress(env):
    """Cast took over at 45:00 of a mix with no known length; the receiver stops ten
    seconds later. That is not the end of the mix."""
    mix = dict(A, duration_ms=0)
    save_queue([mix, B], current=0)

    async def main():
        await client_cast(mix, 0, start=2700)
        for i, t in enumerate(range(1002, 1012, 2)):
            await tick(env, t, "PLAYING", 2701 + 2 * i, 0)
        await tick(env, 1012, "STOPPED", 0, 0)
    asyncio.run(main())
    assert env.r.cast == ["Alpha"]


def test_the_server_pointer_write_does_not_lose_a_client_save(env, monkeypatch):
    """The page saves its queue (PUT) while the follower is between reading the file
    and writing its pointer: the page's save must survive."""
    import threading
    save_queue([A, B, C], current=0)
    client_data = {"queue": [A, B, C, D], "current_index": 0, "position_seconds": 0.0, "volume": 1.0}
    real_load = player.load_queue
    calls = {"n": 0}
    threads = []

    def load_then_client_saves(*a, **kw):
        data = real_load(*a, **kw)
        calls["n"] += 1
        if calls["n"] == 2:                   # 1: choosing the next track, 2: the write-back
            t = threading.Thread(target=player.save_queue, args=("lucas", client_data, "phone1"))
            t.start()
            threads.append(t)
            time.sleep(0.3)
        return data
    monkeypatch.setattr(player, "load_queue", load_then_client_saves)

    async def main():
        await client_cast(A, 0)
        await play_to_end(env)
    asyncio.run(main())
    for t in threads:
        t.join()
    assert threads and env.r.cast == ["Alpha", "Bravo"]
    assert len(real_load("lucas", "phone1")["queue"]) == 4


def test_stop_leaves_a_cast_that_came_in_during_it_alone(env):
    async def main():
        await client_cast(A, 0)

        async def cast_meanwhile():
            env.r.on_stop = None
            await client_cast(B, 1)
        env.r.on_stop = cast_meanwhile
        await dlna.stop(SK)
    asyncio.run(main())
    s = dlna._sessions.get(SK)
    assert s is not None and s["dmr"] is not None and s["track"]["name"] == "Bravo"


def test_a_recast_keeps_the_clients_hint(env):
    save_queue([A, B, C, D], current=0)

    async def main():
        await client_cast(A, 0)
        await play_to_end(env)                                 # server casts Bravo
        assert await dlna.set_next_hint(SK, 1, {**D, "queue_index": 3}) == "ok"
        env.r.state = "STOPPED"
        env.clock["t"] += 10
        assert await dlna.seek(SK, 30)                         # re-cast of Bravo at 30 s
        await play_to_end(env, t0=env.clock["t"])
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Bravo", "Bravo", "Delta"]


def test_the_sessions_renderer_is_cast_to_when_discovery_lost_it(env):
    save_queue([A, B, C], current=0)

    async def main():
        await client_cast(A, 0)
        dlna._devices.clear()
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Bravo"]
    assert SK in dlna._sessions


def test_shuffle_deals_unplaced_positions_like_the_client(env):
    save_queue([A, B, C, D], current=0, shuffle_order={"played": [], "tail": [2]})

    async def main():
        await client_cast(A, 0, shuffle=True)
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Charlie"]
    order = saved_queue()["shuffle_order"]
    assert order["played"] == [0] and sorted(order["tail"]) == [1, 3]


def test_a_hinted_track_leaves_the_played_stack_like_adopt_shuffle_index(env):
    save_queue([A, B, C, D], current=0, shuffle_order={"played": [2], "tail": [1, 3]})

    async def main():
        await client_cast(A, 0, nxt=(2, C), shuffle=True)
        await play_to_end(env)
    asyncio.run(main())
    order = saved_queue()["shuffle_order"]
    assert order == {"played": [0], "tail": [1, 3]}


def test_a_long_mix_stopped_ten_minutes_before_its_end_is_not_its_end(env):
    mix = dict(A, duration_ms=3600 * 1000)
    save_queue([mix, B], current=0)

    async def main():
        await client_cast(mix, 0)
        await tick(env, 1002, "PLAYING", 3100, 3600)
        await tick(env, 1004, "STOPPED", 0, 3600)
        before = list(env.r.cast)
        await tick(env, 1006, "PLAYING", 3550, 3600)
        await tick(env, 1008, "STOPPED", 0, 3600)
        return before
    assert asyncio.run(main()) == ["Alpha"]
    assert env.r.cast == ["Alpha", "Bravo"]


def test_background_keeps_a_reference_to_the_resume_task():
    from app import background

    async def main():
        t = background._spawn(asyncio.sleep(0.01))
        held = t in background._tasks
        await t
        await asyncio.sleep(0)
        return held, t in background._tasks
    assert asyncio.run(main()) == (True, False)


# ── client review: resuming, superseded, Play after a stop ──

def test_status_says_resuming_until_the_resume_is_done(api, env):
    """Right after a restart the page must not end its cast: the server may still
    bring the session back."""
    dlna.mark_resume_pending()                       # startup, before the file is read
    assert api.get("/api/dlna/status").json() == {"active": False, "resuming": True}

    now = time.time()
    _saved_entry(env, played=True, started=True, last_playing=True, last_pos=10, idle_wall=None,
                 last_pos_wall=now - 5, saved_wall=now - 5)
    dlna.mark_resume_pending()
    gate = {}
    real = env.factory.async_create_device

    async def held(location):
        gate["entered"].set()
        await gate["go"].wait()
        return await real(location)
    env.factory.async_create_device = held

    async def main():
        gate["entered"], gate["go"] = asyncio.Event(), asyncio.Event()
        task = asyncio.create_task(dlna.resume_sessions())
        await gate["entered"].wait()
        during = (dlna.is_resuming(SK), dlna.is_resuming("someone:else"))
        gate["go"].set()
        await task
        return during
    assert asyncio.run(main()) == (True, False)
    assert dlna.is_resuming(SK) is False
    st = api.get("/api/dlna/status").json()
    assert st["active"] is True and "resuming" not in st


def test_status_after_a_resume_that_failed_is_plainly_inactive(api, env):
    _saved_entry(env)
    env.factory.dead.add(LOC)
    dlna.mark_resume_pending()
    assert asyncio.run(dlna.resume_sessions()) == 0
    assert api.get("/api/dlna/status").json() == {"active": False}


def test_a_superseded_cast_answers_409_not_502(api, env, monkeypatch):
    """Two quick Next taps: the first cast loses to the second. That is not "Cast
    failed"."""
    async def newer_cast_arrives(name, artist):
        dlna._sessions[SK]["generation"] += 1
        return "audio/flac"
    monkeypatch.setattr(dlna, "_resolve_cast_mime", newer_cast_arrives)
    r = api.post("/api/dlna/cast", json={"device_id": UDN, **A, "queue_index": 0})
    assert r.status_code == 409
    assert r.json()["detail"]["superseded"] is True
    assert r.json()["detail"]["message"] == "superseded"


def test_play_after_a_stop_in_the_middle_resumes_where_it_was(env):
    save_queue([A, B, C, D], current=0)

    async def main():
        await client_cast(A, 0, nxt=(3, D))
        await tick(env, 1002, "PLAYING", 70, 300)
        await tick(env, 1004, "STOPPED", 0, 300)     # Stop on the remote at ~72 s
        env.r.log.clear()
        env.clock["t"] = 1010
        ok = await dlna.play(SK)
        await play_to_end(env, t0=env.clock["t"])
        return ok
    assert asyncio.run(main()) is True
    assert env.r.cast == ["Alpha", "Alpha", "Delta"]   # resumed, and the hint still holds
    seek = [c for c in env.r.log if c[0] == "Seek"][0]
    assert seek[2] == "00:01:12"


def test_play_on_a_paused_receiver_is_a_plain_play(env):
    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 70, 300)
        await tick(env, 1004, "PAUSED_PLAYBACK", 71, 300)
        env.r.log.clear()
        env.clock["t"] = 1010
        return await dlna.play(SK)
    assert asyncio.run(main()) is True
    assert env.r.cast == ["Alpha"]
    assert ("Play",) in env.r.log and ("SetAVTransportURI",) not in env.r.log


def test_play_after_the_queue_ended_is_a_plain_play(env):
    save_queue([A], current=0)

    async def main():
        await client_cast(A, 0)
        await play_to_end(env)
        env.r.log.clear()
        env.clock["t"] += 10
        return await dlna.play(SK)
    assert asyncio.run(main()) is True
    assert env.r.cast == ["Alpha"] and ("SetAVTransportURI",) not in env.r.log


def test_play_after_the_receiver_resumed_by_itself_and_ended_is_a_plain_play(env):
    """Stopped at 1:00, resumed from the receiver's own remote, played to the end of
    the queue: Play must not go back to 1:00."""
    save_queue([A], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 60, 300)
        await tick(env, 1004, "STOPPED", 0, 300)           # stop short of the end
        await tick(env, 1006, "PLAYING", 61, 300)          # remote: play again
        await tick(env, 1008, "PLAYING", 295, 300)
        await tick(env, 1010, "STOPPED", 0, 300)           # the end → queue ended
        assert dlna._sessions[SK]["queue_ended"] is True
        env.r.log.clear()
        env.clock["t"] = 1020
        return await dlna.play(SK)
    assert asyncio.run(main()) is True
    assert env.r.cast == ["Alpha"] and ("SetAVTransportURI",) not in env.r.log
    assert ("Play",) in env.r.log


# ── adversarial review: expiry, session id, stale by time, repeat one, queue lock,
#    catalogue durations, TrackURI echoes ──

def test_a_played_out_queue_expires_after_30_idle_minutes_without_stop(env):
    save_queue([A], current=0)

    async def main():
        await client_cast(A, 0)
        await play_to_end(env)                                  # queue ended
        st = await dlna.get_status(SK)
        t = env.clock["t"]
        give_up = t + 3 * 3600                  # a fixed bound: tick() moves the clock
        while SK in dlna._sessions and t < give_up:
            t += 60
            await tick(env, t, "STOPPED", 0)
        return st, t
    st, t = asyncio.run(main())
    assert st["queue_ended"] is True and st["queue_ended_ago"] >= 0 and st["idle_seconds"] >= 0
    assert SK not in dlna._sessions
    assert ("Stop",) not in env.r.log                           # the receiver is left alone
    assert json.loads((env.tmp / "dlna_sessions.json").read_text()) == {}
    assert "idle" in dlna.take_abandoned(SK)


def test_a_paused_session_expires_but_a_long_mix_playing_does_not(env):
    save_queue([A, B], current=0)

    async def main():
        await client_cast(dict(A, duration_ms=3 * 3600 * 1000), 0)
        t = 1000
        for i in range(120):                                    # two hours of PLAYING
            t += 60
            await tick(env, t, "PLAYING", 60 * (i + 1), 3 * 3600)
        alive_after_2h = SK in dlna._sessions
        st = await dlna.get_status(SK)
        for _ in range(29):                                     # 29 min paused: still there
            t += 60
            await tick(env, t, "PAUSED_PLAYBACK", 7200, 3 * 3600)
        alive_after_29 = SK in dlna._sessions
        idle = (await dlna.get_status(SK))["idle_seconds"]
        for _ in range(3):
            if SK not in dlna._sessions:
                break
            t += 60
            await tick(env, t, "PAUSED_PLAYBACK", 7200, 3 * 3600)
        return alive_after_2h, st["idle_seconds"], alive_after_29, idle
    alive2h, idle_playing, alive29, idle29 = asyncio.run(main())
    assert alive2h and idle_playing == 0
    assert alive29 and 29 * 60 - 60 <= idle29 < 30 * 60
    assert SK not in dlna._sessions


def test_resume_keeps_only_sessions_idle_for_less_than_the_limit(env):
    now = time.time()
    _saved_entry(env, played=False, started=True, last_playing=False,
                 idle_wall=now - 40 * 60, saved_wall=now - 60)
    assert asyncio.run(dlna.resume_sessions()) == 0

    _saved_entry(env, played=False, started=True, last_playing=False,
                 idle_wall=now - 5 * 60, saved_wall=now - 60)
    assert asyncio.run(dlna.resume_sessions()) == 1
    idle = dlna._idle_seconds(dlna._sessions[SK])
    assert 5 * 60 - 5 <= idle <= 5 * 60 + 5


def test_session_id_is_new_per_session_and_survives_a_restart(env):
    async def first():
        await client_cast(A, 0)
        return dlna.get_session_id(SK)
    sid1 = asyncio.run(first())

    async def second():
        await dlna.stop(SK)
        await client_cast(B, 1)
        return dlna.get_session_id(SK), dlna.get_cast_seq(SK)
    sid2, seq = asyncio.run(second())
    assert sid1 and sid2 and sid1 != sid2 and seq == 1

    async def playing():
        await tick(env, env.clock["t"] + 2, "PLAYING", 10, 200)
    asyncio.run(playing())
    dlna._sessions.clear()
    assert asyncio.run(dlna.resume_sessions()) == 1
    assert dlna.get_session_id(SK) == sid2


def test_a_short_wifi_drop_does_not_end_the_cast(env, monkeypatch):
    monkeypatch.setattr(dlna, "STATUS_CACHE_TTL", 0)

    async def main():
        await client_cast(A, 0)
        env.r.fail_av = True
        for _ in range(25):                                     # 50 s without an answer
            env.clock["t"] += 2
            st = await dlna.get_status(SK)
            assert st is not None and st["stale"] is True
        env.r.fail_av = False
        env.clock["t"] += 2
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert st is not None and "stale" not in st and st["state"] == "PLAYING"


def test_repeat_one_wins_over_the_hint_and_keeps_it(env):
    save_queue([A, B, C, D], current=1)

    async def main():
        await client_cast(B, 1, nxt=(3, D), repeat="one")
        await play_to_end(env)                                  # repeat one → Bravo again
        assert dlna._sessions[SK]["hint"]["next"]["name"] == "Delta"
        assert await dlna.set_next_hint(SK, 1, {**D, "queue_index": 3}, repeat="off") == "ok"
        await play_to_end(env, t0=env.clock["t"])
    asyncio.run(main())
    assert env.r.cast == ["Bravo", "Bravo", "Delta"]


def test_a_catalogue_duration_only_ends_in_the_last_seconds(env):
    """No duration from the renderer: a stop 40 s before the catalogue's end is an
    input switch, not the end."""
    save_queue([dict(A, duration_ms=300000), B], current=0)

    async def main():
        await client_cast(dict(A, duration_ms=300000), 0)
        await tick(env, 1002, "PLAYING", 255, 0)               # renderer gives no duration
        await tick(env, 1004, "STOPPED", 0, 0)
        before = list(env.r.cast)
        await tick(env, 1006, "PLAYING", 290, 0)
        await tick(env, 1008, "STOPPED", 0, 0)
        return before
    assert asyncio.run(main()) == ["Alpha"]
    assert env.r.cast == ["Alpha", "Bravo"]


def test_a_renderer_duration_keeps_the_wider_window(env):
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 258, 300)              # renderer says 300 s
        await tick(env, 1004, "STOPPED", 0, 0)                  # … and 0 once stopped
    asyncio.run(main())
    assert env.r.cast == ["Alpha", "Bravo"]


@pytest.mark.parametrize("echo", [
    lambda url: url.replace("&", "&amp;"),                                     # HTML-escaped
    lambda url: __import__("urllib.parse").parse.quote(url, safe=""),          # percent-encoded
    lambda url: "http://10.0.0.5:8090/media/1234.flac",                        # our host, own path
])
def test_the_renderers_echo_of_our_url_is_never_something_else(env, echo):
    env.r.echo = echo
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        for i, t in enumerate(range(1002, 1022, 2)):
            await tick(env, t, "PLAYING", 10 + 2 * i, 200)
    asyncio.run(main())
    assert SK in dlna._sessions and dlna.take_abandoned(SK) is None


def test_another_uri_must_repeat_while_playing_to_count(env):
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 10, 200)
        ours = env.r.uri
        env.r.uri = "spotify:track:1"
        await tick(env, 1004, "PLAYING", 12, 200)
        await tick(env, 1006, "PLAYING", 14, 200)
        env.r.uri = ours                                        # back: the count starts over
        await tick(env, 1008, "PLAYING", 16, 200)
        env.r.uri = "spotify:track:1"
        for t in range(1010, 1030, 2):                          # foreign but STOPPED: no verdict
            await tick(env, t, "STOPPED", 0, 200)
    asyncio.run(main())
    assert SK in dlna._sessions


def test_queue_add_and_save_hold_the_queue_lock_off_the_event_loop(env, monkeypatch):
    import threading
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import player as player_router
    from app.dependencies import bind_navidrome_creds
    app = FastAPI()
    app.include_router(player_router.router)
    app.dependency_overrides[bind_navidrome_creds] = lambda: {"username": "lucas"}
    client = TestClient(app, headers={"X-Device-ID": "phone1"})

    seen = {}
    real_update, real_save = player.update_queue, player.save_queue

    def spy_update(*a, **kw):
        seen["update"] = threading.current_thread() is threading.main_thread()
        return real_update(*a, **kw)

    def spy_save(*a, **kw):
        seen.setdefault("save_threads", []).append(threading.current_thread().name)
        return real_save(*a, **kw)
    monkeypatch.setattr(player, "update_queue", spy_update)
    monkeypatch.setattr(player, "save_queue", spy_save)
    loop_threads = set()

    @app.get("/__loop_thread")
    async def loop_thread():
        loop_threads.add(threading.current_thread().name)
        return {}

    client.get("/__loop_thread")
    r = client.put("/api/player/queue", json={"queue": [A], "current_index": 0})
    assert r.status_code == 200
    r = client.post("/api/player/queue/add", json={"tracks": [B]})
    assert r.status_code == 200 and [t["name"] for t in r.json()["queue"]] == ["Alpha", "Bravo"]
    assert "update" in seen                                     # add went through update_queue
    assert seen["save_threads"] and not (set(seen["save_threads"]) & loop_threads)
    assert [t["name"] for t in saved_queue()["queue"]] == ["Alpha", "Bravo"]


@pytest.mark.parametrize("echo", [
    # Neither form has "/api/player/stream" nor "10.0.0.5:8090" in raw form: only the
    # decoding recognises them as ours.
    lambda url: __import__("urllib.parse").parse.quote(url, safe=""),
    lambda url: url.replace("/", "&#47;").replace(":", "&#58;"),
])
def test_an_encoded_echo_is_recognised_by_decoding_it(env, echo):
    env.r.echo = echo
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        raw = env.r.uri
        assert "/api/player/stream" not in raw and "10.0.0.5:8090" not in raw
        for i, t in enumerate(range(1002, 1022, 2)):
            await tick(env, t, "PLAYING", 10 + 2 * i, 200)
    asyncio.run(main())
    assert SK in dlna._sessions and dlna.take_abandoned(SK) is None


def test_a_foreign_uri_right_after_the_cast_is_not_learned_as_ours(env):
    """The receiver still names Spotify in the first sample after our cast: that must
    not become "our" URI, or the take-over is never seen."""
    env.r.echo = lambda url: "spotify:track:1"
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        for i, t in enumerate(range(1002, 1012, 2)):
            if SK not in dlna._sessions:
                break
            await tick(env, t, "PLAYING", 10 + 2 * i, 200)
    asyncio.run(main())
    assert dlna._sessions.get(SK) is None
    assert "playing something else" in dlna.take_abandoned(SK)


@pytest.mark.parametrize("own_form", [
    "x-rincon-stream:RINCON_0001",          # the receiver's own scheme
    "http://10.0.0.5:8090/",                # our host with an empty path
    "track-0001",                           # anything else unknown
])
def test_a_renderer_echoing_in_its_own_form_is_learned_and_the_cast_lives(env, own_form):
    """An unknown echo form is learned as ours: a wrong "something else" would end
    every cast after 6 s on such a receiver. A later foreign URI is still caught."""
    env.r.echo = lambda url: own_form
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        for i, t in enumerate(range(1002, 1022, 2)):
            await tick(env, t, "PLAYING", 10 + 2 * i, 200)
        alive = SK in dlna._sessions
        env.r.uri = "spotify:track:9"                       # now a take-over
        for t in range(1022, 1030, 2):
            if SK not in dlna._sessions:
                break
            await tick(env, t, "PLAYING", 1, 200)
        return alive
    assert asyncio.run(main()) is True
    assert SK not in dlna._sessions and "playing something else" in dlna.take_abandoned(SK)


def test_an_http_uri_on_another_host_right_after_the_cast_is_not_learned(env):
    env.r.echo = lambda url: "http://192.168.1.99:5000/stream/radio.mp3"
    save_queue([A, B], current=0)

    async def main():
        await client_cast(A, 0)
        for i, t in enumerate(range(1002, 1012, 2)):
            if SK not in dlna._sessions:
                break
            await tick(env, t, "PLAYING", 10 + 2 * i, 200)
    asyncio.run(main())
    assert SK not in dlna._sessions
    assert "playing something else" in dlna.take_abandoned(SK)


# ── autoplay: the page's recommender picks continue a queue that ran out ──
# The recommender lives in the page, and a phone page is frozen while the screen is
# off: the follower reached the last row and stopped (production, 2026-11-21: row 174
# of 175, hint next null, queue_ended). The page now hands the picks over in advance.

R1 = {"name": "Rec One", "artist": "Reco A", "album": "LP", "image": "/api/library/cover/r1",
      "duration_ms": 180000, "id": "sp-r1"}
R2 = {"name": "Rec Two", "artist": "Reco B", "album": "", "image": "", "duration_ms": 190000}
R3 = {"name": "Rec Three", "artist": "Reco C", "album": "", "image": "", "duration_ms": 0}


async def cast_with_list(item, qi, autoplay, repeat="off", shuffle=False):
    return await dlna.cast_to_device(
        SK, UDN, item["name"], item["artist"], "tok", duration_ms=item.get("duration_ms", 0),
        queue_index=qi, next_item=None, repeat=repeat, shuffle=shuffle, autoplay=autoplay,
        username="lucas", client_device="phone1", by="client")


def test_end_of_the_queue_with_an_autoplay_list_appends_and_casts_it(env):
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1, R2])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Rec One"]
    assert st["queue_ended"] is False and st["cast_seq"] == 2
    assert st["track"]["name"] == "Rec One" and st["track"]["by"] == "server"
    assert st["track"]["queue_index"] == 3 and st["track"]["autoplay"] is True
    assert st["autoplay_left"] == 1
    assert [i["name"] for i in dlna._sessions[SK]["autoplay"]] == ["Rec Two"]
    q = saved_queue()
    assert [i["name"] for i in q["queue"]] == ["Alpha", "Bravo", "Charlie", "Rec One"]
    assert q["queue"][3] == {"name": "Rec One", "artist": "Reco A", "album": "LP",
                             "image": "/api/library/cover/r1", "duration_ms": 180000, "id": "sp-r1"}
    assert q["current_index"] == 3 and q["position_seconds"] == 0


def test_the_autoplay_list_is_played_through_and_only_then_the_queue_ends(env):
    save_queue([A, B], current=1)

    async def main():
        await cast_with_list(B, 1, [R1, R2])
        await play_to_end(env)
        mid = await dlna.get_status(SK)
        await play_to_end(env, t0=env.clock["t"])
        mid2 = await dlna.get_status(SK)
        await play_to_end(env, t0=env.clock["t"])
        return mid, mid2, await dlna.get_status(SK)
    mid, mid2, st = asyncio.run(main())
    assert env.r.cast == ["Bravo", "Rec One", "Rec Two"]
    assert mid["queue_ended"] is False and mid2["queue_ended"] is False
    assert mid2["autoplay_left"] == 0
    assert st["queue_ended"] is True
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Rec One", "Rec Two"]
    assert saved_queue()["current_index"] == 3


def test_an_empty_autoplay_list_means_none_and_the_queue_ends_as_before(env):
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1])
        # The page says: nothing follows (radio, repeat, a recommender with no picks).
        assert await dlna.set_next_hint(SK, 2, None, autoplay=[]) == "ok"
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie"] and st["queue_ended"] is True
    assert len(saved_queue()["queue"]) == 3


def test_a_hint_brings_the_autoplay_list_and_a_stale_one_does_not(env):
    save_queue([A, B, C], current=2)

    async def main():
        await client_cast(C, 2)
        assert dlna._sessions[SK]["autoplay"] == []
        assert await dlna.set_next_hint(SK, 1, None, autoplay=[R1]) == "stale"
        assert dlna._sessions[SK]["autoplay"] == []
        assert await dlna.set_next_hint(SK, 2, None, autoplay=[R2, R3]) == "ok"
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Charlie", "Rec Two"]


def test_repeat_all_ignores_the_autoplay_list(env):
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1], repeat="all")
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Charlie", "Alpha"]
    assert len(saved_queue()["queue"]) == 3
    assert [i["name"] for i in dlna._sessions[SK]["autoplay"]] == ["Rec One"]


def test_repeat_one_ignores_the_autoplay_list(env):
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1], repeat="one")
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Charlie", "Charlie"]
    assert len(saved_queue()["queue"]) == 3


def test_a_queue_with_tracks_left_does_not_touch_the_autoplay_list(env):
    save_queue([A, B, C], current=1)

    async def main():
        await cast_with_list(B, 1, [R1])           # a list although B is not the last row
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Bravo", "Charlie"]
    assert len(saved_queue()["queue"]) == 3


def test_a_client_cast_while_the_server_appends_wins_and_the_row_is_taken_back(env, monkeypatch):
    save_queue([A, B, C], current=2)
    real_take = dlna._take_autoplay
    seen = {}

    async def take_then_client_casts(session):
        choice = await real_take(session)
        seen["appended"] = [i["name"] for i in saved_queue()["queue"]]
        await cast_with_list(A, 0, [])     # the page woke up and the user tapped a row
        return choice

    monkeypatch.setattr(dlna, "_take_autoplay", take_then_client_casts)

    async def main():
        await cast_with_list(C, 2, [R1, R2])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert seen["appended"] == ["Alpha", "Bravo", "Charlie", "Rec One"]
    assert env.r.cast == ["Charlie", "Alpha"]         # one cast after the end: the client's
    assert st["track"]["name"] == "Alpha" and st["track"]["by"] == "client"
    assert "autoplay" not in st["track"]
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie"]
    assert dlna._sessions[SK]["autoplay"] == []       # the client's cast said: none


def test_a_client_cast_just_before_the_autoplay_cast_goes_out_wins(env, monkeypatch):
    save_queue([A, B, C], current=2)
    from app.services import auth
    real_token = auth.create_stream_token
    fired = []

    def token_and_client_cast(username, ttl=0):
        if not fired and dlna._sessions[SK]["track"]["name"] == "Charlie":
            fired.append(asyncio.get_running_loop().create_task(client_cast(A, 0)))
        return real_token(username, ttl=ttl)

    monkeypatch.setattr(auth, "create_stream_token", token_and_client_cast)

    async def main():
        await cast_with_list(C, 2, [R1])
        await play_to_end(env)
        await fired[0]
    asyncio.run(main())
    assert env.r.cast == ["Charlie", "Alpha"]
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie"]


def test_an_autoplay_track_that_cannot_be_cast_moves_on_to_the_next(env, monkeypatch):
    save_queue([A, B, C], current=2)
    real_set = FakeDmr.async_set_transport_uri

    async def refuse_rec_one(self, url, title, meta_data=None):
        if title == "Rec One":
            self.r.cast.append("(refused) " + title)
            raise RuntimeError("upnp error: 716 resource not found")
        return await real_set(self, url, title, meta_data)

    monkeypatch.setattr(FakeDmr, "async_set_transport_uri", refuse_rec_one)

    async def main():
        await cast_with_list(C, 2, [R1, R2, R3])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "(refused) Rec One", "Rec Two"]
    assert st["track"]["name"] == "Rec Two" and st["track"]["queue_index"] == 4
    assert st["queue_ended"] is False and st["autoplay_left"] == 1
    q = saved_queue()
    assert [i["name"] for i in q["queue"]] == ["Alpha", "Bravo", "Charlie", "Rec One", "Rec Two"]
    assert q["current_index"] == 4


def test_two_dead_autoplay_tracks_in_a_row_end_the_session(env, monkeypatch):
    save_queue([A, B, C], current=2)

    async def refuse(self, url, title, meta_data=None):
        if title.startswith("Rec"):
            raise RuntimeError("upnp error: 716")
        self.r.cast.append(title)
        self.r.state = "TRANSITIONING"

    monkeypatch.setattr(FakeDmr, "async_set_transport_uri", refuse)

    async def main():
        await cast_with_list(C, 2, [R1, R2, R3])
        await play_to_end(env)
    asyncio.run(main())
    assert SK not in dlna._sessions
    assert "did not start" in dlna.take_abandoned(SK)


def test_autoplay_passes_over_the_current_track_and_rows_the_queue_already_holds(env):
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [dict(C), {**A, "name": "ALPHA "}, R2])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Rec Two"]
    assert st["autoplay_left"] == 0
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie", "Rec Two"]


def test_an_autoplay_list_of_nothing_usable_ends_the_queue(env):
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [dict(A), dict(B)])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie"] and st["queue_ended"] is True
    assert len(saved_queue()["queue"]) == 3


def test_autoplay_is_appended_only_where_the_saved_queue_really_ends(env):
    save_queue([A, B, C], current=1)
    used, choice = dlna._append_autoplay("lucas", "phone1", {**B, "queue_index": 1}, [dict(R1)], False)
    assert (used, choice) == (0, None)
    used, choice = dlna._append_autoplay("lucas", "phone1", {**D, "queue_index": 7}, [dict(R1)], False)
    assert (used, choice) == (0, None)                 # the track is not in this queue at all
    assert len(saved_queue()["queue"]) == 3
    used, choice = dlna._append_autoplay("lucas", "phone1", {**C, "queue_index": 2}, [dict(R1)], False)
    assert used == 1 and choice[0] == 3 and choice[1]["name"] == "Rec One"


def test_exhausted_shuffle_appends_autoplay_and_writes_the_order(env):
    save_queue([A, B, C], current=1, shuffle_order={"played": [0, 2], "tail": []})

    async def main():
        await cast_with_list(B, 1, [R1], shuffle=True)
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Bravo", "Rec One"]
    q = saved_queue()
    assert q["current_index"] == 3 and len(q["queue"]) == 4
    assert q["shuffle_order"] == {"played": [0, 2, 1], "tail": []}


def test_shuffle_with_rows_left_plays_those_before_any_autoplay(env):
    save_queue([A, B, C], current=1, shuffle_order={"played": [0], "tail": [2]})

    async def main():
        await cast_with_list(B, 1, [R1], shuffle=True)
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Bravo", "Charlie"]
    assert len(saved_queue()["queue"]) == 3


def test_the_autoplay_list_is_bounded_and_cleaned():
    many = [{"name": f"T{i}", "artist": "X"} for i in range(200)]
    assert len(dlna._clean_autoplay(many)) == dlna.AUTOPLAY_MAX_ITEMS == 20
    out = dlna._clean_autoplay([
        {"name": "N" * 9000, "artist": "A" * 9000, "album": "L" * 9000, "image": "I" * 9000,
         "duration_ms": "12", "id": "x" * 9000, "junk": "j" * 9000, "queue_index": 5},
        {"artist": "no name"}, "not a dict", None, {"name": ""},
        {"name": "Dup", "artist": "D"}, {"name": " dup ", "artist": "d", "id": 42},
        {"name": "Neg", "duration_ms": -5, "id": True},
    ])
    assert [len(out[0][k]) for k in ("name", "artist", "album", "image", "id")] == [500, 500, 500, 2000, 200]
    assert set(out[0]) == {"name", "artist", "album", "image", "duration_ms", "id"}
    assert out[0]["duration_ms"] == 12
    assert [o["name"] for o in out[1:]] == ["Dup", "Neg"]
    assert out[2]["duration_ms"] == 0 and "id" not in out[2]
    for bad in (None, "x", {"name": "a"}, 7):
        assert dlna._clean_autoplay(bad) == []


def test_the_api_takes_the_autoplay_list_and_refuses_what_is_not_a_list(api, env):
    save_queue([A, B, C], current=2)
    r = api.post("/api/dlna/cast", json={"device_id": UDN, **C, "queue_index": 2, "next": None,
                                          "autoplay": [R1, {"name": "x" * 9000, "artist": "y"}] + [R2] * 40})
    assert r.status_code == 200
    s = dlna._sessions[SK]
    assert [i["name"][:7] for i in s["autoplay"]] == ["Rec One", "xxxxxxx", "Rec Two"]
    assert len(s["autoplay"][1]["name"]) == 500
    assert api.get("/api/dlna/status").json()["autoplay_left"] == 3

    r = api.post("/api/dlna/next-hint", json={"queue_index": 2, "next": None, "autoplay": [R3]})
    assert r.status_code == 200 and [i["name"] for i in s["autoplay"]] == ["Rec Three"]
    assert api.post("/api/dlna/next-hint", json={"queue_index": 2, "autoplay": "Rec"}).status_code == 422
    assert api.post("/api/dlna/next-hint", json={"queue_index": 2, "autoplay": ["Rec"]}).status_code == 422
    assert [i["name"] for i in s["autoplay"]] == ["Rec Three"]
    # No `autoplay` (or null) = "not known": what the server holds stays.
    r = api.post("/api/dlna/next-hint", json={"queue_index": 2, "next": None})
    assert r.status_code == 200 and [i["name"] for i in s["autoplay"]] == ["Rec Three"]
    r = api.post("/api/dlna/next-hint", json={"queue_index": 2, "next": None, "autoplay": None})
    assert r.status_code == 200 and [i["name"] for i in s["autoplay"]] == ["Rec Three"]
    r = api.post("/api/dlna/cast", json={"device_id": UDN, **C, "queue_index": 2, "next": None})
    assert r.status_code == 200 and [i["name"] for i in s["autoplay"]] == ["Rec Three"]
    # … and only an explicit [] drops it.
    r = api.post("/api/dlna/next-hint", json={"queue_index": 2, "next": None, "autoplay": []})
    assert r.status_code == 200 and s["autoplay"] == []
    assert api.get("/api/dlna/status").json()["autoplay_left"] == 0


def test_the_autoplay_list_survives_a_restart(env):
    save_queue([A, B, C], current=2)

    async def before():
        await cast_with_list(C, 2, [R1, R2])
        await tick(env, 1002, "PLAYING", 150, 200)
    asyncio.run(before())
    data = json.loads((env.tmp / "dlna_sessions.json").read_text())
    assert [i["name"] for i in data[SK]["autoplay"]] == ["Rec One", "Rec Two"]

    dlna._sessions.clear()
    data[SK].update(played=True, last_pos=150, last_playing=True, last_pos_wall=time.time() - 120)
    data[SK]["autoplay"].append({"name": "x" * 9000, "artist": "edited by hand"})
    (env.tmp / "dlna_sessions.json").write_text(json.dumps(data))

    async def after():
        assert await dlna.resume_sessions() == 1
        s = dlna._sessions[SK]
        assert [len(i["name"]) for i in s["autoplay"]] == [7, 7, 500]
        env.clock["t"] += 2
        env.r.state, env.r.pos, env.r.dur = "STOPPED", 0, 200
        await dlna._follow_tick(SK, s)
        return await dlna.get_status(SK)
    st = asyncio.run(after())
    assert env.r.cast == ["Charlie", "Rec One"]
    assert st["track"]["autoplay"] is True and st["autoplay_left"] == 2
    # … and what is left is on disk again for the next restart.
    data = json.loads((env.tmp / "dlna_sessions.json").read_text())
    assert [i["name"][:7] for i in data[SK]["autoplay"]] == ["Rec Two", "xxxxxxx"]
    assert data[SK]["track"]["autoplay"] is True


def test_a_resent_autoplay_track_keeps_its_mark(env):
    """A track that did not start is sent once more (recast): the page must still learn
    that this row came from the autoplay list."""
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1])
        await play_to_end(env)
        t = env.clock["t"]
        while len(env.r.cast) < 3 and t < env.clock["t"] + 100:
            t += 2
            await tick(env, t, "STOPPED", 0)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Rec One", "Rec One"]
    assert st["track"]["autoplay"] is True and st["track"]["queue_index"] == 3
    assert len(saved_queue()["queue"]) == 4


# ── review round 2 ──

def test_a_cast_or_hint_without_the_field_keeps_the_list_the_server_holds(env):
    """M1: the app was reopened on the last row — its recommender is still loading, so
    its first cast and hint say nothing about autoplay. Saying nothing must not wipe
    the list; the phone is locked again and the queue would simply end."""
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1, R2])
        await cast_with_list(C, 2, None)                        # the reopened page casts again
        assert await dlna.set_next_hint(SK, 2, None) == "ok"    # … and hints, list unknown
        assert [i["name"] for i in dlna._sessions[SK]["autoplay"]] == ["Rec One", "Rec Two"]
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Charlie", "Rec One"]
    assert st["queue_ended"] is False and st["track"]["autoplay"] is True


def test_a_list_sent_mid_queue_waits_for_the_real_end_of_the_queue(env):
    """M2: the list arrives with the cast of row 0; the phone is locked for the whole
    queue and the server walks to the last row by itself, list in hand."""
    save_queue([A, B, C], current=0)

    async def main():
        await cast_with_list(A, 0, [R1, R2])
        for _ in range(3):
            await play_to_end(env, t0=env.clock["t"])
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Alpha", "Bravo", "Charlie", "Rec One"]
    assert st["queue_ended"] is False and st["autoplay_left"] == 1
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie", "Rec One"]


def test_an_appended_row_the_page_saved_away_is_put_back_and_the_list_carries_on(env):
    """H2: the server appended Rec One and plays it; a page that woke up wrote its older
    queue over the file. The playing row is in no row now — that is still the end of
    the queue, not a reason to stop with picks left."""
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1, R2, R3])
        await play_to_end(env)
        assert [i["name"] for i in saved_queue()["queue"]][-1] == "Rec One"
        save_queue([A, B, C], current=2)           # the stale PUT
        await play_to_end(env, t0=env.clock["t"])
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Rec One", "Rec Two"]
    assert st["queue_ended"] is False and st["track"]["name"] == "Rec Two"
    q = saved_queue()
    assert [i["name"] for i in q["queue"]] == ["Alpha", "Bravo", "Charlie", "Rec One", "Rec Two"]
    assert q["current_index"] == 4 and st["track"]["queue_index"] == 4


def test_a_track_missing_from_the_file_that_is_not_ours_still_ends_the_queue(env):
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1])
        save_queue([A, B], current=1)              # the user removed the playing row
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie"] and st["queue_ended"] is True
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo"]


def test_an_unexpected_fault_in_the_append_ends_the_queue_instead_of_retrying_forever(env, monkeypatch):
    """L1: only an unreadable/unwritable file is worth another try."""
    save_queue([A, B, C], current=2)
    calls = []

    def broken(*a, **kw):
        calls.append(1)
        raise TypeError("a bug of ours")

    monkeypatch.setattr(dlna, "_append_autoplay", broken)

    async def main():
        await cast_with_list(C, 2, [R1])
        await play_to_end(env)
        s = dlna._sessions[SK]
        assert s["f"]["pending"] is None
        for i in range(5):
            await tick(env, env.clock["t"] + 2, "STOPPED", 0)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert st["queue_ended"] is True and len(calls) == 1


def test_an_unreadable_queue_file_during_the_append_is_tried_again(env, monkeypatch):
    save_queue([A, B, C], current=2)
    real = dlna._append_autoplay
    fails = [1]

    def flaky(*a, **kw):
        if fails:
            fails.pop()
            raise player.QueueUnreadable("mid-write")
        return real(*a, **kw)

    monkeypatch.setattr(dlna, "_append_autoplay", flaky)

    async def main():
        await cast_with_list(C, 2, [R1])
        await play_to_end(env)
        assert env.r.cast == ["Charlie"] and dlna._sessions[SK]["queue_ended"] is False
        await tick(env, env.clock["t"] + 2, "STOPPED", 0)
    asyncio.run(main())
    assert env.r.cast == ["Charlie", "Rec One"]


def test_a_device_without_its_own_queue_file_gets_no_append(env):
    """L2: load_queue falls back to the default device's queue; writing that back plus
    our row would hand this device another device's queue as its own."""
    player.save_queue("lucas", {"queue": [dict(A), dict(B), dict(C)], "current_index": 2,
                                "position_seconds": 0.0, "volume": 1.0}, "default")
    own = player._queue_path("lucas", "phone1")
    assert not own.exists()

    async def main():
        await cast_with_list(C, 2, [R1])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie"] and st["queue_ended"] is True
    assert not own.exists()
    assert len(player.load_queue("lucas", "default")["queue"]) == 3


# ── review round 3 ──

N_ROW = {"name": "Queued By Hand", "artist": "The User", "album": "", "image": "", "duration_ms": 200000}


def test_a_lost_row_goes_back_after_the_row_it_followed_and_rows_queued_meanwhile_play_next(env):
    """N3: put back at the END, the lost row sat behind what the user had queued and
    became current — those rows never played."""
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1, R2])
        await play_to_end(env)                     # the server appends and plays Rec One
        save_queue([A, B, C, N_ROW], current=2)    # the page's save: its queue, plus a row queued by hand
        await play_to_end(env, t0=env.clock["t"])
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Rec One", "Queued By Hand"]
    q = saved_queue()
    assert [i["name"] for i in q["queue"]] == ["Alpha", "Bravo", "Charlie", "Rec One", "Queued By Hand"]
    assert q["current_index"] == 4 and st["track"]["queue_index"] == 4
    assert "autoplay" not in st["track"] and st["queue_ended"] is False
    assert [i["name"] for i in dlna._sessions[SK]["autoplay"]] == ["Rec Two"]     # kept for the real end


def test_a_lost_row_is_put_back_even_when_no_picks_are_left(env):
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1])
        await play_to_end(env)
        assert dlna._sessions[SK]["autoplay"] == []
        save_queue([A, B, C, N_ROW], current=2)
        await play_to_end(env, t0=env.clock["t"])
    asyncio.run(main())
    assert env.r.cast == ["Charlie", "Rec One", "Queued By Hand"]
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie", "Rec One", "Queued By Hand"]


def test_an_appended_row_the_user_removed_while_it_plays_is_not_put_back(env):
    """The page hinted about the row — it has it. Gone from the file after that is the
    user's doing: the queue ends there, as for any removed playing row."""
    save_queue([A, B, C], current=2)

    async def main():
        await cast_with_list(C, 2, [R1, R2])
        await play_to_end(env)
        assert await dlna.set_next_hint(SK, 3, None) == "ok"      # the awake page adopted it
        save_queue([A, B, C], current=2)                          # … and the user removed the row
        await play_to_end(env, t0=env.clock["t"])
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Rec One"]
    assert st["queue_ended"] is True
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie"]


def test_what_the_follower_knows_about_its_appended_row_survives_a_restart(env):
    save_queue([A, B, C], current=2)

    async def before():
        await cast_with_list(C, 2, [R1, R2])
        await play_to_end(env)
        await tick(env, env.clock["t"] + 2, "PLAYING", 150, 200)
    asyncio.run(before())
    data = json.loads((env.tmp / "dlna_sessions.json").read_text())
    assert data[SK]["autoplay_after"] == {"name": "Charlie", "artist": "DJ Three"}
    assert data[SK]["autoplay_seen"] is False
    dlna._sessions.clear()
    data[SK].update(played=True, last_pos=150, last_playing=True, last_pos_wall=time.time() - 120)
    (env.tmp / "dlna_sessions.json").write_text(json.dumps(data))
    save_queue([A, B, C, N_ROW], current=2)

    async def after():
        assert await dlna.resume_sessions() == 1
        s = dlna._sessions[SK]
        env.clock["t"] += 2
        env.r.state, env.r.pos, env.r.dur = "STOPPED", 0, 200
        await dlna._follow_tick(SK, s)
    asyncio.run(after())
    assert env.r.cast == ["Charlie", "Rec One", "Queued By Hand"]


# ── radio: the follower refills a radio queue by itself (2026-11-22) ──
# The page's radio refill (_nextTrackTerminal → GET /api/radio) lives in the page; with
# the display off the follower reached the last row of a radio queue and stopped.

RAD1 = {"id": "dz-1", "name": "Radio One", "artist": "Station A", "album": "R", "image": "http://img/1",
      "duration_ms": 200000, "type": "track", "preview_url": "http://x/" + "p" * 5000}
RAD2 = {"id": "dz-2", "name": "Radio Two", "artist": "Station B", "duration_ms": 200000, "type": "track"}
RAD3 = {"id": "dz-3", "name": "Radio Three", "artist": "Station C", "duration_ms": 200000, "type": "track"}


def save_radio_queue(items, current, **extra):
    data = {"queue": [dict(i) for i in items], "current_index": current, "position_seconds": 0.0,
            "volume": 1.0, "radio_mode": True, "radio_seed": {"name": "The Seed", "artist": "Seeder"}}
    data.update(extra)
    player.save_queue("lucas", data, "phone1")


@pytest.fixture
def station(monkeypatch):
    """The radio service, faked: answers the batches it is given, in order, and records
    what it was asked."""
    from app.services import radio
    st = SimpleNamespace(asked=[], batches=[], fail=None, delay=None)

    async def get_radio_tracks(source, track_name="", artist_name="", artist_id="", limit=25):
        st.asked.append((track_name, artist_name, artist_id, limit))
        if st.delay:
            await st.delay()
        if st.fail:
            raise st.fail
        return [dict(t) for t in (st.batches.pop(0) if st.batches else [])]

    monkeypatch.setattr(radio, "get_radio_tracks", get_radio_tracks)
    return st


def test_the_end_of_a_radio_queue_is_refilled_by_the_follower(env, station):
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1, dict(B), RAD2, dict(C), RAD3]]       # two of them the queue already holds

    async def main():
        await cast_with_list(C, 2, [])                       # the page says [] in radio mode
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert station.asked == [("Charlie", "DJ Three", "", dlna.RADIO_BATCH)]      # seeded by the last row
    assert env.r.cast == ["Charlie", "Radio One"]
    assert st["queue_ended"] is False and st["track"]["by"] == "server"
    assert st["track"]["queue_index"] == 3 and st["track"]["autoplay"] is True and st["track"]["kind"] == "radio"
    q = saved_queue()
    assert [i["name"] for i in q["queue"]] == ["Alpha", "Bravo", "Charlie", "Radio One", "Radio Two", "Radio Three"]
    assert q["current_index"] == 3
    assert q["radio_mode"] is True and q["radio_seed"] == {"name": "The Seed", "artist": "Seeder"}
    assert q["queue"][3] == {"name": "Radio One", "artist": "Station A", "album": "R", "image": "http://img/1",
                             "duration_ms": 200000, "id": "dz-1", "type": "track"}      # nothing bloated


def test_radio_plays_through_its_batch_and_refills_again_without_end(env, station):
    save_radio_queue([A, B], 1)
    station.batches = [[RAD1, RAD2], [RAD3, dict(RAD1)]]

    async def main():
        await cast_with_list(B, 1, [])
        kinds = []
        for _ in range(3):
            await play_to_end(env, t0=env.clock["t"])
            st = await dlna.get_status(SK)
            kinds.append((st["track"]["name"], st["track"].get("kind"), st["track"].get("autoplay"), st["queue_ended"]))
        return kinds
    kinds = asyncio.run(main())
    assert env.r.cast == ["Bravo", "Radio One", "Radio Two", "Radio Three"]
    # Every row of a batch the page has not seen carries the mark, not only its first.
    assert kinds == [("Radio One", "radio", True, False), ("Radio Two", "radio", True, False),
                     ("Radio Three", "radio", True, False)]
    assert [a[0] for a in station.asked] == ["Bravo", "Radio Two"]          # the second refill seeds from the new last row
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Radio One", "Radio Two", "Radio Three"]


def test_a_radio_service_with_nothing_new_ends_the_queue(env, station):
    save_radio_queue([A, B, C], 2)
    station.batches = [[dict(A), dict(C)]]

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie"] and st["queue_ended"] is True
    assert len(saved_queue()["queue"]) == 3 and len(station.asked) == 1


@pytest.mark.parametrize("fault", [RuntimeError("deezer is down"), "timeout"])
def test_a_failing_or_slow_radio_service_ends_the_queue_and_says_so(env, station, monkeypatch, caplog, fault):
    save_radio_queue([A, B, C], 2)
    if fault == "timeout":
        monkeypatch.setattr(dlna, "RADIO_TIMEOUT", 0.05)
        station.delay = lambda: asyncio.sleep(1)
    else:
        station.fail = fault

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)
        return await dlna.get_status(SK)
    with caplog.at_level("INFO", logger="musicseeker.dlna"):
        st = asyncio.run(main())
    assert st["queue_ended"] is True and env.r.cast == ["Charlie"]
    assert any("radio refill" in r.getMessage() and SK in r.getMessage() and r.levelname == "WARNING"
               for r in caplog.records)


def test_a_queue_that_is_not_radio_never_asks_the_radio_service(env, station):
    save_queue([A, B, C], current=2)
    station.batches = [[RAD1]]

    async def main():
        await cast_with_list(C, 2, [R1])
        await play_to_end(env)
    asyncio.run(main())
    assert station.asked == [] and env.r.cast == ["Charlie", "Rec One"]


def test_a_radio_queue_is_refilled_from_the_radio_not_from_a_recommender_list(env, station):
    """A list the server still holds (a page from before, or the keep-on-absent rule)
    must not play where the page itself would refill the radio."""
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1]]

    async def main():
        await cast_with_list(C, 2, [R1, R2])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Radio One"] and st["track"]["kind"] == "radio"
    assert [i["name"] for i in dlna._sessions[SK]["autoplay"]] == ["Rec One", "Rec Two"]


def test_radio_with_repeat_all_wraps_and_does_not_refill(env, station):
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1]]

    async def main():
        await cast_with_list(C, 2, [], repeat="all")
        await play_to_end(env)
    asyncio.run(main())
    assert env.r.cast == ["Charlie", "Alpha"] and station.asked == []


def test_a_client_cast_while_the_radio_is_being_fetched_wins_and_nothing_is_appended(env, station, monkeypatch):
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1, RAD2]]
    writes = []
    real_append = dlna._append_autoplay
    monkeypatch.setattr(dlna, "_append_autoplay", lambda *a, **kw: writes.append(1) or real_append(*a, **kw))

    async def client_casts():
        await cast_with_list(A, 0, [])
    station.delay = client_casts

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Alpha"] and st["track"]["by"] == "client"
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie"]
    assert writes == []                 # not written and taken back: never written at all


def test_a_client_cast_just_before_the_radio_cast_takes_the_whole_batch_back(env, station, monkeypatch):
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1, RAD2, RAD3]]
    from app.services import auth
    real_token = auth.create_stream_token
    fired = []

    def token_and_client_cast(username, ttl=0):
        if not fired and dlna._sessions[SK]["track"]["name"] == "Charlie":
            fired.append(asyncio.get_running_loop().create_task(client_cast(A, 0)))
        return real_token(username, ttl=ttl)

    monkeypatch.setattr(auth, "create_stream_token", token_and_client_cast)

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)
        await fired[0]
    asyncio.run(main())
    assert env.r.cast == ["Charlie", "Alpha"]
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie"]


def test_after_a_client_cast_the_rows_are_the_pages_own_again(env, station):
    """The mark says "a row the page has not seen". A client cast comes from the page's
    queue: from then on the follower's advances are ordinary rows."""
    save_radio_queue([A, B], 1)
    station.batches = [[RAD1, RAD2, RAD3]]

    async def main():
        await cast_with_list(B, 1, [])
        await play_to_end(env)                                  # → Radio One (ours)
        await client_cast(RAD2, 3)                                # the page adopted and the user tapped a row
        await play_to_end(env, t0=env.clock["t"])              # → Radio Three, a row the page has
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Bravo", "Radio One", "Radio Two", "Radio Three"]
    assert st["track"]["name"] == "Radio Three" and "kind" not in st["track"] and "autoplay" not in st["track"]


def test_a_radio_row_a_stale_save_erased_is_put_back_and_the_radio_goes_on(env, station):
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1], [RAD2]]

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)                                  # Radio One appended and playing
        save_radio_queue([A, B, C], 2)                          # the woken page's old queue
        await play_to_end(env, t0=env.clock["t"])
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert env.r.cast == ["Charlie", "Radio One", "Radio Two"]
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie", "Radio One", "Radio Two"]
    assert st["track"]["kind"] == "radio" and st["queue_ended"] is False


def test_the_radio_mark_survives_a_restart(env, station):
    save_radio_queue([A, B], 1)
    station.batches = [[RAD1, RAD2]]

    async def before():
        await cast_with_list(B, 1, [])
        await play_to_end(env)
        await tick(env, env.clock["t"] + 2, "PLAYING", 150, 200)
    asyncio.run(before())
    data = json.loads((env.tmp / "dlna_sessions.json").read_text())
    assert data[SK]["radio_from"] == 2 and data[SK]["track"]["kind"] == "radio"
    dlna._sessions.clear()
    data[SK].update(played=True, last_pos=150, last_playing=True, last_pos_wall=time.time() - 120)
    (env.tmp / "dlna_sessions.json").write_text(json.dumps(data))

    async def after():
        assert await dlna.resume_sessions() == 1
        s = dlna._sessions[SK]
        env.clock["t"] += 2
        env.r.state, env.r.pos, env.r.dur = "STOPPED", 0, 200
        await dlna._follow_tick(SK, s)
        return await dlna.get_status(SK)
    st = asyncio.run(after())
    assert st["track"]["name"] == "Radio Two" and st["track"]["kind"] == "radio"


# ── a trail in the log ──

def _lines(caplog, *needles):
    return [r.getMessage() for r in caplog.records
            if r.name == "musicseeker.dlna" and all(n in r.getMessage() for n in needles)]


def test_the_follower_logs_under_the_name_the_app_raises_to_info():
    from pathlib import Path as _P
    assert dlna.logger.name == "musicseeker.dlna"
    src = (_P(dlna.__file__).resolve().parents[1] / "__init__.py").read_text()
    assert 'logging.getLogger("musicseeker.dlna").setLevel(logging.INFO)' in src
    assert 'basicConfig(level=logging.WARNING' in src           # everything else stays quiet


def test_every_advance_and_the_end_of_the_queue_leave_one_line_each(env, caplog):
    save_queue([A, B, C, D], current=0)

    async def main():
        await client_cast(A, 0, nxt=(2, C))
        await play_to_end(env)                                  # hint → Charlie
        await play_to_end(env, t0=env.clock["t"])              # queue → Delta
        assert await dlna.set_next_hint(SK, 3, None, autoplay=[R1]) == "ok"
        await play_to_end(env, t0=env.clock["t"])              # autoplay → Rec One
        await play_to_end(env, t0=env.clock["t"])              # end
    with caplog.at_level("INFO", logger="musicseeker.dlna"):
        asyncio.run(main())
    adv = _lines(caplog, f"[{SK}] advance")
    assert len(adv) == 3
    assert "'Alpha' (row 0) → 'Charlie' (row 2), via hint" in adv[0]
    assert "'Charlie' (row 2) → 'Delta' (row 3), via queue" in adv[1]
    assert "'Delta' (row 3) → 'Rec One' (row 4), via autoplay" in adv[2]
    end = _lines(caplog, f"[{SK}] end of the queue")
    assert len(end) == 1
    assert "saved queue 5 rows" in end[0] and "playing row found at 4" in end[0]
    assert "repeat off" in end[0] and "shuffle False" in end[0] and "autoplay list 0" in end[0] and "radio no" in end[0]
    assert len(_lines(caplog, "client cast")) == 1             # the one cast the page made
    # Nothing per poll: 24 ticks ran, and every line is one of the events above.
    assert len([r for r in caplog.records if r.name == "musicseeker.dlna"]) == 5


def test_a_radio_advance_says_so(env, station, caplog):
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1]]

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)
    with caplog.at_level("INFO", logger="musicseeker.dlna"):
        asyncio.run(main())
    assert len(_lines(caplog, f"[{SK}] advance", "→ 'Radio One' (row 3), via radio")) == 1


def test_a_stop_in_the_middle_of_a_track_leaves_one_line_with_the_numbers(env, caplog):
    save_queue([A, B, C], current=0)

    async def main():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 2, 200)
        await tick(env, 1070, "PLAYING", 70, 200)
        for t in range(1072, 1090, 2):
            await tick(env, t, "STOPPED", 0, 200)
    with caplog.at_level("INFO", logger="musicseeker.dlna"):
        asyncio.run(main())
    mid = _lines(caplog, f"[{SK}] receiver STOPPED mid-track 'Alpha' (row 0)")
    assert len(mid) == 1                                        # nine stopped polls, one line
    assert "at 72/200 s" in mid[0] and "renderer duration" in mid[0] and "no advance" in mid[0]
    assert env.r.cast == ["Alpha"]


def test_every_way_a_session_ends_says_why_and_where_it_was(env, caplog, monkeypatch):
    save_queue([A, B, C], current=0)

    async def stopped_by_the_client():
        await client_cast(A, 0)
        await tick(env, 1002, "PLAYING", 40, 200)
        await dlna.stop(SK)

    async def receiver_gone():
        await client_cast(A, 0)
        await tick(env, env.clock["t"] + 2, "PLAYING", 40, 200)
        env.r.fail_av = True
        for _ in range(int(dlna.STALE_SECONDS // 2) + 2):
            if SK not in dlna._sessions:
                break
            await tick(env, env.clock["t"] + 2, "PLAYING", 0, 200)
        env.r.fail_av = False

    async def idle():
        await client_cast(A, 0)
        await tick(env, env.clock["t"] + 2, "PLAYING", 40, 200)
        await tick(env, env.clock["t"] + 2, "PAUSED_PLAYBACK", 42, 200)
        env.clock["t"] += dlna.IDLE_EXPIRE + 5
        await dlna.get_status(SK)

    with caplog.at_level("INFO", logger="musicseeker.dlna"):
        asyncio.run(stopped_by_the_client())
        asyncio.run(receiver_gone())
        asyncio.run(idle())
    assert len(_lines(caplog, f"[{SK}] session ended: stop from the client", "'Alpha' (row 0) at 40/200 s")) == 1
    assert len(_lines(caplog, f"[{SK}] session ended:", "stopped answering", "'Alpha' (row 0) at 40/")) == 1
    assert len(_lines(caplog, f"[{SK}] session ended:", "was idle for 30 minutes", "'Alpha' (row 0) at 42/")) == 1


def test_a_failed_cast_and_a_dead_track_leave_a_line_and_never_a_token(env, caplog, monkeypatch):
    save_queue([A, B, C], current=0)
    real_set = FakeDmr.async_set_transport_uri

    async def refuse_bravo(self, url, title, meta_data=None):
        if title == "Bravo":
            # A renderer's error may quote the URL it was given back at us.
            raise RuntimeError(f"upnp error: 716 cannot open {url}")
        return await real_set(self, url, title, meta_data)

    monkeypatch.setattr(FakeDmr, "async_set_transport_uri", refuse_bravo)

    async def main():
        await client_cast(A, 0)
        await play_to_end(env)                 # Bravo is refused → Charlie
        t = env.clock["t"]
        while len(env.r.cast) < 3 or SK in dlna._sessions and t < env.clock["t"] + 200:
            t += 2
            if SK not in dlna._sessions:
                break
            await tick(env, t, "STOPPED", 0)   # Charlie never starts → sent again → dead
    with caplog.at_level("DEBUG", logger="musicseeker.dlna"):
        asyncio.run(main())
    failed = _lines(caplog, f"[{SK}] cast of 'Bravo' (by server) failed", "716")
    assert len(failed) == 1
    assert len(_lines(caplog, f"[{SK}]", "'Charlie' (row 2)", "sending it once more")) == 1
    # The second track in a row that never played: the session ends, and says so.
    assert len(_lines(caplog, f"[{SK}] session ended:", "did not start 2 tracks in a row", "'Charlie' (row 2)")) == 1
    everything = "\\n".join(r.getMessage() for r in caplog.records)
    assert "token=" in everything and "token=tok" not in everything and "api/player/stream?name" in everything
    import re as _re
    assert not _re.search(r"token=[A-Za-z0-9._-]{6,}", everything)


def test_a_track_that_never_starts_leaves_a_dead_track_line_before_it_is_skipped(env, caplog):
    save_queue([A, B, C], current=0)

    async def main():
        await client_cast(A, 0)
        t = 1000
        while len(env.r.cast) < 3 and t < 1200:
            t += 2
            await tick(env, t, "STOPPED", 0)
    with caplog.at_level("INFO", logger="musicseeker.dlna"):
        asyncio.run(main())
    assert env.r.cast == ["Alpha", "Alpha", "Bravo"]
    assert len(_lines(caplog, f"[{SK}] dead track: 'Alpha' (row 0)", "skipping it")) == 1
    assert len(_lines(caplog, f"[{SK}] advance 'Alpha' (row 0) → 'Bravo' (row 1), via queue")) == 1


def test_a_receiver_playing_something_else_and_a_takeover_say_so(env, caplog):
    env.r.echo = lambda url: "http://192.168.1.99:5000/stream/radio.mp3"
    save_queue([A, B], current=0)

    async def foreign():
        await client_cast(A, 0)
        for i, t in enumerate(range(1002, 1012, 2)):
            if SK not in dlna._sessions:
                break
            await tick(env, t, "PLAYING", 10 + 2 * i, 200)

    async def takeover():
        env.r.echo = None
        await client_cast(A, 0)
        await dlna.cast_to_device("lucas:tablet", UDN, "Bravo", "DJ Two", "tok", queue_index=1,
                                  username="lucas", client_device="tablet", by="client")
    with caplog.at_level("INFO", logger="musicseeker.dlna"):
        asyncio.run(foreign())
        asyncio.run(takeover())
    assert len(_lines(caplog, f"[{SK}] session ended:", "playing something else")) == 1
    assert len(_lines(caplog, f"[{SK}] session ended: [lucas:tablet] cast to the same renderer")) == 1


# ── review of the radio diff (R1, R2, R7) ──

def test_a_queue_file_that_cannot_be_written_does_not_ask_the_radio_service_again_and_gives_up(env, station, monkeypatch, caplog):
    """R1: the service was asked BEFORE the write; a failing write set `pending`, and
    every 2 s tick asked Deezer / Last.fm again — until the 30-minute idle expiry."""
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1, RAD2]] + [[RAD3]] * 20
    writes = []

    def disk_full(*a, **kw):
        writes.append(1)
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(dlna, "_append_autoplay", disk_full)

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)
        for _ in range(10):
            await tick(env, env.clock["t"] + 2, "STOPPED", 0)
        return await dlna.get_status(SK)
    with caplog.at_level("INFO", logger="musicseeker.dlna"):
        st = asyncio.run(main())
    assert len(station.asked) == 1                      # one external lookup for this queue end
    assert len(writes) == dlna.APPEND_WRITE_TRIES == 3  # a few tries, not one every 2 s
    assert st["queue_ended"] is True and env.r.cast == ["Charlie"]
    assert len(_lines(caplog, f"[{SK}] queue not writable, retrying")) == 1
    assert len(_lines(caplog, f"[{SK}] queue not writable after 3 tries", "the queue ends here")) == 1


def test_a_write_that_fails_once_uses_the_batch_it_already_has(env, station, monkeypatch):
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1, RAD2], [RAD3]]
    real = dlna._append_autoplay
    fails = [OSError(5, "I/O error")]

    def flaky(*a, **kw):
        if fails:
            raise fails.pop()
        return real(*a, **kw)

    monkeypatch.setattr(dlna, "_append_autoplay", flaky)

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)
        assert env.r.cast == ["Charlie"]
        await tick(env, env.clock["t"] + 2, "STOPPED", 0)
    asyncio.run(main())
    assert len(station.asked) == 1
    assert env.r.cast == ["Charlie", "Radio One"]       # the first batch, not a second one
    assert [i["name"] for i in saved_queue()["queue"]][3:] == ["Radio One", "Radio Two"]
    assert dlna._sessions[SK]["radio_batch"] is None


def test_an_unreadable_queue_keeps_retrying_but_never_fetches_the_radio_twice(env, station, monkeypatch):
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1], [RAD2], [RAD3]]
    real = dlna._append_autoplay
    left = [6]

    def mid_write(*a, **kw):
        if left[0]:
            left[0] -= 1
            raise player.QueueUnreadable("mid-write")
        return real(*a, **kw)

    monkeypatch.setattr(dlna, "_append_autoplay", mid_write)

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)
        for _ in range(6):
            assert dlna._sessions[SK]["queue_ended"] is False       # more than three tries: still going
            await tick(env, env.clock["t"] + 2, "STOPPED", 0)
    asyncio.run(main())
    assert len(station.asked) == 1 and env.r.cast == ["Charlie", "Radio One"]


def test_the_next_queue_end_fetches_again(env, station):
    """The kept batch belongs to ONE queue end (one cast_seq)."""
    save_radio_queue([A, B], 1)
    station.batches = [[RAD1], [RAD2]]

    async def main():
        await cast_with_list(B, 1, [])
        await play_to_end(env)
        await play_to_end(env, t0=env.clock["t"])
    asyncio.run(main())
    assert len(station.asked) == 2 and env.r.cast == ["Bravo", "Radio One", "Radio Two"]


def test_a_client_cast_right_after_the_radio_batch_was_written_takes_the_whole_batch_back(env, station, monkeypatch):
    """R2: the first of the two places a batch is taken back — between the write and
    the follower's own cast."""
    save_radio_queue([A, B, C], 2)
    station.batches = [[RAD1, RAD2, RAD3]]
    real = dlna._append_autoplay
    seen = {}

    async def client_casts():
        await cast_with_list(A, 0, [])

    real_take = dlna._append_radio

    async def append_then_client_casts(*a, **kw):
        out = await real_take(*a, **kw)
        seen["written"] = [i["name"] for i in saved_queue()["queue"]]
        await client_casts()
        return out

    monkeypatch.setattr(dlna, "_append_radio", append_then_client_casts)

    async def main():
        await cast_with_list(C, 2, [])
        await play_to_end(env)
        return await dlna.get_status(SK)
    st = asyncio.run(main())
    assert seen["written"] == ["Alpha", "Bravo", "Charlie", "Radio One", "Radio Two", "Radio Three"]
    assert env.r.cast == ["Charlie", "Alpha"] and st["track"]["by"] == "client"
    assert [i["name"] for i in saved_queue()["queue"]] == ["Alpha", "Bravo", "Charlie"]
    assert real is dlna._append_autoplay


def test_the_log_never_carries_a_token_however_it_is_encoded():
    for raw in ("http://h/api/player/stream?name=a&token=abc.DEF-123_x&quality=lossless",
                "http%3A//h/api/player/stream%3Fname%3Da%26token%3Dabc.DEF-123_x%26quality%3Dlossless",
                "http%253A//h/stream%253Fname%253Da%2526token%253Dabc.DEF-123_x%2526q"):
        out = dlna._safe(raw)
        assert "abc.DEF-123_x" not in out and "token" in out and "quality"[:1] in out
    assert dlna._safe("no secret here") == "no secret here"
