#!/usr/bin/env python3
"""Offline BPM evaluation harness — NEW (local algo_version 5) vs OLD (production API,
still algo_version 3) on the MyZouk playlist, WITHOUT triggering a production re-scan.

OLD reference  : production API GET /api/bpm/track (auth via /api/auth/login).
NEW            : run the NEW app.services.bpm.analyze_bpm LOCALLY on the same audio,
                 streamed from Navidrome (same source production used).

It prints gate metrics + a PASS/FAIL summary and writes a full CSV to a scratchpad.

Run:
    cd /home/lucas/music-seeker
    python3 test_bpm_eval.py [MAX_TRACKS]

MAX_TRACKS (optional positional) limits how many MyZouk tracks are evaluated (default: all).
"""

import asyncio
import csv
import hashlib
import os
import secrets
import sys
import tempfile
import time

import httpx

# ── Connections ──
NAVIDROME_URL = os.environ.get("NAVIDROME_URL", "http://192.168.1.22:4533")
NAVIDROME_USER = os.environ.get("NAVIDROME_USER", "lucas")
NAVIDROME_PASSWORD = os.environ.get("NAVIDROME_PASSWORD", "")

PROD_URL = os.environ.get("PROD_URL", "https://musicseeker.hanaktech.org")
PROD_USER = os.environ.get("MS_TEST_USER", "claude_test")
PROD_PASSWORD = os.environ.get("MS_TEST_PASS", "")

# Secrets come from the environment — this file is public. Fail loudly rather
# than half-running against an unauthenticated API.
for _name, _val in (("NAVIDROME_PASSWORD", NAVIDROME_PASSWORD),
                    ("MS_TEST_PASS", PROD_PASSWORD)):
    if not _val:
        sys.exit(f"{_name} is not set — export it before running this harness.")

PLAYLIST_NAME = "MyZouk"

# Concurrency — madmom is CPU-heavy; backend uses BPM_WORKERS=2, so mirror that.
NEW_CONCURRENCY = 2

# ── Gate targets ──
TARGET_HIGH_CONF_FRAC = 0.70   # NEW conf ≥0.85 should cover ≥70% of tracks
TARGET_FLOOR_FRAC = 0.15       # NEW conf == 0.30 bucket should be ≤15%
TARGET_ANCHOR_PRESERVE = 0.98  # of OLD-trusted (≥0.85) tracks, ≥98% keep BPM ±1
ZOUK_BAND = (58.0, 116.0)

CSV_OUT = os.path.join(tempfile.gettempdir(), "ms-bpm-eval", "bpm_eval.csv")


# ── Navidrome (Subsonic) ──

def _nav_params(**extra) -> dict:
    salt = secrets.token_hex(8)
    token = hashlib.md5((NAVIDROME_PASSWORD + salt).encode()).hexdigest()
    return {
        "v": "1.16.1", "c": "bpm-eval", "u": NAVIDROME_USER,
        "t": token, "s": salt, "f": "json", **extra,
    }


