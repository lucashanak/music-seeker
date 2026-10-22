"""The single "Top result" card on the All tab.

Somebody on Deezer is named after almost every famous song, so an exact name
match proves nothing on its own — and how big that namesake is cannot settle it
either: Portishead has 584 k fans, Khruangbin 99 k, Chinaski 17 728 and Kryptor
148, all of them below "Hurt" (8 076) and "Bohemian Rhapsody" (5 371). What does
separate the two cases is how much of the page already belongs to the artist.

The pages below are the shapes measured against the live Deezer API on
2026-10-22 through `search_all(limit_per_type=8)` — the counts in each row are
how many of the eight tracks and eight albums carried the queried name
(`scratchpad/autor2-5-c6/signaly.txt`).
"""
import asyncio

from app.services import search_providers as sp


def artist(name, fans=None, aid="a1"):
    a = {"id": aid, "name": name, "artist": name, "type": "artist"}
    if fans is not None:
        a["fans"] = fans
    return a


def track(name, by, tid="t1"):
    return {"id": tid, "name": name, "artist": by, "type": "track"}


def album(name, by, alid="al1"):
    return {"id": alid, "name": name, "artist": by, "type": "album"}


def page(query, owner, owned_tracks, owned_albums, size=8):
    """One result page: `owned_*` rows credited to `owner`, the rest to strangers."""
    tracks = [track(f"{owner} song {i}", owner, f"t{i}") if i < owned_tracks
              else track(f"stranger song {i}", f"Someone Else {i}", f"t{i}")
              for i in range(size)]
    albums = [album(f"{owner} album {i}", owner, f"al{i}") if i < owned_albums
              else album(f"stranger album {i}", f"Someone Else {i}", f"al{i}")
              for i in range(size)]
    return tracks, albums


def pick(query, tracks=(), artists=(), albums=(), playlists=()):
    return sp._pick_top_result(query, list(tracks), list(artists),
                               list(albums), list(playlists))


# ── the side the first round broke: artists smaller than a famous song ─────

REAL_ARTISTS = [
    # query,         fans,       tracks of 8, albums of 8
    ("chinaski",       17_728,  8, 8),
    ("ektor",          36_487,  7, 7),
    ("yzomandias",     15_238,  7, 8),
    ("mandrage",       14_539,  8, 8),
    ("wohnout",        13_555,  7, 8),
    ("olympic",         5_071,  8, 8),
    ("mig 21",          4_430,  8, 8),
    ("kryptor",           148,  1, 2),
    ("portishead",    584_000,  8, 8),
    ("khruangbin",     99_000,  8, 8),
    ("adele",      15_500_326,  8, 8),
    ("queen",      12_841_063,  8, 8),
    ("nirvana",    10_092_597,  8, 8),
]


def test_an_artist_wins_their_own_name_however_small_they_are():
    for query, fans, owned_tracks, owned_albums in REAL_ARTISTS:
        tracks, albums = page(query, query, owned_tracks, owned_albums)
        top = pick(query, tracks=tracks, artists=[artist(query, fans)], albums=albums)
        assert top["type"] == "artist", f"{query!r} ({fans} fans) lost their own name"


# ── the side that fails without the gate: a song with a namesake band ──────

NAMESAKES = [
    # query,              namesake fans, who made the song, their rows of 8+8
    ("one more time",       4_187,  "Daft Punk",        0, 0),
    ("creep",               4_020,  "Radiohead",        0, 0),
    ("bohemian rhapsody",   5_371,  "Queen",            0, 0),
    ("yesterday",           1_193,  "Hamza",            0, 0),
    ("hurt",                8_076,  "Johnny Cash",      0, 1),
    ("thriller",              324,  "Michael Jackson",  0, 0),
]


def test_a_song_beats_a_band_that_owns_none_of_the_page():
    for query, fans, performer, owned_tracks, owned_albums in NAMESAKES:
        tracks, albums = page(query, query, owned_tracks, owned_albums)
        tracks[0] = track(query, performer, "t0")   # the song people meant
        top = pick(query, tracks=tracks, artists=[artist(query, fans)], albums=albums)
        assert top["type"] == "track", f"{query!r} still picked the namesake"
        assert top["artist"] == performer


# ── providers that publish no size at all ──────────────────────────────────

def test_a_provider_without_fan_counts_still_gets_an_artist_card():
    """iTunes and YouTube Music map no `fans` key — measured, every artist row.

    A gate that reads a number those two never send is a gate that is always
    shut: before this, `?provider=itunes&q=metallica` answered with the track
    "One" and the Metallica card was gone from the top of the page.
    """
    for query in ("metallica", "queen", "chinaski"):
        tracks, albums = page(query, query, 8, 8)
        top = pick(query, tracks=tracks, artists=[artist(query)], albums=albums)
        assert top["type"] == "artist" and "fans" not in top


