import asyncio
import os
from app.services import auth, podcasts, search_providers, spotify, jobs, downloader, favorites
from app.config import ADMIN_USER, ADMIN_PASS, SYNC_INTERVAL, RELEASE_CHECK_INTERVAL


async def _fetch_show_episodes(sub: dict) -> list[dict]:
    """Fetch episodes for a subscription via RSS feed or Spotify."""
    if sub.get("feed_url"):
        episodes = await search_providers.parse_podcast_rss(sub["feed_url"], sub["show_name"])
        return episodes
    show_data = await spotify.get_show_episodes(sub["spotify_id"])
    return show_data.get("episodes", [])


async def _podcast_auto_sync():
    """Background task: sync subscribed podcasts every SYNC_INTERVAL seconds."""
    while True:
        await asyncio.sleep(SYNC_INTERVAL)
        subs = podcasts.get_subs()
        if not subs:
            continue
        for sub in subs:
            try:
                episodes = await _fetch_show_episodes(sub)
                local = set(e.lower() for e in podcasts.get_local_episodes(sub["show_name"], username="system"))
                missing = [ep for ep in episodes if ep["name"].lower().strip() not in local]
                if missing:
                    if sub.get("max_episodes", 0) > 0:
                        missing = missing[:max(0, sub["max_episodes"] - len(local))]
                    if missing:
                        playlist_tracks = [{"name": ep["name"], "artist": sub["show_name"],
                                            "album": sub["show_name"],
                                            "image": ep.get("image") or sub.get("image", ""),
                                            "url": ep.get("url", "")} for ep in missing]
                        job = jobs.create_job(
                            type_="show",
                            title=f"Auto-sync: {sub['show_name']} ({len(missing)} new)",
                            url="",
                            method="yt-dlp",
                            fmt="mp3",
                            playlist_name="",
                            playlist_tracks=playlist_tracks,
                            username="system",
                        )
                        task = asyncio.create_task(downloader.run_download(job))
                        jobs.register_task(job.id, task)
                if sub.get("max_episodes", 0) > 0:
                    podcasts.cleanup_old_episodes(sub["show_name"], sub["max_episodes"], username="system")
            except Exception:
                pass


MIX_FOLLOW_INTERVAL = 6 * 3600


async def _mix_follow_auto_check():
    """Background task: every 6 h, download NEW mixes of followed DJs that have
    auto-download on. The first run waits a full interval, like the podcast sync:
    a deploy must not set off a burst of downloads."""
    from app.services import mix_follows
    while True:
        await asyncio.sleep(MIX_FOLLOW_INTERVAL)
        try:
            await mix_follows.check_all()
        except Exception:
            pass


async def _favorites_release_check():
    """Background task: check for new releases from favorite artists weekly."""
    await asyncio.sleep(60)  # initial delay
    while True:
        try:
            await favorites.check_new_releases()
        except Exception:
            pass
        await asyncio.sleep(RELEASE_CHECK_INTERVAL)


async def _spotify_health_probe():
    """One cheap call at startup so /api/version knows Spotify's real state.

    The health latch in spotify.py only engages once a request has failed. Without
    this probe the first page load after a restart reports Spotify as available,
    shows the Spotify library tab, and the user has to click it and watch it fail
    before a reload hides it. One request settles it up front instead.
    """
    if not spotify.SPOTIFY_CLIENT_ID or not spotify.SPOTIFY_CLIENT_SECRET:
        return
    try:
        # Cheapest documented endpoint that still requires API access.
        await spotify.spotify_get("browse/new-releases", {"limit": 1})
    except Exception:
        pass  # a failure has already set the latch; nothing else to do here


async def _bpm_feature_backfill():
    """After a start, bring cached tracks up to the current audio-feature version."""
    await asyncio.sleep(90)          # let the app settle and serve first
    try:
        from app.services import bpm
        await bpm.backfill_stale_features()
    except Exception as e:
        import logging
        logging.getLogger("musicseeker").warning("feature backfill stopped: %s", e)


# The event loop keeps only a weak reference to a task; one nobody holds can be
# garbage-collected while it still runs.
_tasks: set = set()


def _spawn(coro) -> "asyncio.Task":
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return t


async def startup():
    """Main startup function — called by app factory."""
    if not ADMIN_PASS:
        import sys
        print("WARNING: ADMIN_PASS not set! Set it via environment variable.", file=sys.stderr)
    else:
        auth.init_admin(ADMIN_USER, ADMIN_PASS)
    asyncio.create_task(_podcast_auto_sync())
    asyncio.create_task(_favorites_release_check())
    asyncio.create_task(_mix_follow_auto_check())
    asyncio.create_task(_spotify_health_probe())
    asyncio.create_task(_bpm_feature_backfill())
    # Start DLNA renderer discovery
    from app.services import dlna
    await dlna.start_discovery()
    # Casts that were active when the process stopped carry on being followed.
    dlna.mark_resume_pending()
    _spawn(dlna.resume_sessions())
