"""Mix search across SoundCloud / YouTube / Mixcloud / hearthis.at: each site's
answer is read into one shape with the quality it will download in, the same set
on several sites folds into one result, and YouTube is asked only flat and never
while the rate-limit latch is set.

No network and no yt-dlp: every answer below is a trimmed copy of what the site
(or yt-dlp) returned on the production container on 2026-11-17.
"""
import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import bind_navidrome_creds
from app.routers import downloads
from app.services import auth, downloader, mix_sources, mixes, player

# ── captured answers ──

SC_SEARCH = {"_type": "playlist", "entries": [
    {"title": "DJ TOKINOU ZOUK MIX SESSION 2025", "uploader": "DJ TOKINOU", "uploader_id": "4199618",
     "uploader_url": "https://soundcloud.com/djtokinou",
     "webpage_url": "https://soundcloud.com/djtokinou/dj-tokinou-zouk-mix-session-2025",
     "duration": 2620.727, "timestamp": 1739188742,
     "thumbnails": [{"url": "https://i1.sndcdn.com/a-original.png"}, {"url": "https://i1.sndcdn.com/a-t500x500.jpg"}],
     "formats": [{"format_id": "hls_aac_96k", "acodec": "aac", "vcodec": "none", "abr": 96},
                 {"format_id": "hls_aac_160k", "acodec": "aac", "vcodec": "none", "abr": 160}]},
    {"title": "Old upload", "uploader": "Myster Rudy", "uploader_url": "https://soundcloud.com/mister-rudy",
     "webpage_url": "https://soundcloud.com/mister-rudy/zouk-nostalgie-2", "duration": 3844.2,
     "formats": [{"format_id": "http_mp3_128", "acodec": "mp3", "vcodec": "none", "abr": 128},
                 {"format_id": "hls_opus_64", "acodec": "opus", "vcodec": "none", "abr": 64}]},
    {"title": "a playlist link is not a mix", "webpage_url": "https://soundcloud.com/x/sets/y", "formats": []},
]}

YT_FLAT = {"_type": "playlist", "entries": [
    {"id": "9SthwiM5Wb8", "title": "BEST OF ZOUK MEMORIES MIX BY DJ JEFF FRESH", "duration": 3551,
     "channel": "DJ Jeff Fresh", "channel_id": "UCtok6JZpJBYWYen10os9E2g",
     "channel_url": "https://www.youtube.com/channel/UCtok6JZpJBYWYen10os9E2g",
     "uploader": "DJ Jeff Fresh", "uploader_id": "@djjefffresh", "timestamp": None},
    {"id": "liveNow0000", "title": "live", "duration": None, "live_status": "is_live",
     "channel_id": "UCtok6JZpJBYWYen10os9E2g"},
    {"id": "NA", "title": "broken"},
]}

YT_CHANNEL = {"_type": "playlist", "channel": "DJ Jeff Fresh", "channel_id": "UCtok6JZpJBYWYen10os9E2g",
              "uploader": "DJ Jeff Fresh", "entries": [
                  {"id": "y8hSGLJgEc4", "title": "THE BEST OF NU LOOK MIX BY DJ JEFF FRESH", "duration": 3634,
                   "channel": None, "channel_id": None}]}

MC_SEARCH = {"viewer": {"search": {"searchQuery": {"cloudcasts": {"edges": [
    {"node": {"name": "The Double XL Show Ep11 S3 (Spécial zouk, Kompa & Afro Zouk)",
              "slug": "the-double-xl-show-ep11-s3", "audioQuality": "HQ", "audioLength": 3814,
              "publishDate": "2026-02-06T23:15:40+00:00",
              "picture": {"urlRoot": "extaudio/9/b/f/b/4def"},
              "owner": {"username": "Radio_RapTz", "displayName": "Radio RapTz", "picture": {"urlRoot": "profile/6"}}}},
    {"node": {"name": "Zouktime 2025 brno sunday set", "slug": "zouktime-marathon-brno-sunday-set",
              "audioQuality": "SQ", "audioLength": 3721, "publishDate": "2025-04-21T20:53:27+00:00",
              "picture": None,
              "owner": {"username": "martin-šmoldas", "displayName": "Martin Šmoldas", "picture": {"urlRoot": "profile/4"}}}},
]}}}}}

