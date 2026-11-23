"""Mixcloud / SoundCloud mixes: the link is recognised, the exact file is fetched
in its own codec, and the job says what quality arrived.

Nothing here touches the network or runs yt-dlp: the download is replaced by a
stand-in that writes a file where yt-dlp would have, and metadata comes from a
captured yt-dlp info dict (the sample mix from the brief, measured 2026-11-17).
"""
import asyncio
import os
import shutil
import subprocess
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import bind_navidrome_creds
from app.routers import bpm as bpm_router
from app.routers import downloads
from app.services import auth, bpm, downloader, jobs, library, mixes

SAMPLE = ("https://www.mixcloud.com/martin-%C5%A1moldas/zouktime-marathon-brno-sunday-set/"
          "?utm_medium=share&utm_source=clipboard&utm_content=show&utm_term=VXNlcjo1NDYzMDM2NQ%3D%3D")
SAMPLE_CANON = "https://www.mixcloud.com/martin-%C5%A1moldas/zouktime-marathon-brno-sunday-set/"

# What yt-dlp -J answered for the sample (trimmed to the fields we read).
SAMPLE_INFO = {
    "id": "martin-šmoldas_zouktime-marathon-brno-sunday-set",
    "title": "Zouktime Marathon Brno Sunday set",
    "uploader": "Martin Šmoldas",
    "uploader_id": "martin-šmoldas",
    "thumbnail": "https://thumbnailer.mixcloud.com/unsafe/1024x1024/profile/4/9/3/5/ec02",
    "timestamp": 1745268807,
    "upload_date": "20250421",
    "duration": 3721,
    "_type": "video",
}


# ── recognising a link ──

@pytest.mark.parametrize("url,expected", [
    (SAMPLE, ("mixcloud", SAMPLE_CANON)),
    ("look at this https://m.mixcloud.com/dj/some-set/ !", ("mixcloud", "https://www.mixcloud.com/dj/some-set/")),
    ("https://www.mixcloud.com/martin-šmoldas/zouktime-marathon-brno-sunday-set/", ("mixcloud", SAMPLE_CANON)),
    ("https://soundcloud.com/djtokinou/dj-tokinou-zouk-mix-session-2025?si=abc&utm_source=x",
     ("soundcloud", "https://soundcloud.com/djtokinou/dj-tokinou-zouk-mix-session-2025")),
    ("https://soundcloud.com/dj/private-mix/s-AbC123?si=1",
     ("soundcloud", "https://soundcloud.com/dj/private-mix/s-AbC123")),
    ("https://on.soundcloud.com/Xy12Ab", ("soundcloud-short", "https://on.soundcloud.com/Xy12Ab")),
])
def test_mix_links_are_recognised_and_rebuilt(url, expected):
    assert mixes.parse_mix_url(url) == expected


@pytest.mark.parametrize("url", [
    "https://www.mixcloud.com/martin-%C5%A1moldas/",                 # a user page
    "https://www.mixcloud.com/martin-%C5%A1moldas/uploads/",         # a user's sub-page
    "https://www.mixcloud.com/discover/zouk/",                       # a site section
    "https://www.mixcloud.com/dj/set/extra/",                         # too deep
    "https://soundcloud.com/djtokinou",                               # a user page
    "https://soundcloud.com/djtokinou/sets/summer",                   # a playlist
    "https://soundcloud.com/djtokinou/tracks",                        # a user's sub-page
    "https://soundcloud.com/discover/sets/x",                         # a site section
    "https://evil.example/mixcloud.com/dj/set/",                      # another host
    "https://www.mixcloud.com.evil.example/dj/set/",                  # look-alike host
    "https://open.spotify.com/track/abc",
    "Martin Šmoldas zouk",
    "",
])
def test_non_mix_links_are_refused(url):
    assert mixes.parse_mix_url(url) is None


# ── the command ──

