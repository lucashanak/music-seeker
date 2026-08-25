#!/usr/bin/env python3
"""Offline recommendation-quality harness, measured against real curated playlists.

The problem this solves: "the recommendations feel better" is unfalsifiable, so
scoring changes to radio.py used to ship on judgement alone. Here the user's own
curated Navidrome playlists are the ground truth. For each playlist we hand the
engine a few of its tracks as seeds and measure how many of the HELD-OUT members
it recovers. A curated playlist is a set of tracks its owner considers to belong
together, which is exactly what a recommender is asked to predict.

Variants:
    old          the shipped engine — artist-level tags, integer set overlap
    tagvec       + per-track tag vectors, IDF-weighted cosine (RECO_TAG_VECTORS)
    cooc         + public-playlist co-occurrence recall arm (RECO_COOCCUR)
    cooc+tagvec  both

The pair matters because the two changes act on different halves of the problem.
The first measured run showed the whole candidate pool is ~80 tracks with ~3% of
the held-out members in it, so `tagvec` — which only re-ranks — could not help
and indeed regressed. `cooc` attacks the pool itself; `cooc+tagvec` then asks
whether better ranking earns its place once there is enough to rank.

Reported per variant: recall@20/@50 against held-out members, off-genre hits
(a contrast playlist's tracks appearing in a zouk playlist's output and vice
versa), and Last.fm call volume.

NOTE on latency: the frozen pool memoizes network calls, so the reported seconds
measure only the first variant honestly and are meaningless for the rest. Compare
Last.fm call volume instead — that is unaffected by memoization because the
counter wraps the call, not the socket. Measure real latency with the freeze off.

Run:
    cd /home/lucas/music-seeker
    LASTFM_API_KEY=... python3 test_reco_eval.py [SEEDS_PER_PLAYLIST]

Writes a per-track CSV to the scratchpad. Never mutates production data: DATA_DIR
is redirected to a temp dir, so the tag cache it builds is throwaway.
"""

import asyncio
import csv
import os
import sys
import tempfile
import time

# ── Environment must be set BEFORE importing the app: services read these at
# import time (DATA_DIR into module-level paths, Navidrome creds into globals).
_EVAL_DATA_DIR = os.environ.get("EVAL_DATA_DIR") or tempfile.mkdtemp(prefix="reco_eval_")
os.environ["DATA_DIR"] = _EVAL_DATA_DIR
os.environ.setdefault("NAVIDROME_URL", "http://192.168.1.22:4533")
os.environ.setdefault("NAVIDROME_USER", "lucas")
# Secrets come from the environment — this file is committed, so it must not
# carry them. Export them before running, e.g. from the deployment compose file.
for _required in ("NAVIDROME_PASSWORD", "LASTFM_API_KEY"):
    if not os.environ.get(_required):
        sys.exit(f"{_required} is not set — export it before running this harness.")

from app.services import cooccur, lastfm, library, radio, tagvec  # noqa: E402
from app.services import search_providers  # noqa: E402
from app.services import settings as app_settings  # noqa: E402


# ── Frozen candidate pool ────────────────────────────────────────────
# Deezer's artist-radio endpoint is randomized BY DESIGN and its search results
# drift between calls, so two identical requests see different candidates. In
# production that is variety; in a scoring comparison it is fatal. Without this,
# the measured delta between two variants mixes the code change with pool churn,
# and the noise is larger than the effect: an unfrozen run scored the baseline at
# recall@20 0.160 and the best variant at 0.100, while the same comparison on a
# frozen pool put the baseline at 8 hits and the variant at 13.
#
# Memoizing the network leaves (not the arms) keeps every arm's contribution in
# play — including the co-occurrence arm — while making all variants score the
# same underlying API responses.
_net_memo: dict = {}


def _freeze_network():
    def wrap(mod, name):
        orig = getattr(mod, name)

        async def wrapper(*a, **kw):
            key = (name, repr(a), repr(sorted(kw.items())))
            if key not in _net_memo:
                try:
                    _net_memo[key] = ("ok", await orig(*a, **kw))
                except Exception as e:  # cache failures too — they are part of the draw
                    _net_memo[key] = ("err", e)
            kind, val = _net_memo[key]
            if kind == "err":
                raise val
            return val

        setattr(mod, name, wrapper)

    for name in ("deezer_search", "deezer_artist_radio", "deezer_get_playlist_tracks",
                 "resolve", "search"):
        wrap(search_providers, name)
    wrap(library, "get_similar_songs")
    # lastfm._get already memoizes successes in-process, so it needs no wrapper.

