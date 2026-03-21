import asyncio
import os
import re
import shutil
import time
import httpx

from jobs import Job, JobStatus, get_semaphore, save_if_finished
import library

LIDARR_URL = os.environ.get("LIDARR_URL", "http://lidarr:8686")
LIDARR_API_KEY = os.environ.get("LIDARR_API_KEY", "")
MUSIC_DIR = os.environ.get("MUSIC_DIR", "/music")
NAVIDROME_URL = os.environ.get("NAVIDROME_URL", "http://navidrome:4533")
NAVIDROME_PASSWORD = os.environ.get("NAVIDROME_PASSWORD", "")
SLSKD_URL = os.environ.get("SLSKD_URL", "http://slskd:5030")
SLSKD_API_KEY = os.environ.get("SLSKD_API_KEY", "")


async def run_download(job: Job):
    sem = get_semaphore()
    async with sem:
        job.status = JobStatus.RUNNING
        try:
            downloaded = True
            if job.method == "yt-dlp":
                downloaded = await _run_ytdlp(job)
            elif job.method == "slskd":
                downloaded = await _run_slskd(job)
            elif job.method == "lidarr":
                await _run_lidarr(job)
            else:
                raise ValueError(f"Unknown method: {job.method}")

            if job.status == JobStatus.RUNNING:
                job.status = JobStatus.DONE
                job.progress = 100
                if downloaded:
                    await _trigger_navidrome_scan()
                # Create playlist in Navidrome after downloading a Spotify playlist
                if job.type == "playlist" and job.playlist_name and job.playlist_tracks:
                    await _create_navidrome_playlist(job, needs_scan=downloaded is True)
        except asyncio.CancelledError:
            job.status = JobStatus.CANCELLED
        except Exception as e:
            job.status = JobStatus.FAILED
            job.error = str(e)
        finally:
            job.finished_at = time.time()
            save_if_finished(job)


def _sanitize(name: str) -> str:
    """Sanitize a string for use as a filename."""
    return re.sub(r'[/\\:*?"<>|]', '_', name).strip().rstrip('.')


async def _resolve_tracks(job: Job) -> list[dict]:
    """Resolve job into a list of {name, artist, album} dicts for downloading."""
    from spotify import parse_spotify_url, get_track_metadata, get_album_tracks, get_episode_metadata, get_show_episodes

    # Playlists: already have track data
    if job.type == "playlist" and job.playlist_tracks:
        return job.playlist_tracks

    # Shows: already have episode data from frontend
    if job.type == "show" and job.playlist_tracks:
        return job.playlist_tracks

    # Episodes: resolve from Spotify URL
    if job.type == "episode":
        parsed = parse_spotify_url(job.url)
        if parsed and parsed[0] == "episode":
            try:
                meta = await get_episode_metadata(parsed[1])
                return [meta]
            except Exception:
                pass

    # Shows: fetch episodes from Spotify
    if job.type == "show":
        parsed = parse_spotify_url(job.url)
        if parsed and parsed[0] == "show":
            try:
                data = await get_show_episodes(parsed[1])
                return data.get("episodes", [])
            except Exception:
                pass

    # Albums: fetch track list from Spotify
    if job.type == "album":
        parsed = parse_spotify_url(job.url)
        if parsed and parsed[0] == "album":
            try:
                return await get_album_tracks(parsed[1])
            except Exception:
                pass  # Spotify API unavailable

    # Single track: resolve metadata from Spotify URL if available
    parsed = parse_spotify_url(job.url)
    if parsed and parsed[0] == "track":
        try:
            meta = await get_track_metadata(parsed[1])
            return [meta]
        except Exception:
            pass  # Spotify API unavailable, fall through to title parsing

    # Episode URL without type hint
    if parsed and parsed[0] == "episode":
        try:
            meta = await get_episode_metadata(parsed[1])
            return [meta]
        except Exception:
            pass

    if " - " in job.title:
        artist, title = job.title.split(" - ", 1)
        return [{"name": title, "artist": artist, "album": ""}]

    # Fallback: use title as search query
    return [{"name": job.title, "artist": "", "album": ""}]