def test_a_bigger_page_does_not_let_the_namesake_in_through_the_back():
    """`limit_per_type` goes to 20, and three rows of forty is not ownership.

    Measured against Deezer at 20 a type: the band "Hurt" held five of the forty
    rows — none of them near the top — and an uncapped count handed it the card
    over Johnny Cash.
    """
    tracks = [track(f"song {i}", "Hurt" if 10 <= i < 15 else f"Someone Else {i}", f"t{i}")
              for i in range(20)]
    tracks[0] = track("Hurt", "Johnny Cash", "t0")
    albums = [album(f"album {i}", f"Someone Else {i}", f"al{i}") for i in range(20)]
    top = pick("hurt", tracks=tracks, artists=[artist("Hurt", 8_076)], albums=albums)
    assert top["type"] == "track" and top["artist"] == "Johnny Cash"


def test_a_joined_credit_counts_for_everyone_named_in_it():
    """YouTube Music hands back one string for several performers."""
    tracks = [track(f"song {i}", "Queen, David Bowie", f"t{i}") for i in range(4)]
    top = pick("david bowie", tracks=tracks, artists=[artist("David Bowie")])
    assert top["type"] == "artist"


def test_a_comma_inside_a_name_is_not_a_list_of_two():
    """Reading the credit as a list must not lose the names that contain commas."""
    tracks = [track(f"song {i}", "Crosby, Stills & Nash", f"t{i}") for i in range(4)]
    top = pick("crosby, stills & nash", tracks=tracks,
               artists=[artist("Crosby, Stills & Nash")])
    assert top["type"] == "artist"


def test_an_ampersand_credit_counts_for_everyone_named_in_it():
    """iTunes joins a collaboration with " & ", and that is the whole page here.

    The five rows below are the live iTunes answer to "yzomandias" on
    2026-10-22 (`scratchpad/autor3-5-c6/sonda-vlastnictvi-pred.txt`), credits
    verbatim. Three of them are his; split on the comma alone they are nobody's,
    the gate shuts, and the card goes to the single "Elegancko".
    """
    tracks = [track("Elegancko", "Żabson & Yzomandias", "t0"),
              track("Dresscode (feat. Yzomandias)", "El Nino", "t1"),
              track("Sokratov Cowbell", "Fvck_kvlt & Yzomandias", "t2"),
              track("Revoluce (feat. Yzomandias & Dusan Vlk)", "Gosha Grey", "t3")]
    albums = [album("Elegancko - Single", "Żabson & Yzomandias", "al0")]
    top = pick("yzomandias", tracks=tracks, artists=[artist("Yzomandias")], albums=albums)
    assert top["type"] == "artist"


def test_an_ampersand_inside_a_name_is_not_a_list_of_two():
    """The same trap the comma has: " & " is part of plenty of real names.

    Measured on the live pages, "Earth, Wind & Fire" carries both joiners at
    once — split on either and the band that made the record disappears.
    """
    tracks = [track(f"song {i}", "Earth, Wind & Fire", f"t{i}") for i in range(4)]
    top = pick("earth, wind & fire", tracks=tracks, artists=[artist("Earth, Wind & Fire")])
    assert top["type"] == "artist"


def test_a_short_page_is_judged_by_its_own_size():
    """Three rows is the bar, but a two-row page cannot clear a bar of three.

    iTunes answers some queries with a handful of rows (the "yzomandias" page
    above is five), so "enough" has to mean the whole page when the page is
    smaller than the threshold. Both rows here are the artist's: there is no
    stronger evidence this page can give.
    """
    tracks = [track("Jasná Zpráva", "Olympic", "t0"), track("Osmý Den", "Olympic", "t1")]
    top = pick("olympic", tracks=tracks, artists=[artist("Olympic")])
    assert top["type"] == "artist"


def test_ownership_is_read_from_the_id_when_the_credit_text_differs():
    """Deezer stamps `artist_id`, which survives a credit no split can read.

    This shape is constructed, and deliberately so: measured over twelve artist
    queries against the live Deezer, **no** row came back whose `artist_id` was
    the artist's while the credit text was not
    (`scratchpad/autor3-5-c6/sonda-id-vs-text.txt`) — Deezer builds both from
    the same artist record. The id is therefore not what carries the gate today;
    it is what keeps it standing when a credit is written in a way reading the
    text cannot catch, as "a hosté" ("and guests") is.
    """
    tracks = [{"id": f"t{i}", "name": f"song {i}", "artist": "Mig 21 a hosté",
               "artist_id": "a1", "type": "track"} for i in range(4)]
    top = pick("mig 21", tracks=tracks, artists=[artist("Mig 21", 4_430, "a1")])
    assert top["type"] == "artist"


