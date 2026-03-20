import os
import jobs

_settings = {
    "default_format": os.environ.get("DEFAULT_FORMAT", "flac"),
    "default_method": os.environ.get("DEFAULT_METHOD", "spotdl"),
    "max_concurrent": int(os.environ.get("MAX_CONCURRENT", "10")),
    "navidrome_password": os.environ.get("NAVIDROME_PASSWORD", ""),
}


def get_all() -> dict:
    return {**_settings, "navidrome_password": "***" if _settings["navidrome_password"] else ""}


def update(data: dict) -> dict:
    for key, value in data.items():
        if key in _settings:
            _settings[key] = value

    # Apply max_concurrent change
    if "max_concurrent" in data:
        jobs.update_semaphore(int(data["max_concurrent"]))

    # Apply navidrome password change
    if "navidrome_password" in data:
        import downloader
        import library
        downloader.NAVIDROME_PASSWORD = data["navidrome_password"]
        library.NAVIDROME_PASSWORD = data["navidrome_password"]

    return get_all()
