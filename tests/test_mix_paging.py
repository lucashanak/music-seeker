"""Paging of the mix search: every source by offset, a short page / failure / the depth cap
makes it dry, rows of a later page that are the same set as one already sent fold into it,
and a follow-up page has its own throttle. No network, no yt-dlp.
"""
import asyncio
import base64
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import bind_navidrome_creds
from app.routers import mixes as mixes_router
from app.services import auth, mix_sources, mixes

USER = {"username": "t", "is_admin": False, "can_download": True, "can_download_mixes": True}


def item(source, title, uploader="DJ X", kbps=128, url=None, dur=3600):
    return mix_sources.make_item(source, url or f"https://example.com/{source}/{title.replace(' ', '-')}",
                                 title, uploader, uploader.lower(), "", "", dur,
                                 mixes.nominal_quality("AAC", kbps, True), "")


@pytest.fixture(autouse=True)
def clean():
    mix_sources._cache.clear()
    mix_sources._states.clear()
    mixes_router._searches.clear()
    mixes_router._more.clear()
    yield
    mix_sources._cache.clear()
    mix_sources._states.clear()


def fake(monkeypatch, first, pages):
    """first: {source: [items]} for page 1; pages: {source: {page: items | Exception}}."""
    calls = []

    async def f1(source, q):
        calls.append((source, 1))
        return first[source]

    def mk(source):
        async def f(q):
            return await f1(source, q)
        return f

    def mkp(source):
        async def f(q, page):
            calls.append((source, page))
            r = pages.get(source, {}).get(page, [])
            if isinstance(r, Exception):
                raise r
            return r
        return f
    monkeypatch.setattr(mix_sources, "SEARCHERS", {s: mk(s) for s in mix_sources.SOURCES})
    monkeypatch.setattr(mix_sources, "PAGERS", {s: mkp(s) for s in mix_sources.SOURCES})
    return calls


# ── the offsets each source is asked for ──

def test_the_mixcloud_cursor_is_the_one_mixcloud_issues():
    # measured 2026-11-23: page 1 ended at 'YXJyYXljb25uZWN0aW9uOjE5', page 2 at '…OjM5'
    assert mix_sources.mixcloud_cursor(19) == "YXJyYXljb25uZWN0aW9uOjE5"
    assert mix_sources.mixcloud_cursor(39) == "YXJyYXljb25uZWN0aW9uOjM5"
    assert mix_sources.mixcloud_cursor(-1) is None
    assert base64.b64decode(mix_sources.mixcloud_cursor(19)) == b"arrayconnection:19"


def test_each_source_is_asked_by_its_own_offset(monkeypatch):
    seen = {}

    async def gql(query, variables=None, **kw):
        seen["mc"] = (query, variables)
        return {}

    async def get_json(url, params=None, timeout=25):
        seen["ht"] = params
        return []

    async def ytdlp(args, timeout=25, kind="search"):
        seen["sc"] = args
        return {"entries": []}, ""

    async def yt_flat(args, what, kind="search"):
        seen["yt"] = args
        return {"entries": []}
    monkeypatch.setattr(mix_sources, "mixcloud_graphql", gql)
    monkeypatch.setattr(mix_sources, "get_json", get_json)
    monkeypatch.setattr(mix_sources, "_ytdlp_json", ytdlp)
    monkeypatch.setattr(mix_sources, "_youtube_flat", yt_flat)

    async def go():
        for s in mix_sources.SOURCES:
            await mix_sources.page_soundcloud("q", 3) if s == "soundcloud" else None
        await mix_sources.page_youtube("q", 3)
        await mix_sources.page_mixcloud("q", 3)
        await mix_sources.page_hearthis("q", 3)
    asyncio.run(go())
    assert seen["mc"][1] == {"term": "q", "after": mix_sources.mixcloud_cursor(39)}
    assert "after: $after" in seen["mc"][0]
    assert seen["ht"]["page"] == 3 and seen["ht"]["count"] == 20
    assert seen["sc"][seen["sc"].index("--playlist-start") + 1] == "21"
    assert seen["sc"][seen["sc"].index("--playlist-end") + 1] == "30" and seen["sc"][-1] == "scsearch30:q"
    ys = mix_sources.PAGE_SIZE["youtube"]
    assert seen["yt"][seen["yt"].index("--playlist-start") + 1] == str(2 * ys + 1) and seen["yt"][-1] == f"ytsearch{3 * ys}:q"


