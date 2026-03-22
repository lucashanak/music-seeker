"""Favorites module: per-user artist following with new release detection."""

import os
import json
import time
import logging

import search_providers

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
FAVORITES_DIR = os.path.join(DATA_DIR, "favorites")


def _path(username: str) -> str:
    return os.path.join(FAVORITES_DIR, f"{username}.json")


def load_favorites(username: str) -> dict:
    path = _path(username)
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"artists": []}


def save_favorites(username: str, data: dict):
    os.makedirs(FAVORITES_DIR, exist_ok=True)
    with open(_path(username), "w") as f:
        json.dump(data, f, indent=2)


def get_favorites(username: str) -> list[dict]:
    return load_favorites(username).get("artists", [])


def is_following(username: str, artist_id: str) -> bool:
    artists = get_favorites(username)
    return any(a["id"] == artist_id for a in artists)


async def follow_artist(username: str, artist_id: str, name: str, image: str) -> bool:
    data = load_favorites(username)
    if any(a["id"] == artist_id for a in data["artists"]):
        return False  # already following

    # Fetch latest album ID for future comparison
    last_album = None
    try:
        album = await search_providers.deezer_artist_latest_album(artist_id)
        if album:
            last_album = album
    except Exception:
        pass

    entry = {
        "id": artist_id,
        "name": name,
        "image": image,
        "added_at": time.time(),
        "auto_download": False,
        "last_album_id": last_album["id"] if last_album else None,
        "last_album_name": last_album["name"] if last_album else None,
        "new_release": None,
    }
    data["artists"].append(entry)
    save_favorites(username, data)
    return True


def unfollow_artist(username: str, artist_id: str) -> bool:
    data = load_favorites(username)
    before = len(data["artists"])
    data["artists"] = [a for a in data["artists"] if a["id"] != artist_id]
    if len(data["artists"]) == before:
        return False
    save_favorites(username, data)
    return True


def update_artist(username: str, artist_id: str, updates: dict) -> bool:
    data = load_favorites(username)
    for a in data["artists"]:
        if a["id"] == artist_id:
            for k, v in updates.items():
                a[k] = v
            save_favorites(username, data)
            return True
    return False


def clear_new_release(username: str, artist_id: str) -> bool:
    return update_artist(username, artist_id, {"new_release": None})


def get_all_usernames() -> list[str]:
    """Get all usernames that have favorites files."""
    if not os.path.isdir(FAVORITES_DIR):
        return []
    names = []
    for fname in os.listdir(FAVORITES_DIR):
        if fname.endswith(".json"):
            names.append(fname[:-5])
    return names


async def check_new_releases() -> int:
    """Check all users' favorites for new releases. Returns count of new releases found."""
    import asyncio
    new_count = 0
    usernames = get_all_usernames()
    for username in usernames:
        data = load_favorites(username)
        changed = False
        for artist in data["artists"]:
            try:
                await asyncio.sleep(1)  # rate limit
                album = await search_providers.deezer_artist_latest_album(artist["id"])
                if not album:
                    continue
                if artist.get("last_album_id") and album["id"] != artist["last_album_id"]:
                    artist["new_release"] = {
                        "id": album["id"],
                        "name": album["name"],
                        "release_date": album.get("release_date", ""),
                    }
                    artist["last_album_id"] = album["id"]
                    artist["last_album_name"] = album["name"]
                    changed = True
                    new_count += 1
                    logger.info(f"New release for {artist['name']}: {album['name']} (user: {username})")

                    # Auto-download if enabled
                    if artist.get("auto_download"):
                        try:
                            import jobs
                            import downloader
                            tracks = await search_providers.deezer_get_album_tracks(album["id"])
                            if tracks:
                                playlist_tracks = [
                                    {"name": t["name"], "artist": t["artist"],
                                     "album": t.get("album", album["name"]),
                                     "image": t.get("image", artist.get("image", "")),
                                     "url": t.get("url", "")}
                                    for t in tracks
                                ]
                                job = jobs.create_job(
                                    type_="album",
                                    title=f"Auto: {artist['name']} - {album['name']}",
                                    url="", method="yt-dlp", fmt="flac",
                                    playlist_name="", playlist_tracks=playlist_tracks,
                                    username=username,
                                )
                                import asyncio as _asyncio
                                task = _asyncio.create_task(downloader.run_download(job))
                                jobs.register_task(job.id, task)
                                logger.info(f"Auto-download started: {artist['name']} - {album['name']}")
                        except Exception as e:
                            logger.error(f"Auto-download failed for {artist['name']}: {e}")

                elif not artist.get("last_album_id") and album:
                    # First time — just set the baseline
                    artist["last_album_id"] = album["id"]
                    artist["last_album_name"] = album["name"]
                    changed = True
            except Exception as e:
                logger.warning(f"Failed to check {artist['name']}: {e}")
        if changed:
            save_favorites(username, data)
    return new_count


async def background_check_loop():
    """Background task: check for new releases weekly. Initial check 60s after startup."""
    import asyncio
    await asyncio.sleep(60)
    while True:
        try:
            count = await check_new_releases()
            if count:
                logger.info(f"Background check found {count} new releases")
        except Exception as e:
            logger.error(f"Background release check failed: {e}")
        await asyncio.sleep(604800)  # 1 week
