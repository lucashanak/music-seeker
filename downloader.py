import asyncio
import json
import os
import re
import time
import httpx

from jobs import Job, JobStatus, get_semaphore, save_if_finished
from spotify import get_app_token, SPOTIFY_CLIENT_ID
import library

LIDARR_URL = os.environ.get("LIDARR_URL", "http://lidarr:8686")
LIDARR_API_KEY = os.environ.get("LIDARR_API_KEY", "")
MUSIC_DIR = os.environ.get("MUSIC_DIR", "/music")
NAVIDROME_URL = os.environ.get("NAVIDROME_URL", "http://navidrome:4533")
NAVIDROME_PASSWORD = os.environ.get("NAVIDROME_PASSWORD", "")
HOST_MUSIC_DIR = os.environ.get("HOST_MUSIC_DIR", "/mnt/nas/Media/_Music")
DOCKER_NETWORK = os.environ.get("DOCKER_NETWORK", "")

DOCKER_SOCKET = "/var/run/docker.sock"


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


async def _docker_api(method: str, path: str, json_data: dict | None = None, timeout: float = 30) -> httpx.Response:
    """Call Docker Engine API via unix socket."""
    transport = httpx.AsyncHTTPTransport(uds=DOCKER_SOCKET)
    async with httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=timeout) as client:
        if method == "POST":
            return await client.post(path, json=json_data)
        elif method == "DELETE":
            return await client.delete(path)
        else:
            return await client.get(path)


async def _docker_stream_logs(container_id: str, job: Job):
    """Stream container logs via Docker API."""
    transport = httpx.AsyncHTTPTransport(uds=DOCKER_SOCKET)
    async with httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=None) as client:
        async with client.stream("GET", f"/containers/{container_id}/logs?follow=true&stdout=true&stderr=true") as resp:
            buffer = b""
            async for chunk in resp.aiter_bytes():
                buffer += chunk
                while b"\n" in buffer:
                    line_bytes, buffer = buffer.split(b"\n", 1)
                    # Docker multiplexed stream: 8-byte header [type(1) 0 0 0 size(4)]
                    # Strip header if present (first byte is 0x01 stdout or 0x02 stderr)
                    if len(line_bytes) >= 8 and line_bytes[0] in (0, 1, 2):
                        line_bytes = line_bytes[8:]
                    # Remove any remaining non-printable chars
                    text = line_bytes.decode("utf-8", errors="replace")
                    text = re.sub(r'[\x00-\x08\x0e-\x1f]', '', text).strip()
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


async def _run_spotdl(job: Job):
    token = await get_app_token()

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
        "--client-id", SPOTIFY_CLIENT_ID,
        "--auth-token", token,
        "--output", "/music/{artist}/{album}/{title}.{output-ext}",
        "--format", job.format,
        "--threads", "4",
    ]

    create_config = {
        "Image": "spotdl-local",
        "Cmd": cmd,
        "HostConfig": {
            "Binds": [f"{HOST_MUSIC_DIR}:/music"],
            "AutoRemove": False,
        },
    }

    if DOCKER_NETWORK:
        create_config["HostConfig"]["NetworkMode"] = DOCKER_NETWORK

    # Create container
    job.progress_text = "Creating spotDL container..."
    resp = await _docker_api("POST", "/containers/create", json_data=create_config)
    if resp.status_code != 201:
        raise RuntimeError(f"Docker create failed ({resp.status_code}): {resp.text}")

    container_id = resp.json()["Id"]

    try:
        # Start container
        job.progress_text = "Starting download..."
        resp = await _docker_api("POST", f"/containers/{container_id}/start")
        if resp.status_code not in (200, 204):
            raise RuntimeError(f"Docker start failed ({resp.status_code}): {resp.text}")

        # Stream logs for progress
        log_task = asyncio.create_task(_docker_stream_logs(container_id, job))

        # Wait for container to finish
        resp = await _docker_api("POST", f"/containers/{container_id}/wait", timeout=600)
        log_task.cancel()
        try:
            await log_task
        except asyncio.CancelledError:
            pass

        if resp.status_code == 200:
            exit_code = resp.json().get("StatusCode", -1)
            if exit_code != 0:
                raise RuntimeError(f"spotdl exited with code {exit_code}: {job.progress_text}")
        else:
            raise RuntimeError(f"Docker wait failed ({resp.status_code}): {resp.text}")

        # Clean up container after success
        try:
            await _docker_api("DELETE", f"/containers/{container_id}?force=true", timeout=5)
        except Exception:
            pass

    except Exception:
        # Try to stop/remove container on error
        try:
            await _docker_api("POST", f"/containers/{container_id}/stop", timeout=5)
        except Exception:
            pass
        try:
            await _docker_api("DELETE", f"/containers/{container_id}?force=true", timeout=5)
        except Exception:
            pass
        raise

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