# ── pages, dry sources, errors ──

def full(source, n, tag):
    return [item(source, f"{tag} {source} {i}", uploader=f"{tag}{source}{i}") for i in range(n)]


def test_a_source_is_asked_for_later_pages_until_a_short_page_runs_it_dry(monkeypatch):
    n = mix_sources.PAGE_SIZE
    calls = fake(monkeypatch,
                 {"soundcloud": full("soundcloud", n["soundcloud"], "a"), "youtube": [],
                  "mixcloud": full("mixcloud", n["mixcloud"], "a"), "hearthis": full("hearthis", n["hearthis"], "a")},
                 {"mixcloud": {2: full("mixcloud", 5, "b")},           # short: dry after page 2
                  "soundcloud": {2: full("soundcloud", n["soundcloud"], "b"), 3: full("soundcloud", n["soundcloud"], "c")},
                  "hearthis": {2: full("hearthis", n["hearthis"], "b")}})
    srcs = list(mix_sources.SOURCES)
    r1 = asyncio.run(mix_sources.search("zouk", srcs))
    assert r1["page"] == 1 and r1["more"] == {"soundcloud": True, "youtube": False, "mixcloud": True, "hearthis": True}
    assert r1["done"] is False
    calls.clear()
    r2 = asyncio.run(mix_sources.search_more("zouk", srcs, 2))
    assert sorted(c[0] for c in calls) == ["hearthis", "mixcloud", "soundcloud"]      # youtube was dry
    assert r2["more"]["mixcloud"] is False and r2["more"]["soundcloud"] is True
    calls.clear()
    r3 = asyncio.run(mix_sources.search_more("zouk", srcs, 3))
    assert sorted(c[0] for c in calls) == ["hearthis", "soundcloud"]                  # mixcloud and youtube are not asked again
    assert r3["counts"] == {"soundcloud": n["soundcloud"], "hearthis": 0}
    assert r3["more"] == {"soundcloud": True, "youtube": False, "mixcloud": False, "hearthis": False}


def test_a_failing_or_rate_limited_source_is_reported_once_and_not_asked_again(monkeypatch):
    n = mix_sources.PAGE_SIZE
    calls = fake(monkeypatch,
                 {s: full(s, n[s], "a") for s in mix_sources.SOURCES},
                 {"youtube": {2: mix_sources.SourceError(mix_sources.YT_RATE_LIMITED)},
                  "hearthis": {2: RuntimeError("boom")},
                  "mixcloud": {2: full("mixcloud", n["mixcloud"], "b"), 3: full("mixcloud", n["mixcloud"], "c")},
                  "soundcloud": {2: full("soundcloud", n["soundcloud"], "b"), 3: full("soundcloud", n["soundcloud"], "c")}})
    srcs = list(mix_sources.SOURCES)
    asyncio.run(mix_sources.search("zouk", srcs))
    calls.clear()
    r2 = asyncio.run(mix_sources.search_more("zouk", srcs, 2))
    assert r2["errors"] == {"youtube": "YouTube is rate-limiting us", "hearthis": "boom"}
    assert r2["more"]["youtube"] is False and r2["more"]["hearthis"] is False
    calls.clear()
    r3 = asyncio.run(mix_sources.search_more("zouk", srcs, 3))
    assert sorted(c[0] for c in calls) == ["mixcloud", "soundcloud"]
    assert r3["errors"] == {}