async def _download_cover(image_url: str, dest_path: str) -> bool:
    """Download album art from Spotify to a temp file."""
    if not image_url:
        return False
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(image_url)
            resp.raise_for_status()
            with open(dest_path, "wb") as f:
                f.write(resp.content)
            return True
    except Exception:
        return False


async def _download_track_ytdlp(artist: str, title: str, album: str, fmt: str,
                                 image_url: str = "", is_podcast: bool = False) -> bool:
    """Download a single track via yt-dlp, then overwrite metadata from Spotify."""
    safe_artist = _sanitize(artist) or "Unknown Artist"
    safe_album = _sanitize(album) or "Unknown Album"
    safe_title = _sanitize(title) or "Unknown"
    if is_podcast:
        out_dir = f"{MUSIC_DIR}/Podcasts/{safe_artist}"
    else:
        out_dir = f"{MUSIC_DIR}/{safe_artist}/{safe_album}"
    out_template = f"{out_dir}/{safe_title}.%(ext)s"
    final_file = f"{out_dir}/{safe_title}.{fmt}"

    if is_podcast:
        # For podcasts, use just the episode title — adding show name makes queries too specific
        query = title
    else:
        query = f"{artist} {title}" if artist else title

    # Step 1: Download audio with yt-dlp (no metadata from YouTube)
    cmd = [
        "yt-dlp", f"ytsearch1:{query}",
        "-x",
        "--audio-format", fmt,
        "--audio-quality", "0",
        "--no-embed-metadata",
        "--no-playlist",
        "-o", out_template,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    await proc.wait()
    if proc.returncode != 0:
        return False

    if not os.path.exists(final_file):
        return False

    # Step 2: Embed Spotify metadata + album art via ffmpeg/metaflac
    if fmt == "flac":
        # For FLAC: use metaflac for tags and cover
        tag_cmd = [
            "metaflac",
            "--remove-all-tags",
            f"--set-tag=ARTIST={artist}",
            f"--set-tag=TITLE={title}",
            f"--set-tag=ALBUM={album}",
            final_file,
        ]
        proc = await asyncio.create_subprocess_exec(
            *tag_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        await proc.wait()

        # Embed cover art
        if image_url:
            cover_path = f"{final_file}.cover.jpg"
            if await _download_cover(image_url, cover_path):
                try:
                    embed = await asyncio.create_subprocess_exec(
                        "metaflac", "--import-picture-from", cover_path, final_file,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                    )
                    await embed.wait()
                finally:
                    if os.path.exists(cover_path):
                        os.remove(cover_path)
    else:
        # For MP3/other: use ffmpeg to embed metadata + cover in one pass
        cover_path = f"{final_file}.cover.jpg"
        has_cover = image_url and await _download_cover(image_url, cover_path)
        tmp_out = f"{final_file}.tmp.{fmt}"
        try:
            ffmpeg_cmd = [
                "ffmpeg", "-y", "-i", final_file,
            ]
            if has_cover:
                ffmpeg_cmd.extend(["-i", cover_path, "-map", "0:a", "-map", "1:0",
                                   "-c:v", "mjpeg", "-id3v2_version", "3",
                                   "-metadata:s:v", "title=Album cover",
                                   "-metadata:s:v", "comment=Cover (front)"])
            else:
                ffmpeg_cmd.extend(["-map", "0:a"])
            ffmpeg_cmd.extend([
                "-c:a", "copy",
                "-metadata", f"artist={artist}",
                "-metadata", f"title={title}",
                "-metadata", f"album={album}",
                tmp_out,
            ])
            proc = await asyncio.create_subprocess_exec(
                *ffmpeg_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            await proc.wait()
            if proc.returncode == 0 and os.path.exists(tmp_out):
                os.replace(tmp_out, final_file)
            elif os.path.exists(tmp_out):
                os.remove(tmp_out)
        finally:
            if os.path.exists(cover_path):
                os.remove(cover_path)

    return True


async def _run_ytdlp(job: Job):
    tracks = await _resolve_tracks(job)
    is_podcast = job.type in ("episode", "show")

    # Library check: skip existing tracks (skip for podcasts — not indexed in Navidrome)
    to_download = tracks
    already_have = 0
    if not is_podcast:
        job.progress_text = "Checking library for existing tracks..."
        to_download = []
        for track in tracks:
            name = track.get("name", "")
            artist = track.get("artist", "")
            sid = await library.find_song_id(name, artist)
            if sid:
                already_have += 1
            else:
                to_download.append(track)

        if already_have > 0:
            job.progress_text = f"Skipping {already_have} tracks already in library, downloading {len(to_download)}..."
        if not to_download:
            job.progress_text = f"All {already_have} tracks already in library, skipping download"
            return False

    # Download each track/episode
    total = len(to_download)
    failed = []
    label = "episodes" if is_podcast else "tracks"
    for i, track in enumerate(to_download, 1):
        name = track.get("name", "")
        artist = track.get("artist", "")
        album = track.get("album", "")
        job.progress_text = f"{i}/{total} — Downloading {artist} - {name}"
        job.progress = int((i - 1) / total * 100)

        image = track.get("image", "")
        ok = await _download_track_ytdlp(artist, name, album, job.format, image, is_podcast=is_podcast)
        if not ok:
            failed.append(f"{artist} - {name}")

    job.progress = 100
    if failed:
        job.progress_text = f"Done with {len(failed)} failures: {', '.join(failed[:3])}"
    else:
        job.progress_text = f"Downloaded {total} {label}"

    return True


async def _slskd_api(method: str, path: str, json_data: dict = None) -> dict | list | None:
    """Call slskd REST API."""
    headers = {"X-API-Key": SLSKD_API_KEY}
    async with httpx.AsyncClient(base_url=SLSKD_URL, headers=headers, timeout=30) as client:
        if method == "GET":
            resp = await client.get(f"/api/v0/{path}")
        elif method == "POST":
            resp = await client.post(f"/api/v0/{path}", json=json_data or {})
        elif method == "DELETE":
            resp = await client.delete(f"/api/v0/{path}")
            return None
        else:
            raise ValueError(f"Unknown method: {method}")
        resp.raise_for_status()
        return resp.json()


def _pick_best_slskd_file(responses: list, preferred_format: str = "flac") -> tuple[str, dict] | None:
    """Pick the best file from slskd search responses. Returns (username, file_info) or None."""
    candidates = []
    audio_exts = {"flac", "mp3", "ogg", "opus", "m4a", "wav", "aac"}
    for resp in responses:
        username = resp.get("username", "")
        for file in resp.get("files", []):
            filename = file.get("filename", "")
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            if ext not in audio_exts:
                continue
            size = file.get("size", 0)
            if size < 500_000:  # skip tiny files (<500KB)
                continue
            score = 0
            if ext == preferred_format:
                score += 100
            if ext == "flac":
                score += 50
            elif ext == "mp3":
                score += 20
            bit_rate = file.get("bitRate", 0)
            score += min(bit_rate // 10, 50)
            score += min(size // 1_000_000, 30)  # prefer larger files
            candidates.append((score, username, file))
    candidates.sort(key=lambda x: x[0], reverse=True)
    return (candidates[0][1], candidates[0][2]) if candidates else None


async def _download_track_slskd(artist: str, title: str, album: str) -> bool:
    """Search and download a single track via slskd. Returns True if successful."""
    # Use only primary artist for search (avoid "Artist1, Artist2" cluttering results)
    search_artist = artist.split(",")[0].strip() if artist else ""
    query = f"{search_artist} {title}" if search_artist else title

    # Start search
    search_result = await _slskd_api("POST", "searches", {"searchText": query})
    search_id = search_result.get("id")
    if not search_id:
        return False

    # Wait for search to complete
    for _ in range(30):  # 60s timeout
        await asyncio.sleep(2)
        status = await _slskd_api("GET", f"searches/{search_id}")
        state = status.get("state", "")
        if "Completed" in state:
            break
        if any(s in state for s in ("Errored", "Cancelled")):
            return False
    else:
        return False

    # Get responses and pick best file
    responses = await _slskd_api("GET", f"searches/{search_id}/responses")
    if not responses:
        return False

    result = _pick_best_slskd_file(responses)
    if not result:
        return False

    username, file_info = result

    # Queue download
    await _slskd_api("POST", f"transfers/downloads/{username}", [file_info])

    # Poll until download completes
    filename = file_info.get("filename", "")
    for _ in range(300):  # 10min timeout (P2P can be slow)
        await asyncio.sleep(2)
        data = await _slskd_api("GET", f"transfers/downloads/{username}")
        if not data:
            continue
        # Navigate directories[].files[] structure
        directories = data.get("directories", []) if isinstance(data, dict) else []
        for dir_entry in directories:
            for dl in dir_entry.get("files", []):
                if dl.get("filename") != filename:
                    continue
                state = dl.get("state", "")
                if "Succeeded" in state or "Completed" in state:
                    # Move file from slskd download dir to music library
                    safe_artist = _sanitize(artist) or "Unknown Artist"
                    safe_album = _sanitize(album) or "Unknown Album"
                    dest_dir = f"{MUSIC_DIR}/{safe_artist}/{safe_album}"
                    os.makedirs(dest_dir, exist_ok=True)
                    # slskd saves to {downloads_dir}/{remote_dir}/{filename}
                    # Find the file in slskd downloads directory
                    slskd_dl_dir = f"{MUSIC_DIR}/.slskd-downloads"
                    basename = filename.rsplit("\\", 1)[-1] if "\\" in filename else os.path.basename(filename)
                    found = None
                    for root, _, files in os.walk(slskd_dl_dir):
                        if basename in files:
                            found = os.path.join(root, basename)
                            break
                    if found:
                        dest = os.path.join(dest_dir, f"{_sanitize(title)}.{basename.rsplit('.', 1)[-1]}")
                        shutil.move(found, dest)
                    return True
                if any(s in state for s in ("Failed", "Cancelled", "Errored")):
                    return False
    return False


async def _run_slskd(job: Job):
    if not SLSKD_API_KEY:
        raise RuntimeError("slskd API key not configured. Set SLSKD_API_KEY in settings.")

    tracks = await _resolve_tracks(job)

    # Library check
    job.progress_text = "Checking library for existing tracks..."
    to_download = []
    already_have = 0
    for track in tracks:
        name = track.get("name", "")
        artist = track.get("artist", "")
        sid = await library.find_song_id(name, artist)
        if sid:
            already_have += 1
        else:
            to_download.append(track)

    if already_have > 0:
        job.progress_text = f"Skipping {already_have} tracks already in library, downloading {len(to_download)}..."
    if not to_download:
        job.progress_text = f"All {already_have} tracks already in library, skipping download"
        return False

    total = len(to_download)
    failed = []
    for i, track in enumerate(to_download, 1):
        name = track.get("name", "")
        artist = track.get("artist", "")
        album = track.get("album", "")
        job.progress_text = f"{i}/{total} — Searching Soulseek for {artist} - {name}"
        job.progress = int((i - 1) / total * 100)

        ok = await _download_track_slskd(artist, name, album)
        if not ok:
            failed.append(f"{artist} - {name}")

    job.progress = 100
    if failed:
        job.progress_text = f"Done with {len(failed)} not found: {', '.join(failed[:3])}"
    else:
        job.progress_text = f"Downloaded {total} tracks from Soulseek"

    return True


async def _run_lidarr(job: Job):
    headers = {"X-Api-Key": LIDARR_API_KEY, "Content-Type": "application/json"}

    artist_name = job.title.split(" - ")[0] if " - " in job.title else job.title

    async with httpx.AsyncClient(base_url=LIDARR_URL, headers=headers) as client:
        job.progress_text = f"Searching for {artist_name} in Lidarr..."
        job.progress = 10

        resp = await client.get("/api/v1/artist/lookup", params={"term": artist_name})
        resp.raise_for_status()
        results = resp.json()

        if not results:
            raise RuntimeError(f"Artist '{artist_name}' not found in Lidarr")

        artist_data = results[0]

        resp = await client.get("/api/v1/artist")
        resp.raise_for_status()
        existing = {a["foreignArtistId"]: a for a in resp.json()}

        foreign_id = artist_data.get("foreignArtistId", "")

        if foreign_id in existing:
            artist = existing[foreign_id]
            job.progress_text = f"Artist {artist_name} already in Lidarr, triggering search..."
        else:
            job.progress_text = f"Adding {artist_name} to Lidarr..."
            job.progress = 30

            add_payload = {
                "foreignArtistId": foreign_id,
                "artistName": artist_data.get("artistName", artist_name),
                "qualityProfileId": 1,
                "metadataProfileId": 1,
                "rootFolderPath": MUSIC_DIR,
                "monitored": True,
                "addOptions": {"searchForMissingAlbums": True},
            }
            resp = await client.post("/api/v1/artist", json=add_payload)
            resp.raise_for_status()
            artist = resp.json()

        job.progress = 60
        job.progress_text = "Triggering album search..."

        search_cmd = {
            "name": "ArtistSearch",
            "artistId": artist["id"],
        }
        resp = await client.post("/api/v1/command", json=search_cmd)
        resp.raise_for_status()

        job.progress = 90
        job.progress_text = "Search triggered in Lidarr, download will proceed in background"


async def _trigger_navidrome_scan():
    if not NAVIDROME_PASSWORD:
        return
    try:
        async with httpx.AsyncClient() as client:
            await client.get(
                f"{NAVIDROME_URL}/rest/startScan",
                params={
                    "v": "1.16.1",
                    "c": "music-seeker",
                    "u": library.NAVIDROME_USER,
                    "p": NAVIDROME_PASSWORD,
                },
                timeout=10,
            )
    except Exception:
        pass


async def _create_navidrome_playlist(job: Job, needs_scan: bool = True):
    """After playlist download, wait for scan and create playlist in Navidrome."""
    if not NAVIDROME_PASSWORD:
        return
    try:
        import logging
        log = logging.getLogger("musicseeker")

        log.info(f"Playlist creation: name='{job.playlist_name}', tracks={len(job.playlist_tracks)}, needs_scan={needs_scan}")

        if needs_scan:
            job.progress_text = "Waiting for Navidrome to index new tracks..."
            await asyncio.sleep(15)
            await _trigger_navidrome_scan()
            await asyncio.sleep(15)

        job.progress_text = "Creating playlist in Navidrome..."
        song_ids = []
        not_found = []
        for track in job.playlist_tracks:
            name = track.get("name", "")
            artist = track.get("artist", "")
            sid = await library.find_song_id(name, artist)
            if sid:
                song_ids.append(sid)
            else:
                not_found.append(f"{artist} - {name}")

        log.info(f"Playlist '{job.playlist_name}': found {len(song_ids)}/{len(job.playlist_tracks)} tracks")
        if not_found:
            log.info(f"Not found in Navidrome: {not_found[:5]}")

        if song_ids:
            ok = await library.create_playlist(job.playlist_name, song_ids)
            log.info(f"createPlaylist result: {ok}")
            job.progress_text = f"Playlist created in Navidrome ({len(song_ids)}/{len(job.playlist_tracks)} tracks)"
        else:
            job.progress_text = "Download complete (could not find tracks in Navidrome for playlist)"
    except Exception as e:
        import traceback
        logging.getLogger("musicseeker").error(f"Playlist creation error: {traceback.format_exc()}")
        job.progress_text = f"Download complete (playlist creation failed: {e})"
