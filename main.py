import asyncio
import os
from fastapi import FastAPI, HTTPException, Query, Depends, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

import spotify
import jobs
import downloader
import library
import settings as app_settings
import auth
import recognize
import lastfm
import podcasts

APP_VERSION = "1.9.0"

app = FastAPI(title="MusicSeeker", version=APP_VERSION)

ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("ADMIN_PASS", "")


SYNC_INTERVAL = int(os.environ.get("PODCAST_SYNC_HOURS", "6")) * 3600


@app.on_event("startup")
async def startup():
    if not ADMIN_PASS:
        import sys
        print("WARNING: ADMIN_PASS not set! Set it via environment variable.", file=sys.stderr)
        return
    auth.init_admin(ADMIN_USER, ADMIN_PASS)
    asyncio.create_task(_podcast_auto_sync())


async def _podcast_auto_sync():
    """Background task: sync subscribed podcasts every SYNC_INTERVAL seconds."""
    while True:
        await asyncio.sleep(SYNC_INTERVAL)
        subs = podcasts.get_subs()
        if not subs:
            continue
        for sub in subs:
            try:
                show_data = await spotify.get_show_episodes(sub["spotify_id"])
                episodes = show_data.get("episodes", [])
                local = set(e.lower() for e in podcasts.get_local_episodes(sub["show_name"]))
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
                        )
                        task = asyncio.create_task(downloader.run_download(job))
                        jobs.register_task(job.id, task)
                if sub.get("max_episodes", 0) > 0:
                    podcasts.cleanup_old_episodes(sub["show_name"], sub["max_episodes"])
            except Exception:
                pass


# --- Version (public) ---

@app.get("/api/version")
async def get_version():
    return {
        "version": APP_VERSION,
        "spotify_search": bool(spotify.SPOTIFY_CLIENT_ID and spotify.SPOTIFY_CLIENT_SECRET),
        "spotify_user": bool(spotify.SPOTIFY_REFRESH_TOKEN),
    }


# --- Auth (public) ---

class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
async def login(req: LoginRequest):
    token = auth.login(req.username, req.password)
    if not token:
        raise HTTPException(401, "Invalid username or password")
    return {"token": token}


@app.get("/api/auth/me")
async def get_me(user: dict = Depends(auth.get_current_user)):
    return user


# --- API Models ---

class DownloadRequest(BaseModel):
    url: str = ""
    title: str = ""
    method: str = "yt-dlp"
    format: str = "flac"
    type: str = "track"
    playlist_name: str = ""
    playlist_tracks: list[dict] = []


# --- Protected Routes ---

@app.get("/api/search")
async def search(
    q: str = Query(..., min_length=1),
    type: str = Query("track", pattern="^(track|album|artist|playlist|show|episode)$"),
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0),
    user: dict = Depends(auth.get_current_user),
):
    results = await spotify.search(q, type, limit, offset)
    return {"results": results, "query": q, "type": type}


@app.get("/api/spotify/playlists")
async def get_playlists(user: dict = Depends(auth.get_current_user)):
    playlists = await spotify.get_user_playlists()
    return {"playlists": playlists}


@app.get("/api/spotify/liked")
async def get_liked_tracks(user: dict = Depends(auth.get_current_user)):
    data = await spotify.get_liked_tracks()
    return data


@app.get("/api/spotify/playlist/{playlist_id}/tracks")
async def get_playlist_tracks(playlist_id: str, user: dict = Depends(auth.get_current_user)):
    data = await spotify.get_playlist_tracks(playlist_id)
    return data


@app.get("/api/spotify/show/{show_id}/episodes")
async def get_show_episodes(show_id: str, user: dict = Depends(auth.get_current_user)):
    data = await spotify.get_show_episodes(show_id)
    return data


# --- Discover (Last.fm) ---

@app.get("/api/discover/tags")
async def discover_tags(
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(auth.get_current_user),
):
    if not lastfm.LASTFM_API_KEY:
        raise HTTPException(503, "Last.fm API key not configured")
    tags = await lastfm.get_top_tags(limit)
    return {"tags": tags}


@app.get("/api/discover/tag/{tag_name}")
async def discover_tag(
    tag_name: str,
    type: str = Query("track", pattern="^(track|album|artist|playlist)$"),
    limit: int = Query(20, ge=1, le=50),
    page: int = Query(1, ge=1),
    user: dict = Depends(auth.get_current_user),
):
    if not lastfm.LASTFM_API_KEY:
        raise HTTPException(503, "Last.fm API key not configured")
    if type == "track":
        results = await lastfm.get_tag_tracks(tag_name, limit, page)
    elif type == "album":
        results = await lastfm.get_tag_albums(tag_name, limit, page)
    else:
        results = await lastfm.get_tag_artists(tag_name, limit, page)
    return {"results": results, "tag": tag_name, "type": type}


class ResolveRequest(BaseModel):
    name: str
    artist: str = ""
    type: str = "track"