def test_the_depth_cap_ends_a_source_even_when_its_pages_are_full(monkeypatch):
    mix_sources.MAX_DEPTH  # noqa: B018
    monkeypatch.setattr(mix_sources, "MAX_DEPTH", {**mix_sources.MAX_DEPTH, "soundcloud": 20})
    n = mix_sources.PAGE_SIZE
    fake(monkeypatch, {s: (full(s, n[s], "a") if s == "soundcloud" else []) for s in mix_sources.SOURCES},
         {"soundcloud": {2: full("soundcloud", n["soundcloud"], "b")}})
    srcs = ["soundcloud"]
    r1 = asyncio.run(mix_sources.search("zouk", srcs))
    assert r1["more"]["soundcloud"] is True
    r2 = asyncio.run(mix_sources.search_more("zouk", srcs, 2))
    assert r2["more"]["soundcloud"] is False and r2["done"] is True


def test_when_every_source_is_dry_the_search_says_done(monkeypatch):
    fake(monkeypatch, {s: [] for s in mix_sources.SOURCES}, {})
    r = asyncio.run(mix_sources.search("zouk", list(mix_sources.SOURCES)))
    assert r["done"] is True and not any(r["more"].values())


# ── dedup across pages ──

def test_a_later_page_copy_of_a_set_already_shown_folds_into_it_not_a_new_row(monkeypatch):
    n = mix_sources.PAGE_SIZE
    a = item("soundcloud", "Zouktime Brno 2025 Sunday Set", "Martin", kbps=160, url="https://soundcloud.com/m/zouktime")
    b = item("mixcloud", "Zouktime Brno 2025 Sunday Set", "Martin", kbps=64, url="https://www.mixcloud.com/m/zouktime/")
    other = item("mixcloud", "Something else entirely", "Zed", kbps=192, url="https://www.mixcloud.com/z/else/")
    fake(monkeypatch, {"soundcloud": [a] + full("soundcloud", n["soundcloud"] - 1, "p"), "youtube": [],
          "mixcloud": full("mixcloud", n["mixcloud"], "m"), "hearthis": []},
         {"mixcloud": {2: [b, other]}, "soundcloud": {2: []}})
    srcs = ["soundcloud", "mixcloud"]
    r1 = asyncio.run(mix_sources.search("zouk", srcs))
    r2 = asyncio.run(mix_sources.search_more("zouk", srcs, 2))
    assert [x["title"] for x in r2["results"]] == ["Something else entirely"]
    assert len(r2["folds"]) == 1 and r2["folds"][0]["into"] == "https://soundcloud.com/m/zouktime"
    assert r2["folds"][0]["also"][0]["source"] == "mixcloud"
    assert r2["results"][0]["relevance"] >= len(r1["results"])             # continues the ranking


def test_two_uploads_on_one_site_are_never_folded_across_pages(monkeypatch):
    n = mix_sources.PAGE_SIZE
    a = item("mixcloud", "Same Title Set", "DJ A", url="https://www.mixcloud.com/a/one/")
    b = item("mixcloud", "Same Title Set", "DJ A", url="https://www.mixcloud.com/a/two/")
    fake(monkeypatch, {"soundcloud": [], "youtube": [], "mixcloud": [a] + full("mixcloud", n["mixcloud"] - 1, "p"), "hearthis": []},
         {"mixcloud": {2: [b]}})
    asyncio.run(mix_sources.search("zouk", ["mixcloud"]))
    r2 = asyncio.run(mix_sources.search_more("zouk", ["mixcloud"], 2))
    assert [x["url"] for x in r2["results"]] == ["https://www.mixcloud.com/a/two/"] and r2["folds"] == []


# ── state ──