# ── Ground truth ─────────────────────────────────────────────────────
# "MyZouk (copy)" is deliberately excluded: it is a near-duplicate of MyZouk, so
# including both would let a hit in one count as evidence for the other.
EVAL_PLAYLISTS = [
    ("MyZouk",                 "ZhyyLEkE3pTeAvJ9NX7VPX", "zouk"),
    ("Calm Brazilian Zouk",    "ysEFjfVZppnFd3bvXRqvCY", "zouk"),
    ("Organic Downtempo",      "pA1gjTAn7G77zRVs35nlKp", "zouk"),
    ("Cinematic Violin",       "nmGNqPjPb4Hs9zKJElW7mk", "contrast"),
    ("Richard Vojik tanecni",  "TYXP7iN6uvk9uKpQt4pZVI", "mixed"),
]

SEEDS_PER_PLAYLIST = int(sys.argv[1]) if len(sys.argv) > 1 else 5
RECALL_LIMIT = 50
# Independent seed draws per playlist, averaged. One draw leaves a single hit
# swinging recall@20 by 0.010 — the same size as the effects being measured, so a
# decision on one draw is a coin flip. The engine's `variation` argument re-draws
# seeds from the SAME frozen pool, cutting variance with no extra API traffic.
VARIATIONS = int(os.environ.get("EVAL_VARIATIONS", "3"))
CSV_PATH = os.path.join(
    os.environ.get("SCRATCHPAD", "/tmp"), "reco_eval.csv")

# ── Gates ────────────────────────────────────────────────────────────
# The new scoring must not lose recall on any playlist, and must not start
# pulling in the contrast genre.
GATE_NO_RECALL_REGRESSION = True
GATE_MAX_OFFGENRE_INCREASE = 0
# Recall is a mean of ratios, so an unchanged metric lands on -1e-17 as often as
# on +0.0. Without a tolerance the gate fails runs where nothing moved at all.
GATE_RECALL_EPSILON = 1e-9


def _key(t: dict) -> tuple[str, str]:
    return radio._norm_key(t)


def _pick_seeds(tracks: list[dict], k: int) -> list[dict]:
    """Evenly spaced picks, not the first k.

    Playlists are often ordered (added-together tracks sit next to each other),
    so the first k would sample one corner of the playlist and overstate recall
    for whatever the engine finds near it.
    """
    if len(tracks) <= k:
        return list(tracks)
    step = len(tracks) / k
    return [tracks[int(i * step)] for i in range(k)]


class CallCounter:
    """Counts Last.fm API calls by wrapping lastfm._get.

    Counts calls into the module, not HTTP requests: lastfm keeps an in-process
    cache, so repeats within a run are already free. What matters here is
    whether a variant asks for fundamentally more.
    """

    def __init__(self):
        self.n = 0
        self._orig = None

    def __enter__(self):
        self._orig = lastfm._get

        async def counting(method, params=None):
            self.n += 1
            return await self._orig(method, params)

        lastfm._get = counting
        return self

    def __exit__(self, *exc):
        lastfm._get = self._orig
        return False


async def _no_taste(_user):
    """Stub for radio._build_taste_profile.

    The durable taste profile blends in the account's global starred/top tracks,
    which is the right behaviour in the app but noise here: it pulls every
    playlist's recommendations toward the same global centroid and so compresses
    the differences between playlists that this harness is trying to measure.
    """
    return None


def _reset_engine_caches():
    """Clear per-run engine state.

    The profile cache is keyed by playlist hash only — NOT by variant — so
    without this the profile built under `old` (which has no tag_vector) would
    be reused by `new`, silently disabling the very thing under test.
    """
    radio._profile_cache.clear()
    radio._profile_locks.clear()
    radio._taste_cache.clear()
    radio._taste_locks.clear()