def test_download_command_keeps_the_codec_and_cannot_be_hijacked():
    cmd = mixes.build_download_cmd(SAMPLE_CANON, "/m/u/Mixes/X/T.%(ext)s", "/tmp/p")
    assert cmd[0] == "yt-dlp"
    assert "-x" in cmd
    # No --audio-format: -x with the default "best" codec re-encodes nothing.
    assert "--audio-format" not in cmd and "--audio-quality" not in cmd
    # Best AAC first (HQ Mixcloud mixes offer AAC 192k beside Opus ~195k, and
    # iOS Safari / DLNA renderers play only the AAC), Opus only without AAC.
    assert cmd[cmd.index("-f") + 1] == mixes.FORMAT_SELECTOR
    assert "[format_id!*=preview]" in mixes.FORMAT_SELECTOR      # never the 30 s Go+ preview
    # The URL comes last, after "--", so it can never be read as an option.
    assert cmd[-2:] == ["--", SAMPLE_CANON]
    assert "--no-playlist" in cmd


def test_info_is_normalised_from_ytdlp():
    info = mixes.normalize_info(SAMPLE_INFO, "mixcloud", SAMPLE_CANON)
    assert info["title"] == "Zouktime Marathon Brno Sunday set"
    assert info["uploader"] == "Martin Šmoldas"
    assert info["date"] == "2025-04-21"
    assert info["duration"] == 3721
    assert info["source_label"] == "Mixcloud"


def test_decomposed_names_fold_to_one_spelling():
    decomposed = {"title": "Divoká noc", "uploader": "Šmoldas"}
    info = mixes.normalize_info(decomposed, "mixcloud", SAMPLE_CANON)
    assert info["title"] == "Divoká noc" and info["uploader"] == "Šmoldas"
    assert mixes.mix_dir("/music", "u", "Šmoldas") == "/music/u/Šmoldas/DJ Sets"


def test_soundcloud_cover_uses_the_500px_rendition():
    d = {"thumbnail": "https://i1.sndcdn.com/a-original.png",
         "thumbnails": [{"url": "https://i1.sndcdn.com/a-crop.jpg"},
                        {"url": "https://i1.sndcdn.com/a-t500x500.jpg"},
                        {"url": "https://i1.sndcdn.com/a-original.png"}]}
    assert mixes._pick_thumbnail(d) == "https://i1.sndcdn.com/a-t500x500.jpg"


def test_mix_paths_are_artist_album_like_the_tags_and_are_safe():
    # <user>/<DJ>/DJ Sets/ — the player's artist-folder pass finds it there.
    assert mixes.mix_dir("/music", "claude_test", "DJ / Name") == "/music/claude_test/DJ _ Name/DJ Sets"
    assert mixes.mix_basename('A: "B"?') == "A_ _B__"
    cut = mixes.mix_basename("ž" * 300)
    assert len(cut.encode()) <= 250 and len((cut + ".aiff").encode()) <= 255
    # Nothing is cut short of the limit.
    assert mixes.mix_basename("a" * 250) == "a" * 250


# ── quality ──

def test_quality_from_mp4_stream_bitrate():
    probe = {"streams": [{"codec_name": "aac", "bit_rate": "64003"}], "format": {"bit_rate": "65900"}}
    q = mixes.parse_probe(probe)
    assert q == {"codec": "AAC", "kbps": 64}
    assert mixes.quality_label("mixcloud", q) == "Mixcloud · AAC 64 kbps"


def test_quality_of_ogg_opus_falls_back_to_the_file_average():
    probe = {"streams": [{"codec_name": "opus"}], "format": {"duration": "100.0"}}
    q = mixes.parse_probe(probe, size_bytes=2_000_000)
    assert q == {"codec": "Opus", "kbps": 160}
    assert mixes.quality_label("mixcloud", q) == "Mixcloud · Opus 160 kbps"


# ── the job ──

class _Job:
    def __init__(self, url, username="claude_test"):
        self.url, self.username = url, username
        self.title, self.progress, self.progress_text = url, 0, ""