def test_a_page_without_its_first_page_or_out_of_order_is_refused(monkeypatch):
    fake(monkeypatch, {s: [] for s in mix_sources.SOURCES}, {})
    with pytest.raises(mix_sources.SearchExpired):
        asyncio.run(mix_sources.search_more("never searched", ["mixcloud"], 2))
    asyncio.run(mix_sources.search("zouk", ["mixcloud"]))
    with pytest.raises(mix_sources.SearchExpired):
        asyncio.run(mix_sources.search_more("zouk", ["mixcloud"], 3))       # 2 was skipped
    with pytest.raises(mix_sources.SearchExpired):
        asyncio.run(mix_sources.search_more("zouk", ["mixcloud"], 99))


def test_an_old_search_expires(monkeypatch):
    fake(monkeypatch, {s: full(s, mix_sources.PAGE_SIZE[s], "a") for s in mix_sources.SOURCES}, {})
    asyncio.run(mix_sources.search("zouk", ["mixcloud"]))
    st = mix_sources._states[mix_sources._state_key("", "")]
    st.t = time.monotonic() - mix_sources.STATE_TTL - 5
    with pytest.raises(mix_sources.SearchExpired):
        asyncio.run(mix_sources.search_more("zouk", ["mixcloud"], 2))


# ── the router: its own budget, the first page's shape ──

def client(monkeypatch, search=None, more=None):
    async def s(q, sources, user="", sid=""):
        return {"results": [], "page": 1}

    async def m(q, sources, page, user="", sid=""):
        return {"results": [], "page": page}
    monkeypatch.setattr(mix_sources, "search", search or s)
    monkeypatch.setattr(mix_sources, "search_more", more or m)
    app = FastAPI()
    app.include_router(mixes_router.router)
    app.dependency_overrides[auth.get_current_user] = lambda: USER

    async def _no_bind():
        return USER
    app.dependency_overrides[bind_navidrome_creds] = _no_bind
    return TestClient(app)


def test_follow_up_pages_do_not_eat_the_new_search_budget_but_have_their_own(monkeypatch):
    c = client(monkeypatch)
    assert [c.get(f"/api/mixes/search?q=zouk&page={p}").status_code for p in (1, 2, 3, 4, 5, 6)] == [200] * 6
    # 10 new searches a minute are still there after the pages (1 used above)
    assert [c.get("/api/mixes/search?q=zouk").status_code for _ in range(9)] == [200] * 9
    assert c.get("/api/mixes/search?q=zouk").status_code == 429
    # …and the pages have a bound of their own
    mixes_router._more.clear()
    codes = [c.get("/api/mixes/search?q=zouk&page=2").status_code for _ in range(mixes_router.MORE_LIMIT + 1)]
    assert codes[:mixes_router.MORE_LIMIT] == [200] * mixes_router.MORE_LIMIT and codes[-1] == 429


def test_an_expired_search_is_a_409_and_a_wild_page_a_422(monkeypatch):
    async def more(q, sources, page, user="", sid=""):
        raise mix_sources.SearchExpired("This search has expired — search again")
    c = client(monkeypatch, more=more)
    r = c.get("/api/mixes/search?q=zouk&page=2")
    assert r.status_code == 409 and "expired" in r.json()["detail"]
    assert c.get("/api/mixes/search?q=zouk&page=0").status_code == 422
    assert c.get("/api/mixes/search?q=zouk&page=999").status_code == 422


# ── whose paging memory it is ──

def _two_pages(monkeypatch):
    n = mix_sources.PAGE_SIZE
    fake(monkeypatch, {s: full(s, n[s], "a") for s in mix_sources.SOURCES},
         {s: {2: full(s, n[s], "b"), 3: full(s, n[s], "c")} for s in mix_sources.SOURCES})


