import asyncio
import os

from fastapi import APIRouter, HTTPException, Query, Depends

from app.models import PodcastSubRequest, PodcastSubUpdate
from app.services import auth, podcasts, search_providers, jobs, downloader

router = APIRouter(prefix="/api/podcasts", tags=["podcasts"])


@router.get("")
async def list_podcasts(user: dict = Depends(auth.get_current_user)):
    """List downloaded podcast shows and their episodes."""
    music_dir = os.environ.get("MUSIC_DIR", "/music")
    podcasts_dir = os.path.join(music_dir, user["username"], "Podcasts")
    # Also check legacy path
    legacy_dir = os.path.join(music_dir, "Podcasts")
    if not os.path.isdir(podcasts_dir) and os.path.isdir(legacy_dir):
        podcasts_dir = legacy_dir
    if not os.path.isdir(podcasts_dir):
        return {"shows": [], "total_size": 0}
    shows = []
    total_size = 0
    for show_name in sorted(os.listdir(podcasts_dir)):
        show_path = os.path.join(podcasts_dir, show_name)
        if not os.path.isdir(show_path):
            continue
        episodes = []
        show_size = 0
        for fname in sorted(os.listdir(show_path)):
            fpath = os.path.join(show_path, fname)
            if not os.path.isfile(fpath):
                continue
            size = os.path.getsize(fpath)
            show_size += size
            name = os.path.splitext(fname)[0]
            episodes.append({
                "name": name,
                "filename": fname,
                "size": size,
                "modified": os.path.getmtime(fpath),
            })
        episodes.sort(key=lambda e: e["modified"], reverse=True)
        total_size += show_size
        shows.append({
            "name": show_name,
            "episodes": episodes,
            "total_size": show_size,
            "count": len(episodes),
        })
    return {"shows": shows, "total_size": total_size}


@router.delete("/{show_name}/{filename}")
async def delete_podcast_episode(show_name: str, filename: str, user: dict = Depends(auth.get_current_user)):
    """Delete a single podcast episode file."""
    music_dir = os.environ.get("MUSIC_DIR", "/music")
    podcasts_dir = os.path.join(music_dir, user["username"], "Podcasts")
    if not os.path.isfile(os.path.join(podcasts_dir, show_name, filename)):
        podcasts_dir = os.path.join(music_dir, "Podcasts")
    fpath = os.path.join(podcasts_dir, show_name, filename)
    if not os.path.isfile(fpath):
        raise HTTPException(404, "Episode not found")
    os.remove(fpath)
    # Remove show dir if empty
    show_dir = os.path.join(podcasts_dir, show_name)
    if os.path.isdir(show_dir) and not os.listdir(show_dir):
        os.rmdir(show_dir)
    return {"status": "deleted"}


@router.delete("/{show_name}")
async def delete_podcast_show(show_name: str, user: dict = Depends(auth.get_current_user)):
    """Delete all episodes of a podcast show."""
    import shutil
    music_dir = os.environ.get("MUSIC_DIR", "/music")
    podcasts_dir = os.path.join(music_dir, user["username"], "Podcasts")
    if not os.path.isdir(os.path.join(podcasts_dir, show_name)):
        podcasts_dir = os.path.join(music_dir, "Podcasts")
    show_dir = os.path.join(podcasts_dir, show_name)
    if not os.path.isdir(show_dir):
        raise HTTPException(404, "Show not found")
    shutil.rmtree(show_dir)
    return {"status": "deleted"}


@router.get("/rss-episodes")
async def get_rss_episodes(feed_url: str = Query(...), user: dict = Depends(auth.get_current_user)):
    """Get episodes from an RSS feed URL directly."""
    episodes = await search_providers.parse_podcast_rss(feed_url)
    return {"episodes": episodes}


@router.get("/subs")
async def get_podcast_subs(user: dict = Depends(auth.get_current_user)):
    return {"subs": podcasts.get_subs()}


@router.post("/subs")
async def subscribe_podcast(req: PodcastSubRequest, user: dict = Depends(auth.get_current_user)):
    if not podcasts.subscribe(req.show_name, req.spotify_id, req.image, req.max_episodes, req.feed_url):
        raise HTTPException(409, "Already subscribed")
    return {"status": "subscribed"}


@router.delete("/subs/{spotify_id}")
async def unsubscribe_podcast(spotify_id: str, user: dict = Depends(auth.get_current_user)):
    if not podcasts.unsubscribe(spotify_id):
        raise HTTPException(404, "Subscription not found")
    return {"status": "unsubscribed"}


@router.put("/subs/{spotify_id}")
async def update_podcast_sub(spotify_id: str, req: PodcastSubUpdate, user: dict = Depends(auth.get_current_user)):
    if not podcasts.update_sub(spotify_id, req.max_episodes):
        raise HTTPException(404, "Subscription not found")
    return {"status": "updated"}


@router.post("/sync")
async def sync_podcasts(user: dict = Depends(auth.get_current_user)):
    """Sync all subscribed podcasts — download new episodes, cleanup old ones."""
    from app import background

    subs = podcasts.get_subs()
    if not subs:
        return {"status": "no_subs", "synced": 0}
    synced = 0
    for sub in subs:
        try:
            episodes = await background._fetch_show_episodes(sub)
            uname = user["username"]
            local = set(e.lower() for e in podcasts.get_local_episodes(sub["show_name"], username=uname))
            missing = [ep for ep in episodes if ep["name"].lower().strip() not in local]
            if missing:
                # Respect max_episodes limit
                if sub.get("max_episodes", 0) > 0:
                    missing = missing[:max(0, sub["max_episodes"] - len(local))]
                if missing:
                    playlist_tracks = [{"name": ep["name"], "artist": sub["show_name"],
                                        "album": sub["show_name"],
                                        "image": ep.get("image") or sub.get("image", ""),
                                        "url": ep.get("url", "")} for ep in missing]
                    job = jobs.create_job(
                        type_="show",
                        title=f"Sync: {sub['show_name']} ({len(missing)} new)",
                        url="",
                        method="yt-dlp",
                        fmt="mp3",
                        playlist_name="",
                        playlist_tracks=playlist_tracks,
                        username=uname,
                    )
                    task = asyncio.create_task(downloader.run_download(job))
                    jobs.register_task(job.id, task)
                    synced += len(missing)
            # Cleanup old episodes
            if sub.get("max_episodes", 0) > 0:
                podcasts.cleanup_old_episodes(sub["show_name"], sub["max_episodes"], username=uname)
        except Exception:
            pass
    return {"status": "synced", "synced": synced}