@pytest.fixture
def mix_env(monkeypatch, tmp_path):
    seen = {"cmd": None, "tagged": None, "quota": 0, "order": []}

    async def fake_info(url):
        return mixes.normalize_info(SAMPLE_INFO, "mixcloud", SAMPLE_CANON)

    async def fake_run(cmd, timeout, on_percent):
        seen["cmd"], seen["timeout"] = cmd, timeout
        out = cmd[cmd.index("-o") + 1].replace("%(ext)s", "m4a")
        on_percent(50.0)
        with open(out, "wb") as f:
            f.write(b"\0" * 1000)
        with open(cmd[cmd.index("--print-to-file") + 2], "w") as f:
            f.write(out + "\n")
        return 0, ""

    async def fake_cover(url):
        return None

    def fake_tags(path, info, cover):
        seen["tagged"] = (path, info["title"], info["uploader"])
        seen["order"].append("tag")
        return True

    async def fake_probe(path):
        seen["order"].append("probe")
        return {"codec": "AAC", "kbps": 64}

    monkeypatch.setattr(mixes, "fetch_info", fake_info)
    monkeypatch.setattr(mixes, "_run_ytdlp_progress", fake_run)
    monkeypatch.setattr(mixes, "fetch_cover", fake_cover)
    monkeypatch.setattr(mixes, "write_tags", fake_tags)
    monkeypatch.setattr(mixes, "probe_quality", fake_probe)
    monkeypatch.setattr(mixes, "REGISTRY_FILE", tmp_path / "mixes.json")
    monkeypatch.setattr(mixes, "_registry", None)
    return seen, tmp_path


def test_a_mix_lands_under_mixes_with_its_quality_in_the_job(mix_env):
    seen, tmp = mix_env

    async def not_owned(name, artist, album=""):
        return None

    def quota_ok(user):
        seen["quota"] += 1
        return True

    job = _Job(SAMPLE)
    ok = asyncio.run(mixes.run_mix(job, str(tmp / "music"), 2400, quota_ok, not_owned))
    assert ok is True
    path = str(tmp / "music" / "claude_test" / "Martin Šmoldas" / "DJ Sets" / "Zouktime Marathon Brno Sunday set.m4a")
    assert os.path.isfile(path)
    # Tagged in scratch, BEFORE it enters the library — Navidrome never sees it bare.
    tagged_path, *names = seen["tagged"]
    assert "/music/.mix-dl/" in tagged_path and names == ["Zouktime Marathon Brno Sunday set", "Martin Šmoldas"]
    assert seen["timeout"] == 2400 and seen["quota"] == 1
    assert job.progress_text.startswith("Mixcloud · AAC 64 kbps")
    assert job.title == "Martin Šmoldas - Zouktime Marathon Brno Sunday set"
    assert job.progress == 100
    # Quality is read before the cover goes in (Opus has no stream bit rate, so a
    # cover inside the file would inflate the average).
    assert seen["order"] == ["probe", "tag"]
    # Recorded as a mix, so BPM analysis leaves it alone.
    assert mixes.is_mix("Zouktime Marathon Brno Sunday set", "Martin Šmoldas")


def _not_owned_fn():
    async def not_owned(name, artist, album=""):
        return None
    return not_owned


def test_the_finished_file_hands_its_page_cache_back(mix_env, monkeypatch):
    # The container's memory limit counts page cache; a freshly written mix sits
    # in it whole (2026-11-18 OOM: 1564 MB of file cache). The tagged file is
    # flushed and dropped BEFORE it is renamed into the library (same inode): a
    # cancel during the slow fsync must leave nothing in the library, or the
    # follow check would retry the job and save the mix again as "<title> (2)".
    seen, tmp = mix_env
    final = tmp / "music" / "claude_test" / "Martin Šmoldas" / "DJ Sets" / "Zouktime Marathon Brno Sunday set.m4a"
    released = []
    monkeypatch.setattr(mixes, "release_page_cache",
                        lambda p: released.append((p, os.path.isfile(p), final.exists())))
    asyncio.run(mixes.run_mix(_Job(SAMPLE), str(tmp / "music"), 2400, lambda u: True, _not_owned_fn()))
    assert len(released) == 1
    path, existed, final_there = released[0]
    assert "/music/.mix-dl/" in path and existed and not final_there
    assert final.is_file()


