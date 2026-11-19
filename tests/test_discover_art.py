"""Discover rows without art get the Deezer cover of the same thing (GitHub #9).

Last.fm hands out only its grey-star placeholder for tracks and artists, and
`lastfm._pick_image` rightly drops it — which left a Discover page of tracks or
artists with no art at all. `fill_missing_art` resolves each such row through
Deezer, the way the detail view always did. A wrong cover is worse than none,
so only a row credited to the same artist may lend its image.
"""
import asyncio

import pytest

from app.services import search_providers as sp


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    sp._art_cache.clear()
    calls = []

    async def fake_search(query, kind="track", limit=20, offset=0):
        calls.append((query, kind))
        return FAKE.get((query, kind), [])

    async def fake_artist(name):
        calls.append((name, "artist"))
        return FAKE.get((name, "artist"))

    monkeypatch.setattr(sp, "deezer_search", fake_search)
    monkeypatch.setattr(sp, "_deezer_artist_by_name", fake_artist)
    FAKE.clear()
    yield calls


FAKE: dict = {}


def _run(items):
    asyncio.run(sp.fill_missing_art(items))
    return items


def test_track_gets_the_cover_of_its_exact_title(_clean):
    FAKE[("Kassav' Siwo", "track")] = [
        {"name": "Siwo (Live)", "artist": "Kassav'", "image": "live.jpg"},
        {"name": "Siwo", "artist": "Kassav'", "image": "studio.jpg"},
    ]
    [row] = _run([{"name": "Siwo", "artist": "Kassav'", "image": "", "type": "track"}])
    assert row["image"] == "studio.jpg"


def test_another_artists_cover_is_not_borrowed(_clean):
    FAKE[("Kaysha One Love", "track")] = [
        {"name": "One Love", "artist": "Bob Marley", "image": "marley.jpg"},
    ]
    [row] = _run([{"name": "One Love", "artist": "Kaysha", "image": "", "type": "track"}])
    assert row["image"] == ""


def test_a_joined_credit_counts_as_the_artist(_clean):
    FAKE[("Kaysha Legendary", "album")] = [
        {"name": "Legendary", "artist": "Kaysha, Jessy Matador", "image": "a.jpg"},
    ]
    [row] = _run([{"name": "Legendary", "artist": "Kaysha", "image": "", "type": "album"}])
    assert row["image"] == "a.jpg"


def test_artist_rows_use_the_artist_picture(_clean):
    FAKE[("Kassav'", "artist")] = {"name": "Kassav'", "image": "pic.jpg"}
    [row] = _run([{"name": "Kassav'", "artist": "Kassav'", "image": "", "type": "artist"}])
    assert row["image"] == "pic.jpg"


def test_a_row_with_art_is_left_alone(_clean):
    [row] = _run([{"name": "X", "artist": "Y", "image": "lastfm.jpg", "type": "album"}])
    assert row["image"] == "lastfm.jpg"
    assert _clean == []


def test_a_miss_is_remembered(_clean):
    item = {"name": "Nope", "artist": "Nobody", "image": "", "type": "track"}
    _run([dict(item)])
    _run([dict(item)])
    assert len(_clean) == 1


def test_a_failed_lookup_is_not_remembered(_clean, monkeypatch):
    async def boom(*a, **k):
        _clean.append("boom")
        raise RuntimeError("Quota limit exceeded")

    monkeypatch.setattr(sp, "deezer_search", boom)
    item = {"name": "Siwo", "artist": "Kassav'", "image": "", "type": "track"}
    assert _run([dict(item)])[0]["image"] == ""
    _run([dict(item)])
    assert _clean == ["boom", "boom"]


def test_a_slow_deezer_does_not_hold_the_page(_clean, monkeypatch):
    monkeypatch.setattr(sp, "_ART_BUDGET_S", 0.2)

    async def slow(*a, **k):
        await asyncio.sleep(0.6)
        return [{"name": "Siwo", "artist": "Kassav'", "image": "late.jpg"}]

    monkeypatch.setattr(sp, "deezer_search", slow)

    async def main():
        loop = asyncio.get_running_loop()
        items = [{"name": "Siwo", "artist": "Kassav'", "image": "", "type": "track"}]
        t0 = loop.time()
        await sp.fill_missing_art(items)
        took = loop.time() - t0
        await asyncio.sleep(0.8)   # the late lookup finishes meanwhile
        return took, items

    took, items = asyncio.run(main())
    assert took < 0.5
    # The answer had gone out without it; the late cover must not change the
    # row afterwards, but it must be there for the next view.
    assert items[0]["image"] == ""
    again = _run([{"name": "Siwo", "artist": "Kassav'", "image": "", "type": "track"}])
    assert again[0]["image"] == "late.jpg"


def test_another_release_of_the_same_artist_lends_no_cover(_clean):
    FAKE[("Kaysha Legendary (Deluxe)", "album")] = [
        {"name": "Fresh Air", "artist": "Kaysha", "image": "fresh.jpg"},
    ]
    [row] = _run([{"name": "Legendary (Deluxe)", "artist": "Kaysha", "image": "", "type": "album"}])
    assert row["image"] == ""


def test_a_version_of_the_same_title_lends_its_cover(_clean):
    FAKE[("Kassav' Siwo - Live 1991", "track")] = [
        {"name": "Syé Bwa", "artist": "Kassav'", "image": "other.jpg"},
        {"name": "Siwo", "artist": "Kassav'", "image": "siwo.jpg"},
    ]
    [row] = _run([{"name": "Siwo - Live 1991", "artist": "Kassav'", "image": "", "type": "track"}])
    assert row["image"] == "siwo.jpg"


def test_a_cancelled_request_cancels_its_lookups(_clean, monkeypatch):
    started, finished = [], []

    async def slow(*a, **k):
        started.append(1)
        await asyncio.sleep(2)
        finished.append(1)
        return []

    monkeypatch.setattr(sp, "deezer_search", slow)

    async def main():
        items = [{"name": f"T{i}", "artist": "A", "image": "", "type": "track"} for i in range(3)]
        task = asyncio.ensure_future(sp.fill_missing_art(items))
        await asyncio.sleep(0.1)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(2.2)

    asyncio.run(main())
    assert started and not finished
