"""What a cast promises the renderer, and what happens when the renderer says no.

Every failure here was observed in production on 2026-11-01: a title made of escaped
XML, a cast that crashed on its own session after the user pressed stop, and 502
"Cast failed" for a receiver that was simply in standby.
"""
import asyncio
import logging

import pytest

from app.services import dlna


DEVICE = {
    "name": "Onkyo TX-NR555",
    "location": "http://192.168.1.45:8888/upnp_descriptor_0",
    "udn": "uuid:test-renderer",
    "ip": "192.168.1.45",
}


class FakeDmr:
    """Records what the cast actually sent to the renderer."""

    def __init__(self, device=None, on_set=None, on_play=None):
        self.device = device
        self.set_calls = []
        self.play_calls = 0
        self.stop_calls = 0
        self._on_set = on_set
        self._on_play = on_play

    async def async_set_transport_uri(self, media_url, media_title, meta_data=None):
        self.set_calls.append((media_url, media_title, meta_data))
        if self._on_set:
            await self._on_set()

    async def async_play(self):
        self.play_calls += 1
        if self._on_play:
            await self._on_play()

    async def async_stop(self):
        self.stop_calls += 1


@pytest.fixture
def renderer(monkeypatch):
    """A reachable renderer, a predictable server URL, and no network anywhere."""
    dlna._devices.clear()
    dlna._sessions.clear()
    dlna._devices[DEVICE["location"]] = dict(DEVICE)

    made = {}

    class FakeFactory:
        async def async_create_device(self, location):
            made["location"] = location
            return object()

    monkeypatch.setattr(dlna, "_get_factory", lambda: _coro(FakeFactory()))
    monkeypatch.setattr(dlna, "_get_server_url", lambda: "http://10.0.0.5:8090")
    monkeypatch.setattr(dlna, "_resolve_cast_mime", lambda name, artist: _coro("audio/flac"))
    # Same number of attempts, none of the waiting.
    monkeypatch.setattr(dlna, "PLAY_RETRY_DELAYS", (0, 0, 0, 0, 0))
    yield made
    dlna._devices.clear()
    dlna._sessions.clear()


async def _coro(value):
    return value


def _install(monkeypatch, dmr):
    import async_upnp_client.profiles.dlna as profile
    monkeypatch.setattr(profile, "DmrDevice", lambda device, state: dmr)


def test_renderer_is_given_the_track_title_not_the_didl(renderer, monkeypatch):
    """The second argument of async_set_transport_uri is the TITLE. Passing the DIDL
    there made async-upnp-client wrap it in a second DIDL, so the receiver displayed
    the escaped XML document as the track name and lost duration and cover art."""
    dmr = FakeDmr()
    _install(monkeypatch, dmr)

    ok = asyncio.run(dlna.cast_to_device(
        "u:dev", DEVICE["udn"], "Infinituri", "Alexia", "tok",
        album="Infinituri", image="/api/library/cover/mf-1", duration_ms=168000,
    ))

    assert ok is True
    url, title, meta = dmr.set_calls[0]
    assert title == "Infinituri"
    assert meta.lstrip().startswith("<DIDL-Lite")
    assert "<dc:title>Infinituri</dc:title>" in meta
    assert "&lt;DIDL-Lite" not in meta          # no DIDL nested inside the title
    assert 'duration="00:02:48"' in meta


def test_album_art_goes_out_as_an_absolute_url(renderer, monkeypatch):
    """The renderer fetches the cover itself and knows nothing about our host."""
    dmr = FakeDmr()
    _install(monkeypatch, dmr)

    asyncio.run(dlna.cast_to_device(
        "u:dev", DEVICE["udn"], "Infinituri", "Alexia", "tok",
        image="/api/library/cover/mf-1",
    ))

    _, _, meta = dmr.set_calls[0]
    assert "<upnp:albumArtURI>http://10.0.0.5:8090/api/library/cover/mf-1" in meta


def test_stop_during_a_cast_does_not_crash_it(renderer, monkeypatch, caplog):
    """stop() used to clear session["dmr"] while a cast was asleep between Play
    retries; the cast then read the empty slot and died on
    AttributeError: 'NoneType' object has no attribute 'async_play'."""
    stopped = asyncio.Event()

    async def after_set_uri():
        # The user presses stop while the cast is still working on this track.
        await dlna.stop("u:dev")
        stopped.set()

    dmr = FakeDmr(on_set=after_set_uri)
    _install(monkeypatch, dmr)

    with caplog.at_level(logging.ERROR, logger="musicseeker.dlna"):
        ok = asyncio.run(dlna.cast_to_device(
            "u:dev", DEVICE["udn"], "Infinituri", "Alexia", "tok",
        ))

    assert stopped.is_set()
    assert ok is False                 # superseded, not "failed"
    assert dmr.stop_calls == 1
    assert dmr.play_calls == 0         # never resumed after the stop
    assert "AttributeError" not in caplog.text


def test_a_renderer_that_never_answers_is_reported_as_unreachable(renderer, monkeypatch):
    class DeadFactory:
        async def async_create_device(self, location):
            raise asyncio.TimeoutError()

    monkeypatch.setattr(dlna, "_get_factory", lambda: _coro(DeadFactory()))

    with pytest.raises(dlna.CastUnreachable) as exc:
        asyncio.run(dlna.cast_to_device("u:dev", DEVICE["udn"], "X", "Y", "tok"))
    assert exc.value.device == DEVICE["name"]


def test_a_renderer_in_standby_is_reported_as_refusing(renderer, monkeypatch):
    """An Onkyo in standby answers every AVTransport action with HTTP 501."""
    async def refuse():
        raise RuntimeError("Error during async_call(), action: SetAVTransportURI, status: 501, body: ")

    _install(monkeypatch, FakeDmr(on_set=refuse))

    with pytest.raises(dlna.CastRefused) as exc:
        asyncio.run(dlna.cast_to_device("u:dev", DEVICE["udn"], "X", "Y", "tok"))
    assert exc.value.device == DEVICE["name"]


def test_a_renderer_that_cannot_open_the_media_is_reported_as_refusing(renderer, monkeypatch):
    """701 Transition not available — the receiver is on but will not start the track."""
    async def no_transition():
        raise RuntimeError("Error during async_call(), action: Play, status: 500, "
                           "upnp error: 701 (Transition not available)")

    _install(monkeypatch, FakeDmr(on_play=no_transition))

    with pytest.raises(dlna.CastRefused):
        asyncio.run(dlna.cast_to_device("u:dev", DEVICE["udn"], "X", "Y", "tok"))