def test_a_cancel_during_the_cache_release_leaves_no_mix_in_the_library(mix_env, monkeypatch):
    seen, tmp = mix_env

    def cancelled(p):
        raise asyncio.CancelledError()
    monkeypatch.setattr(mixes, "release_page_cache", cancelled)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(mixes.run_mix(_Job(SAMPLE), str(tmp / "music"), 2400, lambda u: True, _not_owned_fn()))
    assert not [f for f in _library_files(tmp) if f.endswith(".m4a")]
    assert _scratch_left(tmp) == []
    assert not mixes.is_mix("Zouktime Marathon Brno Sunday set", "Martin Šmoldas")


def test_release_page_cache_flushes_then_drops_and_never_raises(monkeypatch, tmp_path):
    calls = []
    real_fsync, real_close = os.fsync, os.close
    monkeypatch.setattr(os, "fsync", lambda fd: (calls.append("fsync"), real_fsync(fd)))
    monkeypatch.setattr(os, "posix_fadvise",
                        lambda fd, off, ln, adv: calls.append(("fadvise", off, ln, adv)))
    f = tmp_path / "a.m4a"
    f.write_bytes(b"\0" * 4096)
    mixes.release_page_cache(str(f))
    # Dirty pages cannot be dropped, so the flush must come first.
    assert calls == ["fsync", ("fadvise", 0, 0, os.POSIX_FADV_DONTNEED)]
    mixes.release_page_cache(str(tmp_path / "missing.m4a"))   # gone already: no error

    # A failing flush (EIO on a busy disk) is swallowed and the fd still closed.
    closed = []

    def bad_fsync(fd):
        raise OSError(5, "Input/output error")
    monkeypatch.setattr(os, "fsync", bad_fsync)
    monkeypatch.setattr(os, "close", lambda fd: (closed.append(fd), real_close(fd)))
    mixes.release_page_cache(str(f))
    assert len(closed) == 1


def _library_files(tmp):
    """What a user can see: everything under music/ except the scratch root."""
    root = tmp / "music"
    if not root.exists():
        return []
    return sorted(str(p.relative_to(root)) for p in root.rglob("*")
                  if not str(p.relative_to(root)).startswith(mixes.SCRATCH_ROOT))


def _scratch_left(tmp):
    s = tmp / "music" / mixes.SCRATCH_ROOT
    return list(s.iterdir()) if s.exists() else []


def test_the_scratch_directory_is_gone_after_a_good_download(mix_env):
    seen, tmp = mix_env
    asyncio.run(mixes.run_mix(_Job(SAMPLE), str(tmp / "music"), 2400, lambda u: True, _not_owned_fn()))
    assert _scratch_left(tmp) == []
    # The title never enters yt-dlp's output template: a "%" in it cannot be
    # read as a template field.
    tmpl = seen["cmd"][seen["cmd"].index("-o") + 1]
    assert tmpl.endswith("/mix.%(ext)s") and "Zouktime" not in tmpl


def test_a_failed_exit_with_a_file_left_behind_is_not_a_mix(mix_env, monkeypatch):
    seen, tmp = mix_env

    async def truncated(cmd, timeout, on_percent):
        out = cmd[cmd.index("-o") + 1].replace("%(ext)s", "m4a")
        with open(out, "wb") as f:
            f.write(b"\0" * 10)
        return 1, "Postprocessing: Conversion failed!"

    monkeypatch.setattr(mixes, "_run_ytdlp_progress", truncated)
    with pytest.raises(RuntimeError, match="Conversion failed"):
        asyncio.run(mixes.run_mix(_Job(SAMPLE), str(tmp / "music"), 2400, lambda u: True, _not_owned_fn()))
    assert seen["tagged"] is None
    assert _library_files(tmp) == []          # not even an empty "<DJ>/DJ Sets"
    assert _scratch_left(tmp) == []
    assert not mixes.is_mix("Zouktime Marathon Brno Sunday set", "Martin Šmoldas")