@app.post("/api/discover/resolve")
async def discover_resolve(req: ResolveRequest, user: dict = Depends(auth.get_current_user)):
    result = await spotify.resolve_url(req.name, req.artist, req.type)
    if not result:
        raise HTTPException(404, "Not found on Spotify")
    return result


@app.post("/api/download")
async def start_download(req: DownloadRequest, user: dict = Depends(auth.get_current_user)):
    if req.method not in user.get("allowed_methods", ["yt-dlp", "slskd", "lidarr"]):
        raise HTTPException(403, f"Method '{req.method}' not allowed for your account")
    if req.format not in user.get("allowed_formats", ["mp3", "flac"]):
        raise HTTPException(403, f"Format '{req.format}' not allowed for your account")
    job = jobs.create_job(
        type_=req.type,
        title=req.title or req.url,
        url=req.url,
        method=req.method,
        fmt=req.format,
        playlist_name=req.playlist_name,
        playlist_tracks=req.playlist_tracks,
    )
    task = asyncio.create_task(downloader.run_download(job))
    jobs.register_task(job.id, task)
    return job.to_dict()


@app.get("/api/jobs")
async def list_jobs(user: dict = Depends(auth.get_current_user)):
    return {"jobs": jobs.get_all_jobs()}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str, user: dict = Depends(auth.get_current_user)):
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job.to_dict()


@app.delete("/api/jobs/{job_id}")
async def cancel_job(job_id: str, user: dict = Depends(auth.get_current_user)):
    if not jobs.cancel_job(job_id):
        raise HTTPException(404, "Job not found")
    return {"status": "cancelled"}


@app.delete("/api/jobs")
async def clear_history(user: dict = Depends(auth.get_current_user)):
    count = jobs.clear_history()
    return {"status": "cleared", "count": count}

@app.post('/api/jobs/{job_id}/retry')
async def retry_job(job_id: str, user: dict = Depends(auth.get_current_user)):
    data = jobs.get_retry_data(job_id)
    if not data:
        raise HTTPException(404, 'Job not found or not retryable')
    job = jobs.create_job(
        type_=data['type'],
        title=data['title'],
        url=data['url'],
        method=data['method'],
        fmt=data['format'],
    )
    task = asyncio.create_task(downloader.run_download(job))
    jobs.register_task(job.id, task)
    return job.to_dict()



class LibraryCheckRequest(BaseModel):
    items: list[dict]


@app.post("/api/library/check")
async def check_library(req: LibraryCheckRequest, user: dict = Depends(auth.get_current_user)):
    results = await library.check_items(req.items)
    return {"results": results}


# --- Recognize ---

@app.post("/api/recognize")
async def recognize_song(audio: UploadFile = File(...), user: dict = Depends(auth.get_current_user)):
    data = await audio.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "Audio file too large")
    result = await recognize.identify_song(data)
    if not result:
        raise HTTPException(404, "Could not identify the song")

    # Search Spotify for the recognized track
    if result.get("name"):
        try:
            tracks = await spotify.search(f"{result['artist']} {result['name']}", "track", 1)
            if tracks:
                result["spotify_url"] = tracks[0].get("url", "")
                result["image"] = result.get("image") or tracks[0].get("image", "")
                result["id"] = tracks[0].get("id", "")
                result["url"] = tracks[0].get("url", "")
        except Exception:
            pass

    return result


# --- Settings ---

@app.get("/api/settings")
async def get_settings(user: dict = Depends(auth.get_current_user)):
    return app_settings.get_all()


class SettingsUpdate(BaseModel):
    default_format: str | None = None
    default_method: str | None = None
    max_concurrent: int | None = None
    navidrome_url: str | None = None
    navidrome_user: str | None = None
    navidrome_password: str | None = None
    slskd_url: str | None = None
    slskd_api_key: str | None = None


@app.put("/api/settings")
async def update_settings(req: SettingsUpdate, user: dict = Depends(auth.require_admin)):
    updated = app_settings.update(req.model_dump(exclude_none=True))
    return updated


# --- User Management (admin) ---

@app.get("/api/users")
async def get_users(user: dict = Depends(auth.require_admin)):
    return {"users": auth.list_users()}


class CreateUserRequest(BaseModel):
    username: str
    password: str
    is_admin: bool = False
    allowed_formats: list[str] = ["mp3", "flac"]
    allowed_methods: list[str] = ["yt-dlp", "slskd", "lidarr"]


@app.post("/api/users")
async def create_user(req: CreateUserRequest, user: dict = Depends(auth.require_admin)):
    if not auth.create_user(req.username, req.password, req.is_admin,
                            req.allowed_formats, req.allowed_methods):
        raise HTTPException(409, "User already exists")
    return {"status": "created", "username": req.username}


class UpdateUserPermsRequest(BaseModel):
    allowed_formats: list[str] | None = None
    allowed_methods: list[str] | None = None


@app.put("/api/users/{username}/perms")
async def update_user_perms(username: str, req: UpdateUserPermsRequest, user: dict = Depends(auth.require_admin)):
    if not auth.update_user_perms(username, req.allowed_formats, req.allowed_methods):
        raise HTTPException(404, "User not found")
    return {"status": "updated"}


