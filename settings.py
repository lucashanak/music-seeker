import os
import json
import jobs

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

_defaults = {
    "default_format": os.environ.get("DEFAULT_FORMAT", "flac"),
    "default_method": os.environ.get("DEFAULT_METHOD", "yt-dlp"),
    "search_provider": os.environ.get("SEARCH_PROVIDER", "deezer"),
    "search_fallback": os.environ.get("SEARCH_FALLBACK", ""),
    "podcast_provider": os.environ.get("PODCAST_PROVIDER", "itunes"),
    "max_concurrent": int(os.environ.get("MAX_CONCURRENT", "10")),
    "navidrome_url": os.environ.get("NAVIDROME_URL", "http://navidrome:4533"),
    "navidrome_user": os.environ.get("NAVIDROME_USER", "lucas"),
    "navidrome_password": os.environ.get("NAVIDROME_PASSWORD", ""),
    "slskd_url": os.environ.get("SLSKD_URL", "http://slskd:5030"),
    "slskd_api_key": os.environ.get("SLSKD_API_KEY", ""),
    "recommendation_source": os.environ.get("RECOMMENDATION_SOURCE", "combined"),
    "spotify_refresh_token": "",
}

_settings = {**_defaults}


def _load():
    global _settings
    _settings = {**_defaults}
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE) as f:
                saved = json.load(f)
            for key, value in saved.items():
                if key in _settings:
                    _settings[key] = value
            # Migrate old spotdl method to yt-dlp
            if _settings.get("default_method") == "spotdl":
                _settings["default_method"] = "yt-dlp"
        except (json.JSONDecodeError, OSError):
            pass


def _save():
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(_settings, f, indent=2)


# Load on import
_load()


def get_all() -> dict:
    return {
        **_settings,
        "navidrome_password": bool(_settings["navidrome_password"]),
        "slskd_api_key": bool(_settings["slskd_api_key"]),
        "spotify_refresh_token": bool(_settings["spotify_refresh_token"]),
    }


def update(data: dict) -> dict:
    for key, value in data.items():
        if key in _settings:
            _settings[key] = value

    _save()

    # Apply max_concurrent change
    if "max_concurrent" in data:
        jobs.update_semaphore(int(data["max_concurrent"]))

    # Apply navidrome config changes
    if any(k in data for k in ("navidrome_url", "navidrome_user", "navidrome_password")):
        import downloader
        import library
        if "navidrome_url" in data:
            library.NAVIDROME_URL = data["navidrome_url"]
            downloader.NAVIDROME_URL = data["navidrome_url"]
        if "navidrome_user" in data:
            library.NAVIDROME_USER = data["navidrome_user"]
        if "navidrome_password" in data:
            library.NAVIDROME_PASSWORD = data["navidrome_password"]
            downloader.NAVIDROME_PASSWORD = data["navidrome_password"]

    # Apply slskd config changes
    if any(k in data for k in ("slskd_url", "slskd_api_key")):
        import downloader
        if "slskd_url" in data:
            downloader.SLSKD_URL = data["slskd_url"]
        if "slskd_api_key" in data:
            downloader.SLSKD_API_KEY = data["slskd_api_key"]

    return get_all()