HT_SEARCH = [
    {"id": "283718", "title": "Zouk Overdose Mix", "duration": "4421",
     "permalink_url": "https://hearthis.at/djshinski/dj-shinski-zouk-overdose-mix/", "downloadable": "1",
     "artwork_url": "https://img.hearthis.at/a.jpg", "release_timestamp": 1438106013, "private": 0,
     "user": {"username": "DJ Shinski", "permalink": "djshinski", "permalink_url": "https://hearthis.at/djshinski/"}},
    {"id": "1064150", "title": "Zouk mix session manege", "duration": "2169",
     "permalink_url": "https://hearthis.at/jeamo972/zouk-mix-session-manege/", "downloadable": "0",
     "artwork_url": "", "user": {"username": "JeaMO972", "permalink": "jeamo972", "avatar_url": "https://img/av.jpg"}},
]


# ── parsers ──

def test_soundcloud_entries_carry_the_quality_the_download_gets():
    items = mix_sources.parse_soundcloud_playlist(SC_SEARCH)
    assert len(items) == 2        # the set link is not a mix
    a = items[0]
    assert a["url"] == "https://soundcloud.com/djtokinou/dj-tokinou-zouk-mix-session-2025"
    assert (a["codec"], a["kbps"], a["quality_known"], a["quality_label"]) == ("AAC", 160, True, "AAC 160")
    # The permalink (usable for /<user>/tracks), not the numeric id.
    assert a["uploader_id"] == "djtokinou" and a["uploader_url"] == "https://soundcloud.com/djtokinou"
    assert a["thumbnail"].endswith("t500x500.jpg") and a["duration"] == 2620
    assert a["date"] == "2025-02-10" and a["also"] == []
    # An old MP3 upload: no AAC, so the best audio — MP3 128, not the Opus.
    assert (items[1]["codec"], items[1]["kbps"]) == ("MP3", 128)


def test_youtube_flat_results_are_nominal_and_skip_live_and_broken():
    items = [mix_sources.parse_youtube_entry(e) for e in YT_FLAT["entries"]]
    items = [i for i in items if i]
    assert len(items) == 1
    y = items[0]
    assert y["url"] == "https://www.youtube.com/watch?v=9SthwiM5Wb8"
    assert y["uploader"] == "DJ Jeff Fresh" and y["uploader_id"] == "UCtok6JZpJBYWYen10os9E2g"
    assert (y["kbps"], y["quality_known"], y["quality_label"]) == (128, False, "AAC 128")
    assert y["duration"] == 3551


def test_youtube_channel_entries_take_the_channel_from_the_listing():
    items = mix_sources.parse_youtube_channel(YT_CHANNEL)
    assert items[0]["uploader"] == "DJ Jeff Fresh"
    assert items[0]["uploader_id"] == "UCtok6JZpJBYWYen10os9E2g"


def test_mixcloud_search_states_hq_and_sq():
    items = mix_sources.parse_mixcloud_search(MC_SEARCH)
    hq, sq = items
    assert (hq["kbps"], hq["quality_label"], hq["quality_known"]) == (192, "AAC 192", True)
    assert (sq["kbps"], sq["quality_label"]) == (64, "AAC 64")
    assert hq["url"] == "https://www.mixcloud.com/Radio_RapTz/the-double-xl-show-ep11-s3/"
    assert hq["thumbnail"] == "https://thumbnailer.mixcloud.com/unsafe/300x300/extaudio/9/b/f/b/4def"
    # The username is percent-encoded exactly as parse_mix_url rebuilds it.
    assert sq["url"] == mixes.parse_mix_url(sq["url"])[1]
    assert sq["uploader"] == "Martin Šmoldas" and sq["uploader_id"] == "martin-šmoldas"
    assert sq["thumbnail"].endswith("/profile/4")    # no mix picture → the owner's