# ── the rest of the ladder, unchanged ──────────────────────────────────────

def test_the_biggest_namesake_decides_not_the_first_listed():
    """Deezer's artist relevance order is not size order.

    "Adele" comes back with four artists of that name; if the 386-fan one were
    taken as "the" exact match, the real Adele would still win the card — but
    the user would be sent to a stranger's page.
    """
    tracks, albums = page("adele", "Adele", 8, 8)
    top = pick("adele", tracks=tracks, albums=albums,
               artists=[artist("Adele", 386, "a2"), artist("Adele", 15_500_326, "a1")])
    assert top["type"] == "artist" and top["id"] == "a1"


def test_a_small_namesake_is_still_better_than_an_unrelated_album():
    """Nothing else matches the query, so the band called "Thriller" is the answer."""
    top = pick("thriller",
               tracks=[],
               albums=[album("Bad", "Michael Jackson", "al9")],
               artists=[artist("Someone Else", 900_000, "a9"), artist("Thriller", 324, "a1")])
    assert top["id"] == "a1"


def test_an_exact_song_title_wins_over_an_unrelated_first_track():
    top = pick("creep",
               tracks=[track("Creepin'", "Metro Boomin", "t9"), track("Creep", "Radiohead", "t1")],
               artists=[artist("Creep", 4_020)])
    assert top["id"] == "t1"


def test_nothing_in_means_nothing_out():
    assert pick("whatever") is None


# ── the page the gate is given: iTunes answers for a storefront ────────────
#
# This one is not about `_pick_top_result` but about its input, which is why it
# sits next to it: the gate asks how much of the page is the artist's, and on
# the US storefront the answer for "olympic" is none of it — iTunes returns the
# Games, John Williams and a French 79 single. Both pages below are the live
# iTunes answers of 2026-10-22, trimmed to the fields the mapper reads
# (`scratchpad/autor3-5-c6/itunes-syrove.txt`,
# `scratchpad/autor3-5-c6/itunes-olympic-kdo.txt`).

OLYMPIC_US = [
    {"trackId": 1, "trackName": "Olympic Theme", "artistName": "Cleveland Symphonic Winds & Frederick Fennell"},
    {"trackId": 2, "trackName": "Olympic Fanfare and Theme", "artistName": "Berlin Philharmonic Orchestra & John Williams"},
    {"trackId": 3, "trackName": "Olympic", "artistName": "French 79"},
    {"trackId": 4, "trackName": "Olympic", "artistName": "Millencolin"},
]

OLYMPIC_CZ = [
    {"trackId": 11, "trackName": "Jasná Zpráva", "artistName": "Olympic"},
    {"trackId": 12, "trackName": "Dej Mi Víc Své Lásky", "artistName": "Olympic"},
    {"trackId": 13, "trackName": "Slzy Tvý Mámy", "artistName": "Olympic"},
    {"trackId": 14, "trackName": "Osmý Den", "artistName": "Olympic"},
]


def test_itunes_searches_the_users_storefront_not_the_american_one(monkeypatch):
    """`country` decides the catalogue; without it the API always answers US.

    Deezer and YouTube Music both answer for the region they are called from —
    measured in round one, Deezer even names its genres in Czech unasked. iTunes
    does not, so the gate was being handed a page about the Olympic Games and
    was right to shut on it.
    """
    sent = []

    class _Resp:
        def __init__(self, data):
            self._data = data

        def raise_for_status(self):
            pass

        def json(self):
            return self._data

    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None, headers=None):
            sent.append(params or {})
            country = (params or {}).get("country", "US")
            return _Resp({"results": OLYMPIC_CZ if country == "CZ" else OLYMPIC_US})

    monkeypatch.setattr(sp.httpx, "AsyncClient", _Client)
    rows = asyncio.run(sp.itunes_search("olympic", "track", 4))

    assert sent and sent[0].get("country") == "CZ", f"no storefront asked for: {sent}"
    assert [r["artist"] for r in rows] == ["Olympic"] * 4
    # and that page is the artist's own, so the card is theirs again
    top = pick("olympic", tracks=rows, artists=[artist("Olympic")])
    assert top["type"] == "artist"
