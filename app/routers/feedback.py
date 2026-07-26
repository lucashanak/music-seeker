import logging
import time

import httpx
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import FileResponse

from app.models import FeedbackRequest, FeedbackPromoteRequest
from app.services import auth, feedback, github

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["feedback"])

# Simple rate limiter: {username: [timestamps]}. Keyed on the authenticated
# username, NOT the client IP like auth.py's login limiter — uvicorn runs without
# --proxy-headers, so behind the nginx proxy every external caller collapses to
# one gateway IP, which would turn this into a single global 5-per-10-min cap for
# the whole user base. This endpoint is already authenticated, so the username is
# unspoofable and is the real unit of abuse. (auth.py's limiter is keyed on IP on
# purpose — it's a pre-auth brute-force guard and only counts *failures*; this one
# is a post-auth abuse-volume guard and counts every attempt.)
_report_attempts: dict[str, list[float]] = {}
_MAX_REPORTS = 5
_WINDOW_SECONDS = 600  # 10 minutes


def _prune_report_attempts(now: float) -> None:
    """Drop keys whose timestamps are all outside the window, so this dict can't
    grow unboundedly with one-shot usernames/attackers."""
    if len(_report_attempts) <= 1000:
        return
    stale = [k for k, ts in _report_attempts.items() if all(now - t >= _WINDOW_SECONDS for t in ts)]
    for k in stale:
        del _report_attempts[k]


@router.post("/feedback")
async def submit_feedback(req: FeedbackRequest, request: Request, user: dict = Depends(auth.get_current_user)):
    username = user["username"]
    now = time.time()
    attempts = [t for t in _report_attempts.get(username, []) if now - t < _WINDOW_SECONDS]
    if len(attempts) >= _MAX_REPORTS:
        raise HTTPException(429, "Too many reports. Try again later.")

    # Count the attempt BEFORE doing work so a 413/422 isn't free — otherwise an
    # attacker can loop oversized/invalid payloads forever without ever hitting
    # the limit.
    attempts.append(now)
    _report_attempts[username] = attempts
    _prune_report_attempts(now)

    try:
        record = feedback.create(
            kind=req.kind,
            title=req.title,
            description=req.description,
            screenshot_data_url=req.screenshot,
            context=req.context,
            reporter=username,
        )
    except ValueError as e:
        if str(e) == "Screenshot too large":
            raise HTTPException(413, "Screenshot too large")
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        if str(e) == "storage_unavailable":
            raise HTTPException(503, "Feedback storage unavailable")
        raise

    return {
        "status": "received",
        "id": record["id"],
        "screenshot_rejected": record.get("screenshot_rejected", False),
    }


@router.get("/feedback")
async def list_feedback(user: dict = Depends(auth.require_admin)):
    reports = []
    for r in feedback.list_all():
        reports.append({
            **{k: v for k, v in r.items() if k != "screenshot"},
            "has_screenshot": bool(r.get("screenshot")),
        })
    return {"reports": reports, "github_configured": github.is_configured()}


@router.get("/feedback/{report_id}/screenshot")
async def get_feedback_screenshot(report_id: str, user: dict = Depends(auth.require_admin)):
    path = feedback.screenshot_path(report_id)
    if not path:
        raise HTTPException(404, "Screenshot not found")
    media_type = "image/png" if path.suffix == ".png" else "image/jpeg"
    return FileResponse(path, media_type=media_type)


@router.delete("/feedback/{report_id}")
async def delete_feedback(report_id: str, user: dict = Depends(auth.require_admin)):
    if not feedback.delete(report_id):
        raise HTTPException(404, "Report not found")
    return {"status": "deleted"}


@router.post("/feedback/{report_id}/promote")
async def promote_feedback(report_id: str, req: FeedbackPromoteRequest, user: dict = Depends(auth.require_admin)):
    record = feedback.get(report_id)
    if not record:
        raise HTTPException(404, "Report not found")
    if record.get("status") == "promoted":
        raise HTTPException(409, "Report already promoted")
    if not github.is_configured():
        raise HTTPException(503, "GitHub not configured")

    # Claim BEFORE the (multi-second) GitHub call so two concurrent promotes
    # (double-click, two admin tabs) can't both pass the status check and both
    # file a public issue + screenshot commit — that would be irreversible.
    # claim() also reclaims a "promoting" record whose claim went stale (crashed
    # or was cancelled mid-call), so this isn't a permanent dead end.
    if not feedback.claim(report_id):
        raise HTTPException(409, "Report already promoted")

    title = req.title if req.title is not None else record.get("title", "")
    description = req.description if req.description is not None else record.get("description", "")

    try:
        # Read inside the try: an OSError here (e.g. the screenshot file vanished)
        # must revert the claim too, same as a GitHub failure — otherwise the
        # report gets stuck in "promoting" forever.
        screenshot = None
        shot_path = feedback.screenshot_path(report_id)
        if shot_path:
            ext = "png" if shot_path.suffix == ".png" else "jpg"
            screenshot = (shot_path.read_bytes(), ext)

        issue_url = await github.create_issue(record, screenshot, title, description)
    except github.IssueCreatedUnparseable as e:
        # The issue POST succeeded — the issue EXISTS on GitHub even though we
        # couldn't read its URL back. Reverting here would let the admin retry
        # and file a DUPLICATE irreversible public issue, so treat this as a
        # successful (if imperfect) promotion instead.
        logger.error("Feedback %s promoted but issue URL unparseable (status %s)",
                     report_id, e.status_code)
        feedback.mark_promoted(report_id, "")
        return {
            "status": "promoted",
            "issue_url": "",
            "warning": "Issue was created but its URL could not be read — check GitHub.",
        }
    except Exception as e:
        # Deliberately broad (not just the httpx/KeyError/ValueError tuple this used
        # to be): an OSError reading the screenshot, or a TypeError from a corrupt
        # created_at timestamp, must revert the claim too, or the report is stuck
        # in "promoting" forever with no way to retry.
        feedback.set_status(report_id, "new")
        if isinstance(e, httpx.HTTPStatusError):
            # Don't forward GitHub's raw response body to the client — it can be a
            # multi-hundred-byte JSON blob dumped straight into a toast. Log it
            # server-side and surface only the status + GitHub's parsed message.
            logger.error("GitHub API error %s promoting feedback %s: %s",
                         e.response.status_code, report_id, e.response.text)
            try:
                gh_message = e.response.json().get("message", "")
            except ValueError:
                gh_message = ""
            detail = f"GitHub API error {e.response.status_code}"
            if gh_message:
                detail += f": {gh_message}"
            raise HTTPException(502, detail)
        logger.error("Failed to promote feedback %s: %s", report_id, e)
        raise HTTPException(502, "GitHub API error: request failed")
    except BaseException:
        # asyncio.CancelledError (admin closes the tab / proxy disconnect during
        # the up-to-30s GitHub call) inherits from BaseException, not Exception,
        # so it bypasses the handler above entirely unless caught separately here.
        feedback.set_status(report_id, "new")
        raise

    if not feedback.mark_promoted(report_id, issue_url):
        # The GitHub issue was already created — losing the URL here would be far
        # worse than a stale local status, so still return success with the URL
        # the admin needs, plus a warning that the local record wasn't updated.
        logger.error("Feedback %s promoted (issue_url=%s) but failed to persist promoted status",
                     report_id, issue_url)
        return {"status": "promoted", "issue_url": issue_url,
                 "warning": "Issue was created, but the local record could not be updated."}
    return {"status": "promoted", "issue_url": issue_url}