async def nav_get_playlists(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get("/rest/getPlaylists", params=_nav_params())
    resp.raise_for_status()
    items = resp.json().get("subsonic-response", {}).get("playlists", {}).get("playlist", [])
    return [items] if isinstance(items, dict) else items


async def nav_get_playlist(client: httpx.AsyncClient, playlist_id: str) -> list[dict]:
    resp = await client.get("/rest/getPlaylist", params=_nav_params(id=playlist_id))
    resp.raise_for_status()
    entries = resp.json().get("subsonic-response", {}).get("playlist", {}).get("entry", [])
    return [entries] if isinstance(entries, dict) else entries


async def nav_download(client: httpx.AsyncClient, song_id: str, dest: str):
    async with client.stream("GET", "/rest/stream", params=_nav_params(id=song_id)) as resp:
        resp.raise_for_status()
        with open(dest + ".tmp", "wb") as f:
            async for chunk in resp.aiter_bytes(8192):
                f.write(chunk)
    os.rename(dest + ".tmp", dest)


# ── Production API (OLD reference) ──

async def prod_login(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/auth/login",
                             json={"username": PROD_USER, "password": PROD_PASSWORD})
    resp.raise_for_status()
    return resp.json()["token"]


async def prod_old_bpm(client: httpx.AsyncClient, token: str, name: str, artist: str) -> dict | None:
    """Fetch OLD (algo_version 3) bpm+confidence from production. Returns None on failure.
    Uses force=false so it returns the cached/tagged production value (no re-scan)."""
    try:
        resp = await client.get(
            "/api/bpm/track",
            params={"name": name, "artist": artist},
            headers={"Authorization": f"Bearer {token}"},
            timeout=180,
        )
        if resp.status_code != 200:
            return None
        d = resp.json()
        return {"bpm": float(d.get("bpm")), "conf": float(d.get("confidence")),
                "algo": d.get("algo_version")}
    except Exception:
        return None


# ── NEW algo (local) ──

def run_new_local(file_path: str) -> dict:
    """Run the NEW analyze_bpm in-process. Returns bpm/conf + the new audio-analysis fields
    (key_confidence, downbeats, time_signature, lufs, loudness_range, beat_period) and the
    per-track wall time."""
    from app.services import bpm as bpm_mod
    t0 = time.time()
    r = bpm_mod.analyze_bpm(file_path)
    elapsed = time.time() - t0
    bpm = float(r["bpm"])
    return {
        "bpm": bpm, "conf": float(r["confidence"]),
        "algo": r.get("algo_version"),
        "key_conf": r.get("key_confidence"),
        "downbeats": r.get("downbeats") or [],
        "time_signature": r.get("time_signature"),
        "lufs": r.get("lufs"),
        "loudness_range": r.get("loudness_range"),
        "beat_period": (60.0 / bpm) if bpm > 0 else None,
        "sec": elapsed,
    }


# ── Metrics helpers ──

def octave_ratio(old_bpm: float, new_bpm: float) -> float:
    if not old_bpm or not new_bpm:
        return 1.0
    return new_bpm / old_bpm


def is_octave_off(ratio: float) -> bool:
    """True when NEW differs from OLD by ~2× or ~0.5× (octave error), not ~1×."""
    return (abs(ratio - 2.0) < 0.15) or (abs(ratio - 0.5) < 0.05)


def conf_bucket_label(c: float) -> str:
    return f"{c:.2f}"


async def main():
    max_tracks = int(sys.argv[1]) if len(sys.argv) > 1 else 0

    os.makedirs(os.path.dirname(CSV_OUT), exist_ok=True)
    cache_dir = os.path.join(tempfile.gettempdir(), "ms-bpm-eval", "audio")
    os.makedirs(cache_dir, exist_ok=True)

    # Confirm the LOCAL algo is the NEW version (5).
    from app.services import bpm as bpm_mod
    print(f"Local BPM_ALGO_VERSION = {bpm_mod.BPM_ALGO_VERSION} (expected 5 for NEW)")

    # 1) Pull MyZouk track list from Navidrome.
    async with httpx.AsyncClient(base_url=NAVIDROME_URL, timeout=180,
                                 follow_redirects=True) as nav:
        playlists = await nav_get_playlists(nav)
        pl = next((p for p in playlists
                   if p.get("name", "").strip().lower() == PLAYLIST_NAME.lower()), None)
        if not pl:
            pl = next((p for p in playlists if "zouk" in p.get("name", "").lower()), None)
        if not pl:
            print(f"Playlist '{PLAYLIST_NAME}' not found. Available:")
            for p in playlists:
                print(f"  - {p.get('name')} ({p.get('songCount')} tracks)")
            sys.exit(1)
        print(f"Playlist: {pl['name']} ({pl.get('songCount', '?')} tracks)")

        entries = await nav_get_playlist(nav, pl["id"])
        if max_tracks:
            entries = entries[:max_tracks]
        print(f"Evaluating {len(entries)} tracks\n")

        # 2) Fetch OLD (production) values + download audio (concurrent, modest).
        async with httpx.AsyncClient(base_url=PROD_URL, timeout=180,
                                     follow_redirects=True) as prod:
            token = await prod_login(prod)
            print("Logged into production API\n")

            rows = []
            sem = asyncio.Semaphore(NEW_CONCURRENCY)

            async def prepare(entry):
                song_id = entry.get("id", "")
                title = entry.get("title", "?")
                artist = entry.get("artist", "?")
                old = await prod_old_bpm(prod, token, title, artist)
                dest = os.path.join(cache_dir, f"{song_id}.flac")
                if not (os.path.exists(dest) and os.path.getsize(dest) > 0):
                    try:
                        await nav_download(nav, song_id, dest)
                    except Exception as e:
                        return {"artist": artist, "title": title, "error": f"download: {e}"}
                return {"artist": artist, "title": title, "old": old, "file": dest}

            prepared = await asyncio.gather(*[prepare(e) for e in entries])

            # 3) Run NEW locally (CPU-bound → thread pool of NEW_CONCURRENCY).
            loop = asyncio.get_event_loop()
            from concurrent.futures import ThreadPoolExecutor
            pool = ThreadPoolExecutor(max_workers=NEW_CONCURRENCY)

            async def evaluate(p):
                if p.get("error") or not p.get("file"):
                    return {**p, "new": None}
                async with sem:
                    try:
                        new = await loop.run_in_executor(pool, run_new_local, p["file"])
                    except Exception as e:
                        return {**p, "new": None, "error": f"new: {e}"}
                return {**p, "new": new}

            t0 = time.time()
            done = 0
            results = []
            tasks = [asyncio.ensure_future(evaluate(p)) for p in prepared]
            for fut in asyncio.as_completed(tasks):
                r = await fut
                done += 1
                tag = ""
                if r.get("new"):
                    tag = f"NEW {r['new']['bpm']:.0f}@{r['new']['conf']:.2f}"
                    if r.get("old"):
                        tag += f" | OLD {r['old']['bpm']:.0f}@{r['old']['conf']:.2f}"
                elif r.get("error"):
                    tag = f"ERR {r['error']}"
                print(f"[{done}/{len(tasks)}] {r['artist']} — {r['title']}  {tag}")
                results.append(r)
            pool.shutdown(wait=True)
            print(f"\nAnalysis wall time: {time.time()-t0:.0f}s\n")

    # 4) Build rows.
    for r in results:
        old = r.get("old")
        new = r.get("new")
        old_bpm = old["bpm"] if old else None
        old_conf = old["conf"] if old else None
        new_bpm = new["bpm"] if new else None
        new_conf = new["conf"] if new else None
        ratio = octave_ratio(old_bpm, new_bpm) if (old_bpm and new_bpm) else None
        bpm_changed = (old_bpm is not None and new_bpm is not None
                       and abs(new_bpm - old_bpm) > 1.0)
        oct_off = ratio is not None and is_octave_off(ratio)

        # New audio-analysis fields.
        new_key_conf = new["key_conf"] if new else None
        downbeats = new["downbeats"] if new else []
        downbeat_count = len(downbeats) if downbeats else 0
        beat_period = new["beat_period"] if new else None
        # Median downbeat spacing ÷ beat_period (≈ time signature; expect ~4, allow ~3).
        downbeat_spacing_ratio = None
        if downbeats and len(downbeats) > 1 and beat_period and beat_period > 0:
            import statistics
            spacings = [downbeats[i + 1] - downbeats[i] for i in range(len(downbeats) - 1)]
            spacings = [s for s in spacings if s > 0]
            if spacings:
                downbeat_spacing_ratio = round(statistics.median(spacings) / beat_period, 3)
        lufs = new["lufs"] if new else None
        loudness_range = new["loudness_range"] if new else None
        # Attenuate-only level match toward -14 LUFS target.
        implied_gain = None
        if lufs is not None:
            implied_gain = round(min(1.0, 10 ** ((-14 - lufs) / 20)), 4)
        per_track_sec = round(new["sec"], 2) if (new and new.get("sec") is not None) else None
        time_signature = new["time_signature"] if new else None

        rows.append({
            "artist": r["artist"], "title": r["title"],
            "old_bpm": old_bpm, "old_conf": old_conf,
            "new_bpm": new_bpm, "new_conf": new_conf,
            "bpm_changed": bpm_changed, "octave_off": oct_off,
            "ratio": round(ratio, 3) if ratio is not None else None,
            "new_key_conf": new_key_conf,
            "downbeat_count": downbeat_count,
            "downbeat_spacing_ratio": downbeat_spacing_ratio,
            "time_signature": time_signature,
            "lufs": lufs,
            "loudness_range": loudness_range,
            "implied_gain": implied_gain,
            "per_track_sec": per_track_sec,
            "error": r.get("error", ""),
        })

    # 5) Write CSV.
    with open(CSV_OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "artist", "title", "old_bpm", "old_conf", "new_bpm", "new_conf",
            "bpm_changed", "octave_off", "ratio",
            "new_key_conf", "downbeat_count", "downbeat_spacing_ratio", "time_signature",
            "lufs", "loudness_range", "implied_gain", "per_track_sec", "error"])
        w.writeheader()
        w.writerows(rows)

    # ── Reporting ──
    valid_new = [r for r in rows if r["new_conf"] is not None]
    valid_old = [r for r in rows if r["old_conf"] is not None]
    both = [r for r in rows if r["new_conf"] is not None and r["old_conf"] is not None]

    def hist(rows_, key):
        h = {}
        for r in rows_:
            b = conf_bucket_label(r[key])
            h[b] = h.get(b, 0) + 1
        return dict(sorted(h.items(), reverse=True))

    print("=" * 64)
    print("GATE 1 — CONFIDENCE DISTRIBUTION")
    print("=" * 64)
    print(f"OLD (n={len(valid_old)}): {hist(valid_old, 'old_conf')}")
    print(f"NEW (n={len(valid_new)}): {hist(valid_new, 'new_conf')}")
    if valid_new:
        high = sum(1 for r in valid_new if r["new_conf"] >= 0.85)
        floor = sum(1 for r in valid_new if r["new_conf"] <= 0.30)
        high_frac = high / len(valid_new)
        floor_frac = floor / len(valid_new)
        g1a = high_frac >= TARGET_HIGH_CONF_FRAC
        g1b = floor_frac <= TARGET_FLOOR_FRAC
        print(f"  NEW high-conf (≥0.85): {high}/{len(valid_new)} = {high_frac:.0%} "
              f"(target ≥{TARGET_HIGH_CONF_FRAC:.0%}) {'PASS' if g1a else 'FAIL'}")
        print(f"  NEW floor (0.30):      {floor}/{len(valid_new)} = {floor_frac:.0%} "
              f"(target ≤{TARGET_FLOOR_FRAC:.0%}) {'PASS' if g1b else 'FAIL'}")
    else:
        g1a = g1b = False
        print("  No NEW results — FAIL")

    print()
    print("=" * 64)
    print("GATE 2 — ANCHOR PRESERVATION (OLD conf ≥0.85 → NEW BPM within ±1)")
    print("=" * 64)
    trusted = [r for r in both if r["old_conf"] >= 0.85]
    if trusted:
        preserved = [r for r in trusted if abs(r["new_bpm"] - r["old_bpm"]) <= 1.0]
        flipped = [r for r in trusted if r not in preserved]
        frac = len(preserved) / len(trusted)
        g2 = frac >= TARGET_ANCHOR_PRESERVE
        print(f"  {len(preserved)}/{len(trusted)} trusted anchors preserved = {frac:.1%} "
              f"(target ≥{TARGET_ANCHOR_PRESERVE:.0%}) {'PASS' if g2 else 'FAIL'}")
        if flipped:
            print("  FLIPPED anchors (suspect — NEW changed an already-confident BPM):")
            for r in flipped:
                print(f"    {r['artist']} — {r['title']}: "
                      f"OLD {r['old_bpm']:.1f}@{r['old_conf']:.2f} → "
                      f"NEW {r['new_bpm']:.1f}@{r['new_conf']:.2f} (ratio {r['ratio']})")
    else:
        g2 = True
        print("  No OLD-trusted anchors in sample — gate N/A (treated as PASS)")

    print()
    print("=" * 64)
    print("GATE 3 — OCTAVE-CONSISTENCY (OLD low-conf → NEW high-conf, in zouk band)")
    print("=" * 64)
    old_low = [r for r in both if r["old_conf"] < 0.85]
    rescued = [r for r in old_low if r["new_conf"] >= 0.85]
    in_band = [r for r in rescued if ZOUK_BAND[0] <= r["new_bpm"] <= ZOUK_BAND[1]]
    print(f"  OLD low-conf tracks: {len(old_low)}")
    print(f"  → rescued to NEW high-conf: {len(rescued)}")
    print(f"  → of those, NEW BPM in zouk band [{ZOUK_BAND[0]:.0f},{ZOUK_BAND[1]:.0f}]: "
          f"{len(in_band)}/{len(rescued)}")
    out_band = [r for r in rescued if r not in in_band]
    if out_band:
        print("  Rescued but OUT of band (eyeball):")
        for r in out_band:
            print(f"    {r['artist']} — {r['title']}: NEW {r['new_bpm']:.1f}@{r['new_conf']:.2f}")

    print()
    print("=" * 64)
    print("GATE 4 — FALSE-HIGH-CONFIDENCE FLAGS (NEW ≥0.85 but octave-off vs OLD)")
    print("=" * 64)
    false_high = [r for r in both
                  if r["new_conf"] >= 0.85 and r["octave_off"]]
    if false_high:
        print(f"  {len(false_high)} DANGEROUS track(s) — high NEW confidence on an octave shift:")
        for r in false_high:
            print(f"    {r['artist']} — {r['title']}: "
                  f"OLD {r['old_bpm']:.1f}@{r['old_conf']:.2f} → "
                  f"NEW {r['new_bpm']:.1f}@{r['new_conf']:.2f} (ratio {r['ratio']})")
    else:
        print("  None — no high-confidence octave shifts.")
    g4 = len(false_high) == 0

    # ── GATE 5 — KEY CONFIDENCE (multi-window vote vs OLD flat 0.5) ──
    print()
    print("=" * 64)
    print("GATE 5 — KEY CONFIDENCE (multi-window modal vote; far less mass at 0.5)")
    print("=" * 64)
    kc = [r["new_key_conf"] for r in rows if r.get("new_key_conf") is not None]
    if kc:
        at_half = sum(1 for v in kc if abs(v - 0.5) < 1e-6)
        ge_07 = sum(1 for v in kc if v >= 0.7)
        frac_half = at_half / len(kc)
        frac_ge07 = ge_07 / len(kc)
        # Histogram in 0.1 buckets.
        khist = {}
        for v in kc:
            b = f"{min(0.9, (int(v * 10) / 10)):.1f}"
            khist[b] = khist.get(b, 0) + 1
        khist = dict(sorted(khist.items()))
        mean_kc = sum(kc) / len(kc)
        print(f"  histogram (0.1 buckets): {khist}")
        print(f"  mean key_confidence (≈ modal-agreement × strength): {mean_kc:.3f}")
        print(f"  exactly 0.5 (fallback): {at_half}/{len(kc)} = {frac_half:.0%}")
        g5 = frac_ge07 >= 0.40
        print(f"  key_conf ≥0.70: {ge_07}/{len(kc)} = {frac_ge07:.0%} "
              f"(target ≥40%) {'PASS' if g5 else 'FAIL'}")
    else:
        g5 = False
        print("  No key_confidence values — FAIL")

    # ── GATE 6 — DOWNBEATS (present + spacing ≈ time_sig × beat_period) ──
    print()
    print("=" * 64)
    print("GATE 6 — DOWNBEATS (present; median spacing ≈ 4× beat_period, allow 3×)")
    print("=" * 64)
    have_new = [r for r in rows if r["new_bpm"] is not None]
    if have_new:
        with_db = [r for r in have_new if r["downbeat_count"] > 0]
        # Plausible: spacing ratio within ±10% of 4 (or of 3).
        def _plausible(r):
            sr = r["downbeat_spacing_ratio"]
            if sr is None:
                return False
            return (abs(sr - 4.0) / 4.0 <= 0.10) or (abs(sr - 3.0) / 3.0 <= 0.10)
        plausible = [r for r in with_db if _plausible(r)]
        missing = [r for r in have_new if r["downbeat_count"] == 0]
        implausible = [r for r in with_db if not _plausible(r)]
        bad = missing + implausible
        bad_frac = len(bad) / len(have_new)
        # time_signature ∈ {3, 4, None}
        ts_ok = all((r["time_signature"] in (3, 4, None)) for r in have_new)
        g6 = (bad_frac <= 0.05) and ts_ok
        print(f"  tracks with downbeats: {len(with_db)}/{len(have_new)}")
        print(f"  plausible spacing (≈3× or 4× ±10%): {len(plausible)}/{len(with_db)}")
        print(f"  missing+implausible: {len(bad)}/{len(have_new)} = {bad_frac:.0%} "
              f"(target ≤5%) {'PASS' if bad_frac <= 0.05 else 'FAIL'}")
        print(f"  time_signature ∈ {{3,4,null}}: {'PASS' if ts_ok else 'FAIL'}")
        if bad:
            print("  Missing/implausible downbeats:")
            for r in bad[:20]:
                print(f"    {r['artist']} — {r['title']}: count={r['downbeat_count']} "
                      f"spacing_ratio={r['downbeat_spacing_ratio']} ts={r['time_signature']}")
    else:
        g6 = False
        print("  No NEW results — FAIL")

    # ── GATE 7 — LUFS sanity + safe (attenuate-only) level match ──
    print()
    print("=" * 64)
    print("GATE 7 — LUFS SANITY + SAFE LEVEL MATCH (no boost; target -14 LUFS)")
    print("=" * 64)
    lf = [r for r in rows if r["lufs"] is not None]
    if lf:
        in_typical = [r for r in lf if -20.0 <= r["lufs"] <= -8.0]
        flagged = [r for r in lf if not (-30.0 <= r["lufs"] <= -6.0)]
        gains = [r["implied_gain"] for r in lf if r["implied_gain"] is not None]
        no_boost = all(g <= 1.0 for g in gains) if gains else True
        typical_frac = len(in_typical) / len(lf)
        g7 = no_boost and (typical_frac >= 0.5)
        print(f"  LUFS values: {len(lf)}/{len(rows)}")
        print(f"  in typical -8..-20 LUFS: {len(in_typical)}/{len(lf)} = {typical_frac:.0%}")
        print(f"  implied attenuate-only gain ≤1.0 for ALL: {'PASS' if no_boost else 'FAIL'}")
        if flagged:
            print("  Outliers outside -6..-30 LUFS:")
            for r in flagged[:20]:
                print(f"    {r['artist']} — {r['title']}: lufs={r['lufs']} "
                      f"gain={r['implied_gain']}")
    else:
        g7 = False
        print("  No LUFS values — FAIL")

    # ── GATE 8 — COST (per-track wall time, projected re-scan budget) ──
    print()
    print("=" * 64)
    print("GATE 8 — COST (per-track p50/p95; 136-track re-scan @ concurrency 2 ≤ 45 min)")
    print("=" * 64)
    secs = sorted(r["per_track_sec"] for r in rows if r.get("per_track_sec") is not None)
    if secs:
        import statistics
        p50 = statistics.median(secs)
        p95 = secs[min(len(secs) - 1, int(round(0.95 * (len(secs) - 1))))]
        # Projected 136-track wall time at concurrency 2 (minutes).
        projected_min = (136 * p50 / 2) / 60.0
        g8 = (p50 <= 30.0) and (projected_min <= 45.0)
        print(f"  per-track p50: {p50:.1f}s   p95: {p95:.1f}s   "
              f"(measured at concurrency {NEW_CONCURRENCY})")
        print(f"  projected 136-track re-scan @ concurrency 2: {projected_min:.1f} min")
        print(f"  p50 ≤30s: {'PASS' if p50 <= 30.0 else 'FAIL'}   "
              f"projection ≤45min: {'PASS' if projected_min <= 45.0 else 'FAIL'}")
    else:
        g8 = False
        print("  No timing data — FAIL")

    errs = [r for r in rows if r["error"]]
    if errs:
        print(f"\n  {len(errs)} track(s) errored:")
        for r in errs:
            print(f"    {r['artist']} — {r['title']}: {r['error']}")

    print()
    print("=" * 64)
    overall = g1a and g1b and g2 and g4 and g5 and g6 and g7 and g8
    print(f"OVERALL: {'PASS' if overall else 'FAIL'}  "
          f"(G1 dist:{'P' if (g1a and g1b) else 'F'} "
          f"G2 anchor:{'P' if g2 else 'F'} "
          f"G4 false-high:{'P' if g4 else 'F'} "
          f"G5 key-conf:{'P' if g5 else 'F'} "
          f"G6 downbeats:{'P' if g6 else 'F'} "
          f"G7 lufs:{'P' if g7 else 'F'} "
          f"G8 cost:{'P' if g8 else 'F'})")
    print(f"Full CSV: {CSV_OUT}")
    print("=" * 64)


if __name__ == "__main__":
    asyncio.run(main())