def test_a_cancelled_download_leaves_nothing_in_the_library(mix_env, monkeypatch):
    seen, tmp = mix_env

    async def cancelled(cmd, timeout, on_percent):
        out = cmd[cmd.index("-o") + 1].replace("%(ext)s", "m4a.part")
        with open(out, "wb") as f:
            f.write(b"\0" * 10)
        raise asyncio.CancelledError()

    monkeypatch.setattr(mixes, "_run_ytdlp_progress", cancelled)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(mixes.run_mix(_Job(SAMPLE), str(tmp / "music"), 2400, lambda u: True, _not_owned_fn()))
    assert _library_files(tmp) == [] and _scratch_left(tmp) == []


def test_stale_scratch_from_a_crash_is_cleared_but_a_live_one_is_not(tmp_path):
    old = tmp_path / ".mix-dl-old"
    live = tmp_path / ".mix-dl-live"
    old.mkdir(); live.mkdir()
    past = time.time() - mixes.SCRATCH_STALE_AFTER - 60
    os.utime(old, (past, past))
    mixes._drop_stale_scratch(str(tmp_path))
    assert not old.exists() and live.exists()


def test_the_registry_survives_a_restart(monkeypatch, tmp_path):
    monkeypatch.setattr(mixes, "REGISTRY_FILE", tmp_path / "sub" / "mixes.json")
    monkeypatch.setattr(mixes, "_registry", None)
    f = tmp_path / "x.m4a"
    f.write_bytes(b"x")
    mixes.remember_mix({"title": "Set", "uploader": "DJ", "url": SAMPLE_CANON}, str(f), "q")
    assert (tmp_path / "sub" / "mixes.json").exists()
    monkeypatch.setattr(mixes, "_registry", None)   # a fresh process
    assert mixes.is_mix("set", "dj") and mixes.is_mix("Set", "DJ")
    assert not mixes.is_mix("Other", "DJ")
    # Deleted from the library: no longer a mix we own.
    f.unlink()
    assert not mixes.is_mix("Set", "DJ")


def test_the_file_name_is_what_the_player_looks_up():
    from app.services import player
    for title in ("Live @ Club ...", "Zouktime: Sunday / 2025", "Divoka\u0301 noc"):
        assert mixes.mix_basename(title) == player._sanitize(player.nfc(title))


def test_an_uploader_never_becomes_a_hidden_folder():
    assert mixes.mix_dir("/music", "u", ".mix-dl") == "/music/u/mix-dl/DJ Sets"
    assert mixes.mix_dir("/music", "u", "...") == "/music/u/Unknown DJ/DJ Sets"


def test_a_different_mix_with_the_same_file_name_is_not_overwritten(mix_env):
    seen, tmp = mix_env
    d = tmp / "music" / "claude_test" / "Martin Šmoldas" / "DJ Sets"
    d.mkdir(parents=True)
    (d / "Zouktime Marathon Brno Sunday set.m4a").write_bytes(b"other mix")
    asyncio.run(mixes.run_mix(_Job(SAMPLE), str(tmp / "music"), 2400, lambda u: True, _not_owned_fn()))
    assert (d / "Zouktime Marathon Brno Sunday set.m4a").read_bytes() == b"other mix"
    assert (d / "Zouktime Marathon Brno Sunday set (2).m4a").exists()


def test_a_mix_already_in_the_library_is_not_downloaded(mix_env):
    seen, tmp = mix_env

    async def owned(name, artist, album=""):
        return "song-1"

    job = _Job(SAMPLE)
    ok = asyncio.run(mixes.run_mix(job, str(tmp / "music"), 2400, lambda u: True, owned))
    assert ok is False and seen["cmd"] is None
    assert "Already in library" in job.progress_text


def test_a_mix_over_quota_is_refused_before_downloading(mix_env):
    seen, tmp = mix_env

    async def not_owned(name, artist, album=""):
        return None

    with pytest.raises(RuntimeError, match="quota"):
        asyncio.run(mixes.run_mix(_Job(SAMPLE), str(tmp / "music"), 2400, lambda u: False, not_owned))
    assert seen["cmd"] is None


