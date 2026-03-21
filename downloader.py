import asyncio
import os
import re
import time
import httpx

from jobs import Job, JobStatus, get_semaphore, save_if_finished
import library

LIDARR_URL = os.environ.get("LIDARR_URL", "http://lidarr:8686")
LIDARR_API_KEY = os.environ.get("LIDARR_API_KEY", "")
MUSIC_DIR = os.environ.get("MUSIC_DIR", "/music")
NAVIDROME_URL = os.environ.get("NAVIDROME_URL", "http://navidrome:4533")
NAVIDROME_PASSWORD = os.environ.get("NAVIDROME_PASSWORD", "")


async def run_download(job: Job):
    sem = get_semaphore()
    async with sem:
        job.status = JobStatus.RUNNING
        try:
            downloaded = True
            if job.method == "spotdl":
                downloaded = await _run_spotdl(job)
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


async def _run_spotdl(job: Job):
    from spotify import get_app_token, SPOTIFY_CLIENT_ID

    # For playlists with track data: check library and only download missing tracks
    download_urls = [job.url]
    if job.type == "playlist" and job.playlist_tracks:
        job.progress_text = "Checking library for existing tracks..."
        missing_urls = []
        already_have = 0
        for track in job.playlist_tracks:
            name = track.get("name", "")
            artist = track.get("artist", "")
            url = track.get("url", "")
            if not url:
                continue
            sid = await library.find_song_id(name, artist)
            if sid:
                already_have += 1
            else:
                missing_urls.append(url)
        if already_have > 0:
            job.progress_text = f"Skipping {already_have} tracks already in library, downloading {len(missing_urls)}..."
        if not missing_urls:
            job.progress_text = f"All {already_have} tracks already in library, skipping download"
            return False
        download_urls = missing_urls

    cmd = [
        "spotdl", "download", *download_urls,
        "--output", f"{MUSIC_DIR}/{{artist}}/{{album}}/{{title}}.{{output-ext}}",
        "--format", job.format,
        "--threads", "4",
    ]

    # Optionally pass our app token to spotDL instead of its built-in credentials
    import settings
    if not settings.get_all().get("spotdl_own_credentials", True):
        token = await get_app_token()
        cmd.extend(["--client-id", SPOTIFY_CLIENT_ID, "--auth-token", token])

    job.progress_text = "Starting download..."
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    async for raw_line in proc.stdout:
        text = raw_line.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        text = re.sub(r'[\x00-\x08\x0e-\x1f]', '', text)
        if not text:
            continue
        job.progress_text = text

        m = re.search(r"(\d+)/(\d+)", text)
        if m:
            done, total = int(m.group(1)), int(m.group(2))
            if total > 0:
                job.progress = int((done / total) * 100)

        m2 = re.search(r"(\d+)%", text)
        if m2:
            job.progress = int(m2.group(1))

    exit_code = await proc.wait()
    if exit_code != 0:
        raise RuntimeError(f"spotdl exited with code {exit_code}: {job.progress_text}")

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