def test_hearthis_downloadable_is_192_and_stream_only_is_128():
    a, b = mix_sources.parse_hearthis_list(HT_SEARCH)
    assert (a["codec"], a["kbps"], a["quality_known"]) == ("MP3", 192, False)
    assert (b["kbps"], b["quality_known"]) == (128, False)
    assert a["url"] == "https://hearthis.at/djshinski/dj-shinski-zouk-overdose-mix/"
    assert a["uploader"] == "DJ Shinski" and a["uploader_id"] == "djshinski"
    assert a["duration"] == 4421
    assert b["thumbnail"] == "https://img/av.jpg"
    assert mix_sources.parse_hearthis_list({"error": "x"}) == []


def test_quality_from_formats_follows_the_download_selector():
    # Mixcloud HQ: AAC 192 beside Opus ~195 — the selector takes the AAC.
    fmts = [{"format_id": "hls-192", "acodec": "mp4a.40.2", "vcodec": "none", "abr": 192},
            {"format_id": "dash-f2", "acodec": "opus", "vcodec": "none", "abr": 195}]
    assert mixes.quality_from_formats(fmts)["quality_label"] == "AAC 192"
    # hearthis: no rates in the list; mp3-1 (download) beats mp3-0 (stream).
    q = mixes.quality_from_formats([{"format_id": "mp3-0", "acodec": "mp3", "ext": "mp3"},
                                    {"format_id": "mp3-1", "acodec": "mp3", "ext": "mp3"}])
    assert (q["codec"], q["kbps"], q["quality_known"]) == ("MP3", 192, False)
    # YouTube: itag 140 (AAC 129) wins over Opus 141 and the video formats.
    q = mixes.quality_from_formats([
        {"format_id": "140", "acodec": "mp4a.40.2", "vcodec": "none", "abr": 129.5},
        {"format_id": "251", "acodec": "opus", "vcodec": "none", "abr": 141},
        {"format_id": "18", "acodec": "mp4a.40.2", "vcodec": "avc1", "tbr": 500}])
    assert q["quality_label"] == "AAC 130" and q["quality_known"] is True
    assert mixes.quality_from_formats([]) is None


# ── folding and ordering ──

def _it(source, title, duration, kbps, known=True):
    return mix_sources.make_item(source, f"https://x/{source}/{title}", title, "DJ", "dj", "", "",
                                 duration, mixes.nominal_quality("AAC", kbps, known))


def test_the_same_set_on_two_sites_becomes_one_result_with_the_best_copy():
    mc = _it("mixcloud", "Zouktime Marathon – Brno Sunday Set!", 3721, 64)
    sc = _it("soundcloud", "zouktime marathon brno sunday set", 3700, 160)   # -0.6 %
    other = _it("hearthis", "Kizomba night", 3721, 192)
    out = mix_sources.dedupe([mc, other, sc])
    assert len(out) == 2
    first = out[0]
    assert first["source"] == "soundcloud" and first["kbps"] == 160
    assert [a["source"] for a in first["also"]] == ["mixcloud"]
    assert first["also"][0]["kbps"] == 64 and first["also"][0]["quality_label"] == "AAC 64"


@pytest.mark.parametrize("a,b,da,db", [
    ("Zouk mix vol 2", "Zouk mix vol 3", 3600, 3600),             # numbers differ
    ("Zouk session brno", "Zouk session brno", 3600, 3700),       # 2.7 % longer
    ("Zouk session brno sunday", "Kizomba afternoon party", 3600, 3600),
])
def test_different_sets_stay_apart(a, b, da, db):
    out = mix_sources.dedupe([_it("mixcloud", a, da, 64), _it("soundcloud", b, db, 160)])
    assert len(out) == 2


def test_two_uploads_on_one_site_are_not_folded():
    out = mix_sources.dedupe([_it("mixcloud", "Zouk set", 3600, 64), _it("mixcloud", "Zouk set", 3600, 64)])
    assert len(out) == 2


def test_title_normalisation_drops_case_diacritics_and_punctuation():
    assert mix_sources.norm_title("Šmoldas: ZOUK-time (Brno)!") == {"smoldas", "zouk", "time", "brno"}
    assert mix_sources.jaccard({"a", "b", "c"}, {"a", "b", "d"}) == 0.5