def test_a_failed_download_fails_the_job_with_the_reason(mix_env, monkeypatch):
    seen, tmp = mix_env

    async def failing(cmd, timeout, on_percent):
        return 1, "Unable to download JSON metadata: HTTP Error 404"

    async def not_owned(name, artist, album=""):
        return None

    monkeypatch.setattr(mixes, "_run_ytdlp_progress", failing)
    with pytest.raises(RuntimeError, match="Mixcloud: Unable to download"):
        asyncio.run(mixes.run_mix(_Job(SAMPLE), str(tmp / "music"), 2400, lambda u: True, not_owned))


def test_run_download_sends_a_mix_down_the_mix_path(monkeypatch):
    called = {}

    async def fake_run_mix(job, music_dir, timeout, check_quota, find_song_id):
        called["timeout"] = timeout
        return False

    async def no_ytdlp(job):
        raise AssertionError("a mix must never reach the YouTube search path")

    monkeypatch.setattr(mixes, "run_mix", fake_run_mix)
    monkeypatch.setattr(downloader, "_run_ytdlp", no_ytdlp)
    job = jobs.create_job(type_="mix", title=SAMPLE, url=SAMPLE, method="yt-dlp",
                          fmt="original", username="claude_test")
    asyncio.run(downloader.run_download(job))
    assert called["timeout"] == downloader.PODCAST_DL_TIMEOUT
    assert job.status == jobs.JobStatus.DONE


# ── the API ──

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


def test_a_mix_link_is_a_mix_job_whatever_the_client_said(monkeypatch):
    captured = []
    # An account that may not download FLAC still gets a mix: no format is chosen.
    user = {"username": "claude_test", "allowed_formats": ["mp3"], "allowed_methods": ["yt-dlp"]}
    client = _client(user, monkeypatch, captured)
    r = client.post("/api/download", json={"url": SAMPLE, "title": "x", "method": "yt-dlp",
                                           "format": "flac", "type": "track"})
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "mix" and body["format"] == "original" and body["method"] == "yt-dlp"


def test_a_mix_needs_the_ytdlp_method(monkeypatch):
    user = {"username": "u", "allowed_formats": ["mp3", "flac"], "allowed_methods": ["lidarr"]}
    client = _client(user, monkeypatch, [])
    r = client.post("/api/download", json={"url": SAMPLE, "type": "mix"})
    assert r.status_code == 403


def test_a_mix_job_without_a_mix_link_is_refused(monkeypatch):
    user = {"username": "u", "allowed_formats": ["mp3"], "allowed_methods": ["yt-dlp"]}
    client = _client(user, monkeypatch, [])
    r = client.post("/api/download", json={"url": "https://example.com/x", "type": "mix"})
    assert r.status_code == 400


def test_a_failed_mix_can_be_retried_by_an_account_without_flac(monkeypatch):
    user = {"username": "claude_test", "allowed_formats": ["mp3"], "allowed_methods": ["yt-dlp"]}
    job = jobs.create_job(type_="mix", title="DJ - Set", url=SAMPLE, method="yt-dlp",
                          fmt="original", username="claude_test")
    job.status = jobs.JobStatus.FAILED
    client = _client(user, monkeypatch, [])
    r = client.post(f"/api/jobs/{job.id}/retry")
    assert r.status_code == 200 and r.json()["type"] == "mix"


def test_mix_info_needs_the_ytdlp_method(monkeypatch):
    client = _client({"username": "u", "allowed_methods": ["lidarr"]}, monkeypatch, [])
    r = client.post("/api/mix/info", json={"url": SAMPLE})
    assert r.status_code == 403


def test_mix_info_refuses_a_non_mix_link(monkeypatch):
    client = _client({"username": "u"}, monkeypatch, [])
    r = client.post("/api/mix/info", json={"url": "https://soundcloud.com/djtokinou/sets/x"})
    assert r.status_code == 400
    assert "Mixcloud or SoundCloud" in r.json()["detail"]


# ── BPM leaves mixes alone ──

