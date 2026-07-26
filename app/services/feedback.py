import base64
import binascii
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path

from app.config import DATA_DIR

logger = logging.getLogger(__name__)

FEEDBACK_DIR = Path(DATA_DIR) / "feedback"

MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024  # 4 MB, enforced on the decoded bytes
MAX_REPORTS = 200  # cheap cap so this dir can't exhaust the shared /app/data volume
MAX_FEEDBACK_BYTES = 200 * 1024 * 1024  # 200 MB total (json + screenshots) — the
# count cap alone allows ~800MB (200 reports * 4MB screenshot cap), nowhere near
# enough to protect the shared volume that also holds users.json/likes.json/settings.json.

# A "promoting" record older than this is assumed abandoned (crash, cancelled
# request, container restart mid-call) and becomes reclaimable rather than a
# permanent dead end.
_PROMOTING_STALE_SECONDS = 300

_ID_RE = re.compile(r'^[0-9a-f]{32}$')
_SCREENSHOT_NAME_RE = re.compile(r'^[0-9a-f]{32}\.(jpg|png)$')

_ALLOWED_KINDS = {"bug", "feature"}
_ALLOWED_CONTEXT_KEYS = {"page", "version", "user_agent", "url"}


def _ensure_dir():
    FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)


def _valid_id(report_id: str) -> bool:
    return bool(report_id) and bool(_ID_RE.fullmatch(report_id))


def _json_path(report_id: str) -> Path:
    return FEEDBACK_DIR / f"{report_id}.json"