def test_sources_interleave_round_robin_and_quality_bands_keep_relevance():
    per = {"soundcloud": [_it("soundcloud", "s1", 1, 160), _it("soundcloud", "s2", 1, 160)],
           "youtube": [_it("youtube", "y1", 1, 128, False)],
           "mixcloud": [_it("mixcloud", "m1", 1, 64), _it("mixcloud", "m2", 1, 192)],
           "hearthis": [_it("hearthis", "h1", 1, 192)]}
    rel = mix_sources.interleave(per)
    assert [i["title"] for i in rel] == ["s1", "y1", "m1", "h1", "s2", "m2"]
    by_q = mix_sources.sort_by_quality(rel)
    assert [i["title"] for i in by_q] == ["h1", "m2", "s1", "s2", "y1", "m1"]
    assert [mix_sources.quality_band(k) for k in (320, 192, 191, 160, 128, 127, 0)] == [0, 0, 1, 1, 2, 3, 3]


# ── the search ──

@pytest.fixture
def fake_sources(monkeypatch):
    calls = []

    def maker(name, result):
        async def f(q):
            calls.append((name, q))
            if isinstance(result, Exception):
                raise result
            return result
        return f

    mix_sources._cache.clear()
    yield calls, maker
    mix_sources._cache.clear()


def test_search_returns_partial_results_with_per_source_errors(monkeypatch, fake_sources):
    calls, maker = fake_sources
    monkeypatch.setattr(mix_sources, "SEARCHERS", {
        "soundcloud": maker("soundcloud", mix_sources.parse_soundcloud_playlist(SC_SEARCH)),
        "youtube": maker("youtube", mix_sources.SourceError(mix_sources.YT_RATE_LIMITED)),
        "mixcloud": maker("mixcloud", mix_sources.parse_mixcloud_search(MC_SEARCH)),
        "hearthis": maker("hearthis", RuntimeError("boom")),
    })
    r = asyncio.run(mix_sources.search("  zouk   mix ", list(mix_sources.SOURCES)))
    assert r["query"] == "zouk mix"
    assert r["errors"] == {"youtube": "YouTube is rate-limiting us", "hearthis": "boom"}
    assert r["counts"] == {"soundcloud": 2, "mixcloud": 2}
    assert [i["kbps"] for i in r["results"]] == [192, 160, 128, 64]
    assert sorted(i["relevance"] for i in r["results"]) == [0, 1, 2, 3]
    # Cached per (source, query): a second search asks only the sources that failed.
    calls.clear()
    asyncio.run(mix_sources.search("zouk mix", list(mix_sources.SOURCES)))
    assert sorted(c[0] for c in calls) == ["hearthis", "youtube"]


def test_search_asks_only_the_sources_wanted(monkeypatch, fake_sources):
    calls, maker = fake_sources
    monkeypatch.setattr(mix_sources, "SEARCHERS", {s: maker(s, []) for s in mix_sources.SOURCES})
    asyncio.run(mix_sources.search("x", mix_sources.parse_sources("mixcloud,hearthis,evil")))
    assert sorted(c[0] for c in calls) == ["hearthis", "mixcloud"]
    assert mix_sources.parse_sources("") == list(mix_sources.SOURCES)


def test_youtube_is_not_asked_while_rate_limited(monkeypatch):
    ran = []

    async def tripwire(cmd, timeout):
        ran.append(cmd)
        return 0, "{}", ""

    monkeypatch.setattr(mixes, "_run_capture", tripwire)
    monkeypatch.setattr(player, "_yt_blocked_until", player.time.monotonic() + 100)
    with pytest.raises(mix_sources.SourceError, match="rate-limiting"):
        asyncio.run(mix_sources.search_youtube("zouk mix"))
    with pytest.raises(mix_sources.SourceError, match="rate-limiting"):
        asyncio.run(mix_sources.uploads("youtube", "UCtok6JZpJBYWYen10os9E2g"))
    assert ran == []


