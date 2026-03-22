"""Radio module: fetch similar tracks from Deezer, Last.fm, or combined."""

import asyncio
import logging

import lastfm
import search_providers

logger = logging.getLogger(__name__)


def _dedup(tracks: list[dict]) -> list[dict]:
    """Deduplicate tracks by normalized (name, artist)."""
    seen = set()
    result = []
    for t in tracks:
        key = (t.get("name", "").lower().strip(), t.get("artist", "").lower().strip())
        if key not in seen and key[0]:
            seen.add(key)
            result.append(t)
    return result


async def _resolve_lastfm_tracks(tracks: list[dict], provider: str, fallback: str) -> list[dict]:
    """Resolve Last.fm tracks via Deezer search to get cover art and IDs."""
    sem = asyncio.Semaphore(5)

    async def resolve_one(t: dict) -> dict | None:
        async with sem:
            try:
                result = await search_providers.resolve(
                    t["name"], t["artist"], "track", provider=provider, fallback=fallback
                )
                return result
            except Exception:
                return None

    results = await asyncio.gather(*[resolve_one(t) for t in tracks])
    return [r for r in results if r]


async def get_radio_tracks(
    source: str,
    track_name: str = "",
    artist_name: str = "",
    artist_id: str = "",
    limit: int = 25,
) -> list[dict]:
    """Get radio tracks based on source preference.

    source: 'deezer', 'lastfm', or 'combined'
    """
    if source == "deezer":
        return await _get_deezer_radio(artist_id, artist_name, limit)
    elif source == "lastfm":
        return await _get_lastfm_radio(track_name, artist_name, limit)
    else:  # combined
        return await _get_combined_radio(track_name, artist_name, artist_id, limit)


async def _get_deezer_radio(artist_id: str, artist_name: str, limit: int) -> list[dict]:
    """Get radio from Deezer artist radio endpoint."""
    if not artist_id and artist_name:
        # Resolve artist name to Deezer ID
        results = await search_providers.deezer_search(artist_name, "artist", 1)
        if results:
            artist_id = results[0].get("id", "")
    if not artist_id:
        return []
    try:
        tracks = await search_providers.deezer_artist_radio(artist_id)
        return tracks[:limit]
    except Exception as e:
        logger.warning(f"Deezer radio failed: {e}")
        return []


async def _get_lastfm_radio(track_name: str, artist_name: str, limit: int) -> list[dict]:
    """Get radio from Last.fm similar tracks."""
    if not track_name or not artist_name:
        return []
    if not lastfm.LASTFM_API_KEY:
        return []
    try:
        similar = await lastfm.get_similar_tracks(track_name, artist_name, limit)
        if not similar:
            # Fallback: get top tracks from similar artists
            sim_artists = await lastfm.get_similar_artists(artist_name, 5)
            for sa in sim_artists:
                top = await lastfm.get_artist_top_tracks(sa["name"], 5)
                similar.extend(top)
            similar = similar[:limit]
        # Resolve through Deezer for cover art
        resolved = await _resolve_lastfm_tracks(similar, "deezer", "")
        return resolved[:limit]
    except Exception as e:
        logger.warning(f"Last.fm radio failed: {e}")
        return []


async def _get_combined_radio(
    track_name: str, artist_name: str, artist_id: str, limit: int
) -> list[dict]:
    """Combined radio: mix Deezer + Last.fm results."""
    tasks = []
    tasks.append(_get_deezer_radio(artist_id, artist_name, limit))
    if track_name and artist_name and lastfm.LASTFM_API_KEY:
        tasks.append(_get_lastfm_radio(track_name, artist_name, limit))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    all_tracks = []
    for r in results:
        if isinstance(r, list):
            all_tracks.extend(r)

    deduped = _dedup(all_tracks)

    # Interleave: alternate between sources for variety
    if len(results) == 2 and isinstance(results[0], list) and isinstance(results[1], list):
        deezer_tracks = results[0]
        lastfm_tracks = results[1]
        interleaved = []
        i, j = 0, 0
        while i < len(deezer_tracks) or j < len(lastfm_tracks):
            if i < len(deezer_tracks):
                interleaved.append(deezer_tracks[i])
                i += 1
            if j < len(lastfm_tracks):
                interleaved.append(lastfm_tracks[j])
                j += 1
        deduped = _dedup(interleaved)

    return deduped[:limit]