def _decode_screenshot(data_url: str) -> tuple[bytes, str] | None:
    """Decode + validate a data-URL screenshot. Returns (bytes, ext) or None if the
    input isn't a supported image data URL. Raises ValueError only when the decoded
    payload exceeds MAX_SCREENSHOT_BYTES, so the router can map that to a 413."""
    if not data_url:
        return None
    prefix_map = {
        "data:image/jpeg;base64,": "jpg",
        "data:image/png;base64,": "png",
    }
    lowered = data_url.lower()
    ext = None
    b64_data = None
    for prefix, e in prefix_map.items():
        if lowered.startswith(prefix):
            ext = e
            b64_data = data_url[len(prefix):]
            break
    if ext is None:
        return None
    # Bound the ENCODED length before calling b64decode, so the decoded buffer is
    # never allocated for an oversized payload (base64 expands ~4/3, +4 for padding).
    if len(b64_data) > (MAX_SCREENSHOT_BYTES // 3) * 4 + 4:
        raise ValueError("Screenshot too large")
    try:
        raw = base64.b64decode(b64_data, validate=True)
    except (binascii.Error, ValueError):
        return None
    # Backstop: still enforce the decoded-byte cap in case of encoding slack.
    if len(raw) > MAX_SCREENSHOT_BYTES:
        raise ValueError("Screenshot too large")
    if ext == "jpg" and not raw.startswith(b"\xff\xd8\xff"):
        return None
    if ext == "png" and not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    return raw, ext


def create(kind: str, title: str, description: str, screenshot_data_url: str,
           context: dict, reporter: str) -> dict:
    """Validate + persist a new feedback report. Raises ValueError on bad input,
    RuntimeError("storage_unavailable") if the record can't be durably written."""
    if kind not in _ALLOWED_KINDS:
        raise ValueError(f"kind must be one of {sorted(_ALLOWED_KINDS)}")

    title = (title or "").strip()
    if not title:
        raise ValueError("title is required")
    title = title[:120]

    description = (description or "")[:5000]

    # Defensive: context is user-controlled data that ends up embedded in a GitHub
    # issue body, so only pass through a known-safe set of keys, coerced to str.
    clean_context = {}
    for key in _ALLOWED_CONTEXT_KEYS:
        if key in (context or {}):
            clean_context[key] = str(context[key])[:500]

    # A non-empty screenshot that fails to decode (bad prefix / bad base64 / magic
    # byte mismatch) is dropped silently unless we flag it — surface that to the
    # caller so the response can tell the user their screenshot was rejected.
    screenshot_rejected = False
    screenshot_result = None
    if screenshot_data_url:
        screenshot_result = _decode_screenshot(screenshot_data_url)
        if screenshot_result is None:
            screenshot_rejected = True
            logger.warning("Rejected feedback screenshot from %s: undecodable/unsupported image", reporter)

    _ensure_dir()
    report_id = uuid.uuid4().hex
    screenshot_name = ""
    image_path = None
    if screenshot_result:
        raw, ext = screenshot_result
        screenshot_name = f"{report_id}.{ext}"
        image_path = FEEDBACK_DIR / screenshot_name

    record = {
        "id": report_id,
        "kind": kind,
        "title": title,
        "description": description,
        "reporter": reporter,
        "created_at": time.time(),
        "context": clean_context,
        "status": "new",
        "issue_url": "",
        "screenshot": screenshot_name,
        "screenshot_rejected": screenshot_rejected,
    }

    # Non-atomic-create defense: write the image first, but roll it back if the
    # JSON write fails so we never orphan a screenshot that list_all() can't see
    # (it only globs *.json) and the UI can't delete.
    write_ok = False
    try:
        if image_path is not None:
            image_path.write_bytes(screenshot_result[0])
        write_ok = _write_record(report_id, record)
    except OSError:
        logger.exception("Failed to persist feedback screenshot %s", report_id)
        write_ok = False

    if not write_ok:
        if image_path is not None:
            image_path.unlink(missing_ok=True)
        raise RuntimeError("storage_unavailable")

    try:
        _enforce_quota()
    except OSError:
        # A concurrent delete racing path.stat()/delete() here must not turn an
        # already-committed record into a 500 — the client would retry and file
        # a duplicate report even though the first one succeeded.
        logger.warning("Feedback quota enforcement failed after creating %s", report_id)

    return record


def _write_record(report_id: str, record: dict) -> bool:
    """Atomically persist a feedback record via tmp-file + os.replace. Used by
    every writer (create/claim/set_status/mark_promoted) so a mid-write crash
    (this project has a documented OOM history, mem_limit 2g) can never leave a
    truncated JSON file that list_all() would silently skip — which would make
    the report vanish from the admin UI while its files stay on disk, uncounted
    by the quota and undeletable through the API."""
    json_path = _json_path(report_id)
    tmp_path = json_path.with_suffix(".tmp")
    try:
        tmp_path.write_text(json.dumps(record, indent=2))
        os.replace(tmp_path, json_path)  # atomic commit point
    except OSError:
        logger.exception("Failed to write feedback record %s", report_id)
        tmp_path.unlink(missing_ok=True)
        return False
    return True


def _record_bytes(json_path: Path) -> int:
    """Total on-disk size (json + screenshot, if any) of one feedback record."""
    total = json_path.stat().st_size
    record = get(json_path.stem)
    screenshot_name = (record or {}).get("screenshot")
    if screenshot_name and _SCREENSHOT_NAME_RE.fullmatch(screenshot_name):
        shot_path = FEEDBACK_DIR / screenshot_name
        if shot_path.exists():
            total += shot_path.stat().st_size
    return total


def _enforce_quota():
    """Cap on stored feedback data — this dir shares the data volume with
    users.json/likes.json/settings.json, so unbounded growth here risks disk
    exhaustion that could corrupt the user database. Enforces BOTH a count cap
    (MAX_REPORTS) and a total-bytes cap (MAX_FEEDBACK_BYTES, json + screenshots
    combined — a count cap alone doesn't bound disk usage). Evicts oldest-first
    by mtime until both are satisfied."""
    _ensure_dir()
    paths = list(FEEDBACK_DIR.glob("*.json"))
    paths.sort(key=lambda p: p.stat().st_mtime)
    total_bytes = sum(_record_bytes(p) for p in paths)

    idx = 0
    while idx < len(paths) and (len(paths) - idx > MAX_REPORTS or total_bytes > MAX_FEEDBACK_BYTES):
        path = paths[idx]
        evicted_bytes = _record_bytes(path)
        logger.info("Evicting feedback record %s (quota)", path.stem)
        delete(path.stem)
        total_bytes -= evicted_bytes
        idx += 1


def list_all() -> list[dict]:
    _ensure_dir()
    reports = []
    for path in FEEDBACK_DIR.glob("*.json"):
        try:
            reports.append(json.loads(path.read_text()))
        except (json.JSONDecodeError, OSError):
            # Silently-skipped corrupt/truncated records are otherwise undiagnosable
            # (this project has a documented OOM/partial-write history).
            logger.warning("Skipping unreadable feedback record %s", path)
            continue
    reports.sort(key=lambda r: r.get("created_at", 0), reverse=True)
    return reports


def get(report_id: str) -> dict | None:
    if not _valid_id(report_id):
        return None
    path = _json_path(report_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def screenshot_path(report_id: str) -> Path | None:
    if not _valid_id(report_id):
        return None
    record = get(report_id)
    if not record or not record.get("screenshot"):
        return None
    # Defense in depth: record["screenshot"] comes from disk, so a hand-edited
    # record could otherwise point at e.g. "../../users.json". Validate it the
    # same way as the report id before joining it onto FEEDBACK_DIR.
    if not _SCREENSHOT_NAME_RE.fullmatch(record["screenshot"]):
        logger.warning("Rejected malformed screenshot filename on record %s", report_id)
        return None
    path = FEEDBACK_DIR / record["screenshot"]
    return path if path.exists() else None


def delete(report_id: str) -> bool:
    if not _valid_id(report_id):
        return False
    path = _json_path(report_id)
    if not path.exists():
        return False
    record = get(report_id) or {}
    path.unlink()
    screenshot_name = record.get("screenshot")
    if screenshot_name and _SCREENSHOT_NAME_RE.fullmatch(screenshot_name):
        shot_path = FEEDBACK_DIR / screenshot_name
        if shot_path.exists():
            shot_path.unlink()
    return True


def claim(report_id: str) -> bool:
    """Atomically flip status "new" (or a stale "promoting") -> "promoting".
    Returns False if the record doesn't exist, is already "promoted", or is
    "promoting" but not yet stale — used to close the promote-endpoint TOCTOU
    where two concurrent requests could both pass a plain status check before
    either one calls the (slow) GitHub API, filing duplicate public issues.

    A record can get stuck in "promoting" if the process dies or the request is
    cancelled mid-GitHub-call. Rather than being a permanent dead end, a
    "promoting" record whose promoting_since is older than
    _PROMOTING_STALE_SECONDS is treated as abandoned and can be reclaimed."""
    if not _valid_id(report_id):
        return False
    record = get(report_id)
    if not record:
        return False
    status = record.get("status")
    if status == "promoting":
        promoting_since = record.get("promoting_since") or 0
        if time.time() - promoting_since < _PROMOTING_STALE_SECONDS:
            return False  # actively being promoted elsewhere, not stale yet
    elif status != "new":
        return False  # "promoted" (or any other status) is never claimable
    record["status"] = "promoting"
    record["promoting_since"] = time.time()
    return _write_record(report_id, record)


def set_status(report_id: str, status: str) -> bool:
    """Force the status field directly — used to revert a claim() back to "new"
    if the subsequent GitHub call fails, so the admin can retry."""
    if not _valid_id(report_id):
        return False
    record = get(report_id)
    if not record:
        return False
    record["status"] = status
    return _write_record(report_id, record)


def mark_promoted(report_id: str, issue_url: str) -> bool:
    if not _valid_id(report_id):
        return False
    record = get(report_id)
    if not record:
        return False
    record["status"] = "promoted"
    record["issue_url"] = issue_url
    # The GitHub issue already exists at this point (or is about to) — losing the
    # issue_url here would be worse than a stale local status, so the caller
    # (router) must surface issue_url in the response even when this returns False.
    return _write_record(report_id, record)