def test_youtube_search_is_flat_small_and_feeds_the_rate_limit_latch(monkeypatch):
    seen = {}

    async def fake(cmd, timeout):
        seen["cmd"] = cmd
        return 0, '{"entries": []}', "ERROR: HTTP Error 429: Too Many Requests"

    monkeypatch.setattr(mixes, "_run_capture", fake)
    monkeypatch.setattr(player, "_yt_blocked_until", 0.0)
    with pytest.raises(mix_sources.SourceError, match="rate-limiting"):
        asyncio.run(mix_sources.search_youtube("zouk mix"))
    assert "--flat-playlist" in seen["cmd"] and seen["cmd"][-1] == "ytsearch8:zouk mix"
    assert player.youtube_rate_limited()
    monkeypatch.setattr(player, "_yt_blocked_until", 0.0)


@pytest.mark.parametrize("source,uid,ok", [
    ("youtube", "UCtok6JZpJBYWYen10os9E2g", True),
    ("youtube", "@djjefffresh", False),
    ("soundcloud", "djtokinou", True),
    ("soundcloud", "4199618/../x", False),
    ("soundcloud", "discover", False),
    ("mixcloud", "martin-šmoldas", True),
    ("mixcloud", "a/b", False),
    ("hearthis", "dj-claimaxdee-4a", True),
    ("hearthis", "../etc", False),
    ("audiomack", "x", False),
])
def test_only_listable_dj_ids_are_accepted(source, uid, ok):
    assert mix_sources.valid_user_id(source, uid) is ok


# ── links ──

@pytest.mark.parametrize("url,expected", [
    ("https://hearthis.at/djshinski/dj-shinski-zouk-overdose-mix/",
     ("hearthis", "https://hearthis.at/djshinski/dj-shinski-zouk-overdose-mix/")),
    ("https://www.hearthis.at/debrilhooparvo/tarraxo-vol.3-prod.-x/?s=1",
     ("hearthis", "https://hearthis.at/debrilhooparvo/tarraxo-vol.3-prod.-x/")),
    ("https://www.youtube.com/watch?v=9SthwiM5Wb8&t=30s", ("youtube", "https://www.youtube.com/watch?v=9SthwiM5Wb8")),
    ("https://m.youtube.com/watch?feature=x&v=9SthwiM5Wb8", ("youtube", "https://www.youtube.com/watch?v=9SthwiM5Wb8")),
    ("https://music.youtube.com/watch?v=9SthwiM5Wb8", ("youtube", "https://www.youtube.com/watch?v=9SthwiM5Wb8")),
    ("https://youtu.be/9SthwiM5Wb8?si=abc", ("youtube", "https://www.youtube.com/watch?v=9SthwiM5Wb8")),
])
def test_hearthis_and_youtube_links_are_recognised(url, expected):
    assert mixes.parse_mix_url(url) == expected


@pytest.mark.parametrize("url", [
    "https://hearthis.at/djshinski/",
    "https://hearthis.at/djshinski/likes/",
    "https://hearthis.at/search/zouk/",
    "https://hearthis.at/a/b/c/",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/@djjefffresh/videos",
    "https://youtu.be/",
    "https://youtube.com.evil.example/watch?v=9SthwiM5Wb8",
])
def test_other_hearthis_and_youtube_pages_are_not_mixes(url):
    assert mixes.parse_mix_url(url) is None


# ── downloading goes through the one mix path ──

def _client(user, monkeypatch, captured):
    app = FastAPI()
    app.include_router(downloads.router)
    app.dependency_overrides[auth.get_current_user] = lambda: user

    async def _no_bind():
        return user
    app.dependency_overrides[bind_navidrome_creds] = _no_bind

    async def _capture(job):
        captured.append(job)

    monkeypatch.setattr(downloader, "run_download", _capture)
    return TestClient(app)


USER = {"username": "claude_test", "allowed_formats": ["mp3", "flac"], "allowed_methods": ["yt-dlp"]}