@app.delete("/api/users/{username}")
async def delete_user(username: str, user: dict = Depends(auth.require_admin)):
    if username == user["username"]:
        raise HTTPException(400, "Cannot delete yourself")
    if not auth.delete_user(username):
        raise HTTPException(404, "User not found")
    return {"status": "deleted"}


class ChangePasswordRequest(BaseModel):
    new_password: str


@app.put("/api/users/{username}/password")
async def change_password(username: str, req: ChangePasswordRequest, user: dict = Depends(auth.get_current_user)):
    if username != user["username"] and not user.get("is_admin"):
        raise HTTPException(403, "Can only change your own password")
    if not auth.change_password(username, req.new_password):
        raise HTTPException(404, "User not found")
    return {"status": "updated"}


# --- Podcasts (file browser) ---

@app.get("/api/podcasts")
async def list_podcasts(user: dict = Depends(auth.get_current_user)):
    """List downloaded podcast shows and their episodes."""
    podcasts_dir = os.path.join(os.environ.get("MUSIC_DIR", "/music"), "Podcasts")
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


@app.delete("/api/podcasts/{show_name}/{filename}")
async def delete_podcast_episode(show_name: str, filename: str, user: dict = Depends(auth.get_current_user)):
    """Delete a single podcast episode file."""
    podcasts_dir = os.path.join(os.environ.get("MUSIC_DIR", "/music"), "Podcasts")
    fpath = os.path.join(podcasts_dir, show_name, filename)
    if not os.path.isfile(fpath):
        raise HTTPException(404, "Episode not found")
    os.remove(fpath)
    # Remove show dir if empty
    show_dir = os.path.join(podcasts_dir, show_name)
    if os.path.isdir(show_dir) and not os.listdir(show_dir):
        os.rmdir(show_dir)
    return {"status": "deleted"}


@app.delete("/api/podcasts/{show_name}")
async def delete_podcast_show(show_name: str, user: dict = Depends(auth.get_current_user)):
    """Delete all episodes of a podcast show."""
    import shutil
    podcasts_dir = os.path.join(os.environ.get("MUSIC_DIR", "/music"), "Podcasts")
    show_dir = os.path.join(podcasts_dir, show_name)
    if not os.path.isdir(show_dir):
        raise HTTPException(404, "Show not found")
    shutil.rmtree(show_dir)
    return {"status": "deleted"}


# --- Podcast Subscriptions ---

@app.get("/api/podcasts/subs")
async def get_podcast_subs(user: dict = Depends(auth.get_current_user)):
    return {"subs": podcasts.get_subs()}


class PodcastSubRequest(BaseModel):
    show_name: str
    spotify_id: str
    image: str = ""
    max_episodes: int = 0


@app.post("/api/podcasts/subs")
async def subscribe_podcast(req: PodcastSubRequest, user: dict = Depends(auth.get_current_user)):
    if not podcasts.subscribe(req.show_name, req.spotify_id, req.image, req.max_episodes):
        raise HTTPException(409, "Already subscribed")
    return {"status": "subscribed"}


@app.delete("/api/podcasts/subs/{spotify_id}")
async def unsubscribe_podcast(spotify_id: str, user: dict = Depends(auth.get_current_user)):
    if not podcasts.unsubscribe(spotify_id):
        raise HTTPException(404, "Subscription not found")
    return {"status": "unsubscribed"}


class PodcastSubUpdate(BaseModel):
    max_episodes: int | None = None


@app.put("/api/podcasts/subs/{spotify_id}")
async def update_podcast_sub(spotify_id: str, req: PodcastSubUpdate, user: dict = Depends(auth.get_current_user)):
    if not podcasts.update_sub(spotify_id, req.max_episodes):
        raise HTTPException(404, "Subscription not found")
    return {"status": "updated"}


@app.post("/api/podcasts/sync")
async def sync_podcasts(user: dict = Depends(auth.get_current_user)):
    """Sync all subscribed podcasts — download new episodes, cleanup old ones."""
    subs = podcasts.get_subs()
    if not subs:
        return {"status": "no_subs", "synced": 0}
    synced = 0
    for sub in subs:
        try:
            show_data = await spotify.get_show_episodes(sub["spotify_id"])
            episodes = show_data.get("episodes", [])
            local = set(e.lower() for e in podcasts.get_local_episodes(sub["show_name"]))
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
                    )
                    task = asyncio.create_task(downloader.run_download(job))
                    jobs.register_task(job.id, task)
                    synced += len(missing)
            # Cleanup old episodes
            if sub.get("max_episodes", 0) > 0:
                podcasts.cleanup_old_episodes(sub["show_name"], sub["max_episodes"])
        except Exception:
            pass
    return {"status": "synced", "synced": synced}


# --- Static files ---

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/favicon.ico")
@app.get("/favicon.svg")
async def favicon():
    return FileResponse("static/favicon.svg", media_type="image/svg+xml")


@app.get("/")
async def index():
    return FileResponse(
        "static/index.html",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "ETag": f'"{APP_VERSION}"',
        },
    )
