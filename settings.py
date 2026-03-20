import os
import jobs

_settings = {
    "default_format": os.environ.get("DEFAULT_FORMAT", "flac"),
    "default_method": os.environ.get("DEFAULT_METHOD", "spotdl"),
    "max_concurrent": int(os.environ.get("MAX_CONCURRENT", "10")),
    "navidrome_url": os.environ.get("NAVIDROME_URL", "http://navidrome:4533"),
    "navidrome_user": os.environ.get("NAVIDROME_USER", "lucas"),
    "navidrome_password": os.environ.get("NAVIDROME_PASSWORD", ""),
    "spotdl_own_credentials": True,
}


def get_all() -> dict:
    return {**_settings, "navidrome_password": bool(_settings["navidrome_password"])}


def update(data: dict) -> dict:
    for key, value in data.items():
        if key in _settings:
            _settings[key] = value

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

    return get_all()