def test_two_tabs_with_the_same_query_do_not_reset_each_other(monkeypatch):
    _two_pages(monkeypatch)
    srcs = ["mixcloud"]
    asyncio.run(mix_sources.search("zouk", srcs, "u", "tabone1"))
    asyncio.run(mix_sources.search("zouk", srcs, "u", "tabtwo2"))           # the second tab, same query
    assert asyncio.run(mix_sources.search_more("zouk", srcs, 2, "u", "tabone1"))["page"] == 2
    assert asyncio.run(mix_sources.search_more("zouk", srcs, 2, "u", "tabtwo2"))["page"] == 2
    assert asyncio.run(mix_sources.search_more("zouk", srcs, 3, "u", "tabone1"))["page"] == 3


def test_two_users_with_the_same_query_do_not_reset_each_other(monkeypatch):
    _two_pages(monkeypatch)
    srcs = ["mixcloud"]
    asyncio.run(mix_sources.search("zouk", srcs, "alice", "sameid1"))
    asyncio.run(mix_sources.search("zouk", srcs, "bob", "sameid1"))
    assert asyncio.run(mix_sources.search_more("zouk", srcs, 2, "alice", "sameid1"))["page"] == 2
    assert asyncio.run(mix_sources.search_more("zouk", srcs, 2, "bob", "sameid1"))["page"] == 2


def test_a_page_asked_for_another_query_or_sources_is_refused(monkeypatch):
    _two_pages(monkeypatch)
    asyncio.run(mix_sources.search("zouk", ["mixcloud"], "u", "abcdef"))
    with pytest.raises(mix_sources.SearchExpired):
        asyncio.run(mix_sources.search_more("kizomba", ["mixcloud"], 2, "u", "abcdef"))
    with pytest.raises(mix_sources.SearchExpired):
        asyncio.run(mix_sources.search_more("zouk", ["hearthis"], 2, "u", "abcdef"))


def test_the_memory_is_bounded_per_user_and_overall_oldest_first(monkeypatch):
    _two_pages(monkeypatch)
    for i in range(mix_sources.STATE_PER_USER + 3):
        asyncio.run(mix_sources.search("zouk", ["mixcloud"], "u", f"sid{i:03d}x"))
    mine = [k for k in mix_sources._states if k[0] == "u"]
    assert len(mine) == mix_sources.STATE_PER_USER
    assert ("u", "sid000x") not in mix_sources._states and ("u", f"sid{mix_sources.STATE_PER_USER + 2:03d}x") in mix_sources._states
    with pytest.raises(mix_sources.SearchExpired):                    # the oldest search of that user is gone
        asyncio.run(mix_sources.search_more("zouk", ["mixcloud"], 2, "u", "sid000x"))
    monkeypatch.setattr(mix_sources, "STATE_MAX", 5)
    for i in range(12):
        asyncio.run(mix_sources.search("zouk", ["mixcloud"], f"user{i}", "abcdef"))
    assert len(mix_sources._states) <= 5
    assert ("user11", "abcdef") in mix_sources._states and ("user0", "abcdef") not in mix_sources._states


def test_the_router_passes_the_user_and_the_search_id(monkeypatch):
    seen = {}

    async def s(q, sources, user="", sid=""):
        seen["s"] = (user, sid)
        return {"results": [], "page": 1}

    async def m(q, sources, page, user="", sid=""):
        seen["m"] = (user, sid, page)
        return {"results": [], "page": page}
    monkeypatch.setattr(mix_sources, "search", s)
    monkeypatch.setattr(mix_sources, "search_more", m)
    app = FastAPI()
    app.include_router(mixes_router.router)
    app.dependency_overrides[auth.get_current_user] = lambda: USER

    async def _no_bind():
        return USER
    app.dependency_overrides[bind_navidrome_creds] = _no_bind
    c = TestClient(app)
    assert c.get("/api/mixes/search?q=zouk&sid=abc123xyz").status_code == 200
    assert c.get("/api/mixes/search?q=zouk&sid=abc123xyz&page=2").status_code == 200
    assert seen["s"] == ("t", "abc123xyz") and seen["m"] == ("t", "abc123xyz", 2)
