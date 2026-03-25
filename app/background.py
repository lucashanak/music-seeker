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


async def _favorites_release_check():
    """Background task: check for new releases from favorite artists weekly."""
    await asyncio.sleep(60)  # initial delay
    while True:
        try:
            await favorites.check_new_releases()
        except Exception:
            pass
        await asyncio.sleep(RELEASE_CHECK_INTERVAL)


async def startup():
    """Main startup function — called by app factory."""
    if not ADMIN_PASS:
        import sys
        print("WARNING: ADMIN_PASS not set! Set it via environment variable.", file=sys.stderr)
    else:
        auth.init_admin(ADMIN_USER, ADMIN_PASS)
    asyncio.create_task(_podcast_auto_sync())
    asyncio.create_task(_favorites_release_check())
    # Start DLNA renderer discovery
    from app.services import dlna
    await dlna.start_discovery()
