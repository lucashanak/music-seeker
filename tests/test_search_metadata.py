"""The small facts a result carries: explicit lyrics, and album ordering.

The explicit flag is the kind of field that silently becomes False for every
row when a provider renames it, so these pin the provider's actual key names
rather than the mapper's output shape.
"""
import asyncio

from app.services import search_providers as sp


def run(coro):
    return asyncio.run(coro)


def test_deezer_track_carries_the_explicit_flag():
    clean = sp._deezer_track({"id": 1, "title": "x", "explicit_lyrics": False})
    dirty = sp._deezer_track({"id": 2, "title": "y", "explicit_lyrics": True})
    assert clean["explicit"] is False
    assert dirty["explicit"] is True


def test_a_provider_that_omits_the_field_is_not_explicit():
    assert sp._deezer_track({"id": 3, "title": "z"})["explicit"] is False
    assert sp._deezer_album({"id": 4, "title": "z"})["explicit"] is False


def _album(aid, fans=0):
    return {"id": aid, "name": f"album {aid}", "fans": fans}


def _top(*album_ids):
    return [{"id": str(i), "album_id": a} for i, a in enumerate(album_ids)]


def test_albums_lead_with_the_one_carrying_the_biggest_hit():
    albums = [_album("c"), _album("a"), _album("b")]
    ranked = sp._rank_albums(albums, _top("b", "b", "a"))
    assert [a["id"] for a in ranked[:2]] == ["b", "a"]


def test_albums_with_no_hit_fall_in_behind_by_fans():
    albums = [_album("x", fans=10), _album("y", fans=900), _album("hit")]
    ranked = sp._rank_albums(albums, _top("hit"))
    assert [a["id"] for a in ranked] == ["hit", "y", "x"]


def test_ranking_an_artist_with_no_top_tracks_keeps_a_stable_order():
    albums = [_album("x", fans=5), _album("y", fans=50)]
    assert [a["id"] for a in sp._rank_albums(albums, [])] == ["y", "x"]


# ── Artist search: who is actually called this, biggest first ──

def _artist(aid, name, fans):
    return {"id": aid, "name": name, "artist": name, "fans": fans, "type": "artist"}


def _fake_artist_search(monkeypatch, rows):
    async def fake(query, search_type="track", limit=20, offset=0):
        assert search_type == "artist"
        return rows[offset:offset + limit]
    monkeypatch.setattr(sp, "deezer_search", fake)


def test_the_big_namesake_is_pulled_in_front_of_the_obscure_one(monkeypatch):
    # Deezer really does return the 259-fan UK band ahead of the 10M-fan one.
    _fake_artist_search(monkeypatch, [
        _artist("1", "Nirvana (UK)", 259),
        _artist("2", "Nirvana", 10_000_000),
        _artist("3", "Approaching Nirvana", 10_015),
    ])
    out = run(sp._deezer_artists_by_size("Nirvana", 5, 0))
    assert [a["name"] for a in out] == ["Nirvana", "Nirvana (UK)", "Approaching Nirvana"]


def test_a_query_that_is_nobody_s_name_keeps_deezer_s_order(monkeypatch):
    rows = [_artist("1", "Rock & Rollinger", 161), _artist("2", "Rock & Bluse", 106)]
    _fake_artist_search(monkeypatch, rows)
    assert run(sp._deezer_artists_by_size("rock", 5, 0)) is None


def test_nothing_is_reordered_when_the_match_already_leads(monkeypatch):
    _fake_artist_search(monkeypatch, [_artist("1", "Adele", 9_000_000), _artist("2", "Adele & Zalem", 12)])
    assert run(sp._deezer_artists_by_size("Adele", 5, 0)) is None


def test_no_artist_is_dropped_by_the_reorder(monkeypatch):
    rows = [_artist(str(i), f"Band {i}", i) for i in range(1, 6)] + [_artist("x", "Target", 5)]
    _fake_artist_search(monkeypatch, rows)
    out = run(sp._deezer_artists_by_size("Target", 10, 0))
    assert len(out) == len(rows) and out[0]["name"] == "Target"