async def run_variant(name: str, playlists: list[dict], enabled: bool,
                      budget: int, cooccur_on: bool = False) -> dict:
    radio.TAGVEC_ENABLED = enabled
    radio.COOCCUR_ENABLED = cooccur_on
    orig_budget = radio.TAGVEC_CANDIDATE_BUDGET
    radio.TAGVEC_CANDIDATE_BUDGET = budget
    orig_taste = radio._build_taste_profile
    radio._build_taste_profile = _no_taste

    rows = []
    try:
        for pl in playlists:
            _reset_engine_caches()
            # The scene anchor a real deployment would pass for a playlist: its
            # own name, via the `anchors` argument. Deliberately NOT hand-curated
            # per playlist — "Richard Vojik tanecni" yields no usable anchor, and
            # that is a result worth seeing rather than papering over.
            app_settings._settings["discovery_genres"] = ""
            seeds = pl["seeds"]
            held_out = {_key(t) for t in pl["tracks"]} - {_key(t) for t in seeds}

            draws = []
            with CallCounter() as counter:
                t0 = time.time()
                for v in range(VARIATIONS):
                    draws.append(await radio.get_playlist_recommendations(
                        seeds, source="combined", limit=RECALL_LIMIT,
                        exclude=seeds, user=None, anchors=[pl["name"]],
                        variation=v,
                    ))
                elapsed = (time.time() - t0) / VARIATIONS

            # Wait out the background warm tasks so their traffic is attributed
            # to this run rather than leaking into the next variant — and so the
            # co-occurrence cache is actually populated before the next pass
            # measures it (the request path itself is cache-only by design).
            for task in list(radio._warm_tasks) + list(cooccur._warm_tasks):
                try:
                    await task
                except Exception:
                    pass

            denom20 = min(20, len(held_out)) or 1
            denom50 = min(RECALL_LIMIT, len(held_out)) or 1
            hits20 = sum(sum(1 for k in map(_key, r[:20]) if k in held_out)
                         for r in draws) / VARIATIONS
            hits50 = sum(sum(1 for k in map(_key, r[:50]) if k in held_out)
                         for r in draws) / VARIATIONS
            recs = draws[0]
            out_keys = [_key(t) for r in draws for t in r]

            offgenre = 0
            for k in out_keys:
                for other in playlists:
                    if other["group"] == pl["group"] or other["name"] == pl["name"]:
                        continue
                    if {"zouk", "contrast"} != {pl["group"], other["group"]}:
                        continue
                    if k in other["keys"]:
                        offgenre += 1
                        break

            offgenre = offgenre / VARIATIONS
            rows.append({
                "variant": name, "playlist": pl["name"], "group": pl["group"],
                "held_out": len(held_out), "returned": len(recs),
                "hits20": hits20, "hits50": hits50,
                "recall20": hits20 / denom20, "recall50": hits50 / denom50,
                "offgenre": offgenre, "seconds": round(elapsed, 2),
                "lastfm_calls": counter.n,
            })
            if name == "warmup":
                continue
            print(f"  {name:11s} {pl['name'][:26]:26s} "
                  f"r@20={hits20:4.1f}/{denom20} r@50={hits50:4.1f}/{denom50} "
                  f"off={offgenre:3.1f} {elapsed:5.1f}s lfm={counter.n}")
    finally:
        radio.TAGVEC_CANDIDATE_BUDGET = orig_budget
        radio._build_taste_profile = orig_taste

    return {"name": name, "rows": rows}


def _agg(rows: list[dict]) -> dict:
    n = len(rows) or 1
    return {
        "recall20": sum(r["recall20"] for r in rows) / n,
        "recall50": sum(r["recall50"] for r in rows) / n,
        "hits50": sum(r["hits50"] for r in rows),
        "offgenre": sum(r["offgenre"] for r in rows),
        "seconds": sum(r["seconds"] for r in rows) / n,
        "lastfm_calls": sum(r["lastfm_calls"] for r in rows) / n,
    }


