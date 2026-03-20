import io
from shazamio import Shazam

_shazam = Shazam()


def _extract_album(track: dict) -> str:
    """Safely extract album name from Shazam track data."""
    try:
        sections = track.get("sections", [])
        if sections:
            metadata = sections[0].get("metadata", [])
            if metadata:
                return metadata[0].get("text", "")
    except (IndexError, AttributeError):
        pass
    return ""


async def identify_song(audio_data: bytes) -> dict | None:
    """Identify a song from raw audio data using Shazam."""
    result = await _shazam.recognize(audio_data)

    track = result.get("track")
    if not track:
        return None

    # Extract Spotify URL if available
    spotify_url = ""
    for provider in track.get("providers", []):
        if provider.get("type") == "SPOTIFY":
            # Provider actions contain the URI
            for action in provider.get("actions", []):
                uri = action.get("uri", "")
                if "spotify" in uri:
                    spotify_url = uri
                    break

    # Also check hub actions for Spotify
    if not spotify_url:
        for option in track.get("hub", {}).get("options", []):
            for action in option.get("actions", []):
                uri = action.get("uri", "")
                if "spotify" in uri:
                    spotify_url = uri
                    break

    # Build Spotify URL from Shazam's metadata
    # Shazam usually includes a "key" which maps to Shazam's own ID
    # We'll search Spotify for the track instead

    images = track.get("images", {})
    cover = images.get("coverarthq") or images.get("coverart") or ""

    return {
        "name": track.get("title", ""),
        "artist": track.get("subtitle", ""),
        "album": _extract_album(track),
        "image": cover,
        "shazam_url": track.get("url", ""),
        "spotify_url": spotify_url,
        "genre": track.get("genres", {}).get("primary", ""),
        "type": "track",
    }