def test_bpm_never_analyses_a_mix(monkeypatch, tmp_path):
    monkeypatch.setattr(mixes, "REGISTRY_FILE", tmp_path / "mixes.json")
    monkeypatch.setattr(mixes, "_registry", None)
    f = tmp_path / "x.m4a"
    f.write_bytes(b"x")
    mixes.remember_mix({"title": "Set", "uploader": "DJ", "url": SAMPLE_CANON}, str(f), "Mixcloud · AAC 64 kbps")

    async def tripwire(*a, **k):
        raise AssertionError("a mix must not be analysed")

    async def owned(name, artist, album=""):
        return "song-1"

    monkeypatch.setattr(bpm, "analyze_track", tripwire)
    monkeypatch.setattr(bpm, "get_cached_bpm", lambda n, a: None)
    monkeypatch.setattr(library, "find_song_id", owned)
    bpm_router._not_owned.clear()
    app = FastAPI()
    app.include_router(bpm_router.router)
    app.dependency_overrides[auth.get_current_user] = lambda: {"username": "t"}

    async def _no_bind():
        return {"username": "t"}
    app.dependency_overrides[bind_navidrome_creds] = _no_bind
    client = TestClient(app)
    for force in ("false", "true"):
        r = client.get("/api/bpm/track", params={"name": "Set", "artist": "DJ", "force": force})
        assert r.status_code == 200
        assert r.json()["owned"] is True and r.json()["analysable"] is False
    r = client.post("/api/bpm/lookup-by-name", json={"tracks": [{"name": "Set", "artist": "DJ"}], "analyze": True})
    assert r.status_code == 200 and r.json()["tracks"] == []


# ── tags, on real files (needs ffmpeg; runs in the container, skipped elsewhere) ──

@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
@pytest.mark.parametrize("ext,codec", [("m4a", "aac"), ("opus", "libopus")])
def test_tags_and_cover_survive_on_real_files(tmp_path, ext, codec):
    path = str(tmp_path / f"mix.{ext}")
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-c:a", codec, "-b:a", "64k", path], check=True)
    jpg = str(tmp_path / "c.jpg")
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=32x32",
                    "-frames:v", "1", jpg], check=True)
    cover = (open(jpg, "rb").read(), "image/jpeg")
    info = {"title": "Zouktime Sunday", "uploader": "Martin Šmoldas", "date": "2025-04-21", "url": SAMPLE_CANON}
    assert mixes.write_tags(path, info, cover) is True
    import mutagen
    f = mutagen.File(path, easy=True)
    assert f["title"] == ["Zouktime Sunday"]
    assert f["artist"] == ["Martin Šmoldas"]
    assert f["album"] == [mixes.MIX_ALBUM]
    raw = mutagen.File(path)
    if ext == "m4a":
        assert raw.tags["covr"][0] == cover[0]
    else:
        assert raw.tags["metadata_block_picture"]
    q = asyncio.run(mixes.probe_quality(path))
    assert q["codec"] == ("AAC" if ext == "m4a" else "Opus") and q["kbps"] > 0


def test_two_djs_with_the_same_mix_title_each_play_their_own(mix_env, monkeypatch):
    """Under <user>/Mixes/<DJ>/ every mix fell through the player's artist-folder
    pass to a title-only glob, which returned whichever "Sunday set" it met first —
    another DJ's mix played under this one's name."""
    from pathlib import Path
    from app.services import player
    seen, tmp = mix_env
    music = tmp / "music"
    paths = {}
    for dj in ("DJ Alpha", "DJ Beta"):
        async def info_for(url, dj=dj):
            return mixes.normalize_info({"title": "Sunday set", "uploader": dj}, "mixcloud", SAMPLE_CANON)
        monkeypatch.setattr(mixes, "fetch_info", info_for)
        asyncio.run(mixes.run_mix(_Job(SAMPLE), str(music), 2400, lambda u: True, _not_owned_fn()))
        found = [p for p in (music / "claude_test").rglob("Sunday set.m4a") if dj in p.parts]
        assert len(found) == 1
        paths[dj] = str(found[0])
    assert paths["DJ Alpha"] != paths["DJ Beta"]
    assert paths["DJ Alpha"].endswith("/claude_test/DJ Alpha/DJ Sets/Sunday set.m4a")
    monkeypatch.setattr(player, "MUSIC_DIR", Path(music))
    for dj, path in paths.items():
        assert player._resolve_local_file("Sunday set", dj)["path"] == path
