import os

APP_VERSION = "1.12.0"

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
MUSIC_DIR = os.environ.get("MUSIC_DIR", "/music")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("ADMIN_PASS", "")
SYNC_INTERVAL = int(os.environ.get("PODCAST_SYNC_HOURS", "6")) * 3600
RELEASE_CHECK_INTERVAL = 7 * 24 * 3600  # weekly