def test_a_youtube_url_in_a_plain_track_job_stays_a_track(monkeypatch):
    """The YouTube Music provider sends watch URLs as the `url` of ordinary tracks."""
    client = _client(USER, monkeypatch, [])
    r = client.post("/api/download", json={"url": "https://music.youtube.com/watch?v=9SthwiM5Wb8",
                                           "title": "Artist - Song", "type": "track",
                                           "method": "yt-dlp", "format": "mp3"})
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "track" and body["format"] == "mp3"


def test_a_youtube_url_is_a_mix_when_the_client_says_so(monkeypatch):
    client = _client(USER, monkeypatch, [])
    r = client.post("/api/download", json={"url": "https://youtu.be/9SthwiM5Wb8", "type": "mix",
                                           "format": "flac"})
    assert r.status_code == 200
    body = r.json()
    assert (body["type"], body["format"], body["method"]) == ("mix", "original", "yt-dlp")
    assert body["url"] == "https://youtu.be/9SthwiM5Wb8"


def test_a_hearthis_link_is_a_mix_whatever_the_client_said(monkeypatch):
    client = _client(USER, monkeypatch, [])
    r = client.post("/api/download", json={"url": "https://hearthis.at/djshinski/dj-shinski-zouk-overdose-mix/",
                                           "type": "track", "format": "flac"})
    assert r.status_code == 200 and r.json()["type"] == "mix" and r.json()["format"] == "original"


def test_hearthis_info_comes_from_its_api(monkeypatch):
    async def fake_get(url, params=None, timeout=25):
        assert url == "https://api-v2.hearthis.at/djshinski/dj-shinski-zouk-overdose-mix/"
        return HT_SEARCH[0]

    monkeypatch.setattr(mix_sources, "get_json", fake_get)
    info = asyncio.run(mixes.fetch_info("https://hearthis.at/djshinski/dj-shinski-zouk-overdose-mix/"))
    # yt-dlp would have said "DJ Shinski - Zouk Overdose Mix" with no uploader.
    assert info["title"] == "Zouk Overdose Mix" and info["uploader"] == "DJ Shinski"
    assert info["quality_label"] == "MP3 192" and info["source_label"] == "hearthis.at"


def test_mixcloud_info_takes_quality_from_mixcloud_itself(monkeypatch):
    async def fake_run(cmd, timeout):
        return 0, '{"title": "Set", "uploader": "DJ", "duration": 3600, "formats": [' \
                  '{"format_id": "http", "acodec": "mp4a.40.5", "vcodec": "none"}]}', ""

    async def fake_aq(url):
        return "SQ"

    monkeypatch.setattr(mixes, "_run_capture", fake_run)
    monkeypatch.setattr(mix_sources, "mixcloud_audio_quality", fake_aq)
    info = asyncio.run(mixes.fetch_info("https://www.mixcloud.com/dj/set/"))
    assert (info["kbps"], info["quality_label"], info["quality_known"]) == (64, "AAC 64", True)


def test_youtube_mix_info_is_refused_while_rate_limited(monkeypatch):
    async def tripwire(cmd, timeout):
        raise AssertionError("must not ask YouTube")

    monkeypatch.setattr(mixes, "_run_capture", tripwire)
    monkeypatch.setattr(player, "_yt_blocked_until", player.time.monotonic() + 100)
    with pytest.raises(ValueError, match="rate-limiting"):
        asyncio.run(mixes.fetch_info("https://youtu.be/9SthwiM5Wb8"))
    monkeypatch.setattr(player, "_yt_blocked_until", 0.0)


# ── review fixes ──

