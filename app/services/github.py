import base64
import logging
import re
from datetime import datetime, timezone

import httpx

from app.config import GITHUB_TOKEN, GITHUB_REPO, GITHUB_SCREENSHOT_BRANCH

logger = logging.getLogger(__name__)

API_BASE = "https://api.github.com"
_TIMEOUT = httpx.Timeout(30.0)  # default httpx timeout (5s) is too short for a multi-MB screenshot PUT

_REPO_RE = re.compile(r'^[\w.-]+/[\w.-]+$')
_BRANCH_RE = re.compile(r'^[\w./-]+$')
_ID_RE = re.compile(r'^[0-9a-f]{32}$')


class IssueCreatedUnparseable(Exception):
    """The issue POST succeeded (GitHub returned 2xx) but the response body
    couldn't be parsed for its URL — the issue EXISTS on GitHub, so the caller
    must NOT treat this like an ordinary failure and retry, or it files a
    duplicate irreversible public issue."""

    def __init__(self, status_code: int):
        self.status_code = status_code
        super().__init__(f"Issue created but response unparseable (status {status_code})")


def is_configured() -> bool:
    return bool(
        GITHUB_TOKEN and GITHUB_REPO and _REPO_RE.fullmatch(GITHUB_REPO)
        and GITHUB_SCREENSHOT_BRANCH and _BRANCH_RE.fullmatch(GITHUB_SCREENSHOT_BRANCH)
    )


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def _ensure_branch(client: httpx.AsyncClient) -> None:
    """Make sure GITHUB_SCREENSHOT_BRANCH exists, creating it off the repo's default
    branch if this is the first screenshot upload."""
    resp = await client.get(
        f"{API_BASE}/repos/{GITHUB_REPO}/git/ref/heads/{GITHUB_SCREENSHOT_BRANCH}",
        headers=_headers(),
    )
    if resp.status_code == 200:
        return
    if resp.status_code != 404:
        resp.raise_for_status()

    repo_resp = await client.get(f"{API_BASE}/repos/{GITHUB_REPO}", headers=_headers())
    repo_resp.raise_for_status()
    default_branch = repo_resp.json()["default_branch"]

    ref_resp = await client.get(
        f"{API_BASE}/repos/{GITHUB_REPO}/git/ref/heads/{default_branch}",
        headers=_headers(),
    )
    ref_resp.raise_for_status()
    sha = ref_resp.json()["object"]["sha"]

    create_resp = await client.post(
        f"{API_BASE}/repos/{GITHUB_REPO}/git/refs",
        headers=_headers(),
        json={"ref": f"refs/heads/{GITHUB_SCREENSHOT_BRANCH}", "sha": sha},
    )
    if create_resp.status_code == 422:
        # Branch already exists — another request raced us to create it.
        return
    create_resp.raise_for_status()


async def _upload_screenshot(client: httpx.AsyncClient, report_id: str, data: bytes, ext: str) -> str:
    # report_id here comes from report["id"] read off disk (not the validated path
    # param at the router boundary) — re-check it before it reaches the URL path.
    if not _ID_RE.fullmatch(report_id):
        raise ValueError("Invalid report id")

    path = f"screenshots/{report_id}.{ext}"

    # A retried promote (first attempt uploaded the screenshot but then failed
    # later, e.g. the issue POST) would otherwise 422 here because the path
    # already exists, and that 422 used to get swallowed by the caller's bare
    # except, silently filing the issue with no screenshot. Check first and
    # reuse the existing upload instead of erroring or duplicating it.
    get_resp = await client.get(
        f"{API_BASE}/repos/{GITHUB_REPO}/contents/{path}",
        headers=_headers(),
        params={"ref": GITHUB_SCREENSHOT_BRANCH},
    )
    if get_resp.status_code == 200:
        return get_resp.json()["download_url"]

    resp = await client.put(
        f"{API_BASE}/repos/{GITHUB_REPO}/contents/{path}",
        headers=_headers(),
        json={
            "message": f"chore(feedback): screenshot for {report_id}",
            "content": base64.b64encode(data).decode(),
            "branch": GITHUB_SCREENSHOT_BRANCH,
        },
    )
    resp.raise_for_status()
    return resp.json()["content"]["download_url"]


