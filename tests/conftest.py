"""Test-suite environment.

Importing the app package resolves DATA_DIR at import time and creates it, which
defaults to /app/data — so collecting these tests outside the container failed
with PermissionError before any test ran. Point the paths at a temp directory
here, where it takes effect before the first `from app...` import.
"""
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="music-seeker-tests-")
os.environ.setdefault("DATA_DIR", os.path.join(_TMP, "data"))
os.environ.setdefault("MUSIC_DIR", os.path.join(_TMP, "music"))
os.makedirs(os.environ["DATA_DIR"], exist_ok=True)
os.makedirs(os.environ["MUSIC_DIR"], exist_ok=True)