def test_malformed_upstream_rows_are_skipped_not_a_500():
    rows = [
        {"title": "x", "duration": "inf", "release_timestamp": 1e300, "downloadable": "1",
         "permalink_url": "https://hearthis.at/djshinski/x/", "user": "djshinski"},   # user as a string
        {"title": "y", "permalink_url": None, "user": None},
        "not a dict",
        {"title": "z", "duration": 1e400, "permalink_url": "https://hearthis.at/a/b/", "user": {"permalink": ".."}},
    ]
    items = mix_sources.parse_hearthis_list(rows)
    assert [i["duration"] for i in items] == [0, 0]
    assert items[0]["uploader_id"] == "djshinski" and items[0]["date"] == ""
    assert items[1]["uploader_id"] == "a"          # ".." is never a DJ id
    assert mix_sources.parse_mixcloud_search({"viewer": {"search": {"searchQuery": {"cloudcasts": {"edges": [
        {"node": {"slug": "s", "owner": "not a dict"}}, "junk", {"node": None}]}}}}}) == []
    assert mix_sources.parse_soundcloud_playlist({"entries": [{"webpage_url": 5, "formats": "x"}]}) == []
    assert mix_sources.parse_youtube_channel([]) == []


def test_malformed_hearthis_info_is_a_400(monkeypatch):
    async def weird(url, params=None, timeout=25):
        return {"permalink_url": {"no": "string"}, "user": 7, "duration": "∞"}

    monkeypatch.setattr(mix_sources, "get_json", weird)
    client = _client(USER, monkeypatch, [])
    r = client.post("/api/mix/info", json={"url": "https://hearthis.at/djshinski/dj-shinski-zouk-overdose-mix/"})
    assert r.status_code == 400


@pytest.mark.parametrize("url", ["https://hearthis.at/../x/", "https://hearthis.at/dj/../",
                                 "https://hearthis.at/.../mix/"])
def test_hearthis_names_of_dots_alone_are_refused(url):
    assert mixes.parse_mix_url(url) is None


def test_hearthis_dot_user_ids_are_refused():
    assert mix_sources.valid_user_id("hearthis", "..") is False
    assert mix_sources.valid_user_id("hearthis", "dj.name") is True


def test_a_soundcloud_go_preview_is_not_a_result():
    """Measured: 9 of 10 SoundCloud results for a pop query were 30 s previews
    whose only formats end in `_preview`."""
    entry = {"title": "Song", "uploader": "X", "webpage_url": "https://soundcloud.com/x/song", "duration": 30,
             "formats": [{"format_id": "hls_mp3_1_0_preview", "acodec": "mp3", "vcodec": "none", "abr": 128},
                         {"format_id": "http_mp3_1_0_preview", "acodec": "mp3", "vcodec": "none", "abr": 128}]}
    assert mix_sources.parse_soundcloud_entry(entry) is None


@pytest.mark.parametrize("name,label,kbps", [
    ("Set.wav", "WAV lossless", 1411),
    ("Set.aiff", "AIFF lossless", 1411),
    ("Set.m4a", "AAC 256", 256),
    ("Set (hearthis.at).mp3", "MP3 192", 192),
    ("", "MP3 192", 192),
])
def test_hearthis_quality_follows_the_original_file(name, label, kbps):
    q = mixes.hearthis_quality("1", name)
    assert (q["quality_label"], q["kbps"], q["quality_known"]) == (label, kbps, False)


def test_a_lossless_hearthis_original_is_a_mix_file():
    assert {"wav", "aif", "aiff", "flac"} <= set(mixes.AUDIO_EXTS)
    q = mixes.quality_from_formats([{"format_id": "mp3", "acodec": "mp3", "vcodec": "none", "ext": "mp3"},
                                    {"format_id": "wav", "acodec": "wav", "vcodec": "none", "ext": "wav"}])
    assert q["quality_label"] == "WAV lossless" and q["kbps"] == 1411
    assert mixes.parse_probe({"streams": [{"codec_name": "pcm_s16le", "bit_rate": "1411200"}]})["codec"] == "PCM"


def test_a_folded_copy_carries_what_a_row_needs():
    mc = _it("mixcloud", "Zouk set brno", 3721, 64)
    sc = _it("soundcloud", "zouk set brno", 3700, 160)
    out = mix_sources.dedupe([mc, sc])
    also = out[0]["also"][0]
    for k in ("title", "thumbnail", "duration", "uploader", "uploader_id", "url", "codec", "kbps",
              "quality_known", "quality_label", "source", "source_label"):
        assert k in also
    assert "also" not in also


