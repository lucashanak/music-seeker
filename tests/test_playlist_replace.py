"""POST /api/library/playlist/{id}/replace-by-name — the write behind Up Next.

An explicit empty list clears the playlist (Clear on Up Next, also the remote
target's queue_op clear); a non-empty list none of whose names matched is still
never applied. Navidrome refuses a write with HTTP 200 + status "failed", and a
refused append must never be followed by the removal of the original rows.
"""
import httpx
import pytest

from app.services import library
from test_playlist_transfer import FakeNavidrome, env  # noqa: F401  (fixture)

KNOWN = {"seven": "7", "eight": "8", "nine": "9"}


@pytest.fixture(autouse=True)
def names(monkeypatch):
    async def fake_find(name, artist="", album=""):
        return KNOWN.get(name)
    monkeypatch.setattr(library, "find_song_id", fake_find)


def _replace(client, pid, names_):
    return client.post(f"/api/library/playlist/{pid}/replace-by-name",
                       json={"tracks": [{"name": n, "artist": "A"} for n in names_]})


def test_an_empty_list_clears_the_playlist(env):
    fake, c = env
    r = _replace(c, "A", [])
    assert r.status_code == 200, r.text
    assert fake.pl["A"] == []
    assert r.json()["matched"] == 0


def test_a_list_that_matched_nothing_is_not_applied(env):
    fake, c = env
    r = _replace(c, "A", ["unknown", "also unknown"])
    assert r.status_code == 200
    assert fake.pl["A"] == ["1", "2", "3", "4"]
    assert len(r.json()["missing"]) == 2


def test_a_replace_puts_exactly_the_matched_tracks(env):
    fake, c = env
    r = _replace(c, "A", ["seven", "unknown", "eight"])
    assert r.status_code == 200
    assert fake.pl["A"] == ["7", "8"]
    assert r.json()["matched"] == 2


def test_a_refused_append_leaves_the_playlist_as_it_was(env):
    fake, c = env
    fake.refuse_ids = {"8"}
    r = _replace(c, "A", ["seven", "eight"])
    assert r.status_code == 502
    assert fake.pl["A"] == ["1", "2", "3", "4"]


def test_a_refused_removal_is_rolled_back(env, monkeypatch):
    fake, c = env
    refused = []

    async def handler(request: httpx.Request):
        if request.url.params.get_list("songIndexToRemove") and not refused:
            refused.append(1)          # the first removal only; the rollback's goes through
            return httpx.Response(200, json={"subsonic-response": {"status": "failed"}})
        return await fake.handler(request)
    transport = httpx.MockTransport(handler)
    real_client = httpx._client.AsyncClient
    monkeypatch.setattr(library.httpx, "AsyncClient",
                        lambda *a, **kw: real_client(*a, **{**kw, "transport": transport}))

    r = _replace(c, "B", ["seven"])
    assert refused
    assert r.status_code == 502
    assert fake.pl["B"] == ["7", "8", "9"]


def test_a_read_only_playlist_answers_an_error_and_is_untouched(env):
    fake, c = env
    for names_ in (["seven"], []):
        r = _replace(c, "R", names_)
        assert r.status_code == 502, names_
        assert fake.pl["R"] == ["5"]