async def main():
    print(f"DATA_DIR (throwaway): {_EVAL_DATA_DIR}")
    print(f"seeds/playlist: {SEEDS_PER_PLAYLIST}  recall limit: {RECALL_LIMIT}\n")

    playlists = []
    for name, pid, group in EVAL_PLAYLISTS:
        pl = await library.get_playlist(pid)
        if not pl or not pl.get("tracks"):
            print(f"  SKIP {name}: not reachable")
            continue
        tracks = pl["tracks"]
        playlists.append({
            "name": name, "group": group, "tracks": tracks,
            "keys": {_key(t) for t in tracks},
            "seeds": _pick_seeds(tracks, SEEDS_PER_PLAYLIST),
        })
        print(f"  loaded {name}: {len(tracks)} tracks")
    if not playlists:
        print("\nNo ground truth reachable — is Navidrome up at "
              f"{library.NAVIDROME_URL}?")
        return 1

    _freeze_network()

    # Warm the tag cache to a fixed point before measuring. Each request fetches
    # tags for its top candidates and warms the tail in the background, so run
    # N+1 legitimately scores on more data than run N — desirable in production,
    # but not a fixed point, and a comparison needs one.
    print("warming tag cache to convergence:")
    for i in range(3):
        before = tagvec.stats()["entries"]
        await run_variant("warmup", playlists, True, radio.TAGVEC_CANDIDATE_BUDGET, True)
        after = tagvec.stats()["entries"]
        print(f"  pass {i + 1}: tag entries {before} -> {after}")
        if after == before:
            break

    print()
    results = []
    for vname, tv, budget, co in [
        ("old",        False, radio.TAGVEC_CANDIDATE_BUDGET, False),
        ("tagvec",     True,  radio.TAGVEC_CANDIDATE_BUDGET, False),
        ("cooc",       False, radio.TAGVEC_CANDIDATE_BUDGET, True),
        ("cooc+tagvec", True, radio.TAGVEC_CANDIDATE_BUDGET, True),
    ]:
        print(f"variant {vname}:")
        results.append(await run_variant(vname, playlists, tv, budget, co))
        print()

    with open(CSV_PATH, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(results[0]["rows"][0].keys()))
        w.writeheader()
        for r in results:
            w.writerows(r["rows"])

    print("─" * 78)
    print(f"{'variant':10s} {'recall@20':>10s} {'recall@50':>10s} {'hits@50':>8s} "
          f"{'offgenre':>9s} {'avg s':>7s} {'avg lfm':>8s}")
    aggs = {}
    for r in results:
        a = _agg(r["rows"])
        aggs[r["name"]] = a
        print(f"{r['name']:10s} {a['recall20']:10.3f} {a['recall50']:10.3f} "
              f"{a['hits50']:8.1f} {a['offgenre']:9.1f} {a['seconds']:7.1f} "
              f"{a['lastfm_calls']:8.0f}")

    print(f"\ntag cache:     {tagvec.stats()}")
    print(f"cooccur cache: {cooccur.stats()}")
    print(f"CSV: {CSV_PATH}")

    # ── Gates ────────────────────────────────────────────────────────
    print("\n" + "─" * 78)
    failures = []
    # Gate on the best combined variant, not on `cooc` alone: the two changes are
    # complementary by construction (a bigger pool needs a better ranker), so
    # gating on the recall half in isolation would reject the pair for a
    # regression that the pair does not have.
    old, new = aggs["old"], aggs["cooc+tagvec"]
    for metric in ("recall20", "recall50"):
        delta = new[metric] - old[metric]
        verdict = "PASS" if delta >= -GATE_RECALL_EPSILON else "FAIL"
        if delta < -GATE_RECALL_EPSILON and GATE_NO_RECALL_REGRESSION:
            failures.append(f"{metric} regressed by {abs(delta):.3f}")
        print(f"[{verdict}] {metric}: old={old[metric]:.3f} new={new[metric]:.3f} "
              f"delta={delta:+.3f}")
    off_delta = new["offgenre"] - old["offgenre"]
    if off_delta > GATE_MAX_OFFGENRE_INCREASE:
        failures.append(f"off-genre hits rose by {off_delta:.1f}")
    print(f"[{'PASS' if off_delta <= GATE_MAX_OFFGENRE_INCREASE else 'FAIL'}] "
          f"off-genre: old={old['offgenre']:.1f} new={new['offgenre']:.1f} "
          f"delta={off_delta:+.1f}")

    # Per-playlist regressions matter even when the mean improves: one playlist
    # collapsing while another gains is not a win, it is a redistribution.
    by_pl = {}
    for r in results:
        for row in r["rows"]:
            by_pl.setdefault(row["playlist"], {})[r["name"]] = row["recall50"]
    print()
    print(f"  {'playlist':32s} {'old':>7s} {'tagvec':>7s} {'cooc':>7s} {'co+tv':>7s}")
    for pl, v in by_pl.items():
        # Follow the GATED variant, not `cooc` alone — flagging a regression the
        # shipped configuration does not have is worse than not flagging at all.
        d = v.get("cooc+tagvec", 0) - v.get("old", 0)
        flag = "  <-- regression" if d < 0 else ""
        print(f"  {pl[:32]:32s} {v.get('old', 0):7.3f} {v.get('tagvec', 0):7.3f} "
              f"{v.get('cooc', 0):7.3f} {v.get('cooc+tagvec', 0):7.3f}{flag}")

    print()
    if failures:
        print("RESULT: FAIL — " + "; ".join(failures))
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