def _sanitize_cell(value: str) -> str:
    """Strip characters that could break out of a markdown table cell or inject
    formatting — this is user-controlled data (context fields) reaching a GitHub
    issue body. This is sufficient ONLY because every caller below also wraps the
    result in backticks (`` `{value}` ``); stripping backticks/pipes/newlines here
    does not strip `<`, `>`, `[`, `]`, so if a future edit removes the surrounding
    backticks this stops being safe and needs revisiting."""
    return (value or "").replace("`", "").replace("|", "").replace("\n", " ").replace("\r", " ").strip()


def _fence(text: str) -> str:
    """User text goes in a fence so markdown/@mentions/cross-refs can't fire and
    a crafted description can't forge the metadata table below it."""
    text = (text or "").replace("\r\n", "\n")
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}text\n{text}\n{fence}"


async def create_issue(report: dict, screenshot: tuple[bytes, str] | None, title: str, description: str) -> str:
    """Create a GitHub issue from a feedback report. Raises on HTTP error (router
    translates to 502)."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        screenshot_url = ""
        if screenshot is not None:
            try:
                await _ensure_branch(client)
                data, ext = screenshot
                screenshot_url = await _upload_screenshot(client, report["id"], data, ext)
            except Exception:
                # A screenshot upload failure should never block filing the issue.
                logger.exception("Failed to upload feedback screenshot for %s", report.get("id"))
                screenshot_url = ""

        context = report.get("context") or {}
        reporter = _sanitize_cell(report.get("reporter", ""))
        kind = report.get("kind", "bug")
        type_label = "feature" if kind == "feature" else "bug"
        version = _sanitize_cell(context.get("version", ""))
        page = _sanitize_cell(context.get("page", ""))
        user_agent = _sanitize_cell(context.get("user_agent", ""))
        created_at = report.get("created_at", 0)
        reported_iso = datetime.fromtimestamp(created_at, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        body_parts = []
        if description.strip():
            # Skip the provenance note + fence entirely when there's no user text —
            # otherwise an empty description still renders a "verbatim user text"
            # note above an empty ```text``` block.
            body_parts += [
                "> [!NOTE]",
                "> The block below is verbatim user-submitted text (fenced so it can't forge",
                "> the metadata table, trigger @mentions, or post cross-repo backlinks).",
                "",
                _fence(description),
                "",
            ]
        body_parts += [
            "---",
            "<!-- filed from MusicSeeker in-app feedback -->",
            "| | |",
            "|---|---|",
            f"| **Reporter** | `{reporter}` |",
            f"| **Type** | {type_label} |",
            f"| **App version** | `{version}` |",
            f"| **Page** | `{page}` |",
            f"| **Reported** | {reported_iso} |",
            f"| **User agent** | `{user_agent}` |",
        ]
        if screenshot_url:
            body_parts.append("")
            body_parts.append(f"![screenshot]({screenshot_url})")
        body = "\n".join(body_parts)

        labels = ["enhancement"] if kind == "feature" else ["bug"]

        resp = await client.post(
            f"{API_BASE}/repos/{GITHUB_REPO}/issues",
            headers=_headers(),
            json={"title": title, "body": body, "labels": labels},
        )
        resp.raise_for_status()
        try:
            return resp.json()["html_url"]
        except (KeyError, ValueError) as e:
            # raise_for_status() already passed — the issue EXISTS on GitHub even
            # though we can't read its URL back. Raise a distinct exception so the
            # router knows not to revert the claim (that would let the admin retry
            # and file a duplicate public issue).
            logger.error("GitHub issue created for feedback %s but response unparseable (status %s): %s",
                         report.get("id"), resp.status_code, e)
            raise IssueCreatedUnparseable(resp.status_code) from e