def test_yt_dlp_runs_at_most_two_per_pool(monkeypatch):
    live = {"now": 0, "max": 0}

    async def fake(cmd, timeout):
        live["now"] += 1
        live["max"] = max(live["max"], live["now"])
        await asyncio.sleep(0.02)
        live["now"] -= 1
        return 0, '{"entries": []}', ""

    monkeypatch.setattr(mixes, "_run_capture", fake)
    monkeypatch.setattr(player, "_yt_blocked_until", 0.0)

    async def searches():
        monkeypatch.setattr(mix_sources, "_search_slots", asyncio.Semaphore(2))
        await asyncio.gather(*[mix_sources.search_soundcloud(f"q{i}") for i in range(3)],
                             *[mix_sources.search_youtube(f"y{i}") for i in range(2)])

    async def uploads():
        monkeypatch.setattr(mix_sources, "_uploads_slots", asyncio.Semaphore(2))
        await asyncio.gather(*[mix_sources.uploads("soundcloud", f"dj{i}", 5) for i in range(3)],
                             mix_sources.uploads("youtube", "UCtok6JZpJBYWYen10os9E2g", 5))

    asyncio.run(searches())
    assert live["max"] == 2
    live["max"] = 0
    asyncio.run(uploads())
    assert live["max"] == 2


def test_a_search_is_not_starved_by_a_running_follow_check(monkeypatch):
    """A follow check with SoundCloud DJs (~50 s each) held both slots of the one
    shared pool, and every search behind it reported "timed out"."""
    async def fake(cmd, timeout):
        if any("/tracks" in c for c in cmd):
            await release.wait()          # an upload listing that takes its time
        return 0, '{"entries": []}', ""

    monkeypatch.setattr(mixes, "_run_capture", fake)

    async def go():
        global release
        release = asyncio.Event()
        monkeypatch.setattr(mix_sources, "_search_slots", asyncio.Semaphore(2))
        monkeypatch.setattr(mix_sources, "_uploads_slots", asyncio.Semaphore(2))
        held = [asyncio.create_task(mix_sources.uploads("soundcloud", f"dj{i}", 5)) for i in range(2)]
        await asyncio.sleep(0.01)
        try:
            # Both upload slots are taken; the search still answers at once.
            assert await asyncio.wait_for(mix_sources.search_soundcloud("zouk"), 1) == []
        finally:
            release.set()
            await asyncio.gather(*held)

    asyncio.run(go())


def test_one_malformed_row_does_not_lose_the_rest():
    def parse(row):
        if row.get("bad"):
            raise TypeError("upstream sent nonsense")
        return {"ok": row["n"]}

    assert mix_sources._parse_all(parse, [{"n": 1}, {"bad": 1}, {"n": 2}, "junk"]) == [{"ok": 1}, {"ok": 2}]


def test_searches_are_throttled_per_user(monkeypatch):
    from app.routers import mixes as mixes_router

    async def fake_search(q, sources):
        return {"results": []}

    monkeypatch.setattr(mix_sources, "search", fake_search)
    mixes_router._searches.clear()
    app = FastAPI()
    app.include_router(mixes_router.router)
    app.dependency_overrides[auth.get_current_user] = lambda: USER

    async def _no_bind():
        return USER
    app.dependency_overrides[bind_navidrome_creds] = _no_bind
    client = TestClient(app)
    codes = [client.get("/api/mixes/search?q=zouk").status_code for _ in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429
    assert "Too many" in client.get("/api/mixes/search?q=zouk").json()["detail"]
    mixes_router._searches.clear()


def test_any_hearthis_parse_error_is_a_400_not_a_500(monkeypatch):
    async def ok(url, params=None, timeout=25):
        return HT_SEARCH[0]

    def explode(d):
        raise OverflowError("cannot convert float infinity to integer")

    monkeypatch.setattr(mix_sources, "get_json", ok)
    monkeypatch.setattr(mix_sources, "parse_hearthis_track", explode)
    client = _client(USER, monkeypatch, [])
    r = client.post("/api/mix/info", json={"url": "https://hearthis.at/djshinski/dj-shinski-zouk-overdose-mix/"})
    assert r.status_code == 400
