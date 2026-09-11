"""Choosing *which* YouTube result to use for a track.

A track search on YouTube rarely has one obvious answer. The top hit is often
region- or label-blocked, and the rest of the page mixes the real thing with
lyric videos, live recordings, karaoke backing tracks and covers. Both the
player and the downloader need the same judgement — "of these results, which do
we try, and in what order" — so it lives here instead of being duplicated as
two keyword lists that drift apart.

Two deliberate design choices:

* **Demote, never drop.** A live take is a poor substitute for the studio
  version but a far better one than silence, and for some tracks the only
  playable upload *is* the live one. Unwanted variants go to the back of the
  queue and are still tried if nothing better resolves.
* **A term the user asked for stops being a penalty.** "Live and Let Die"
  contains the word "live"; so does a deliberate search for an unplugged
  session. Any keyword already present in the query is dropped from the filter
  for that search, so we never penalise every single result equally.
"""
import asyncio
import re
import unicodedata

# Word-boundary patterns, matched against a case- and diacritic-folded title.
# Kept deliberately short: every addition is a chance to demote the correct
# result, and "remix", "acoustic" or "edit" are often what a track actually is.
_DEMOTE: dict[str, re.Pattern] = {
    "live": re.compile(r"\blive\b|\bkoncert\w*\b|\ben\s+vivo\b|\ben\s+directo\b"),
    "karaoke": re.compile(r"\bkaraoke\w*\b|\bbacking\s+track\b|\bplayback\b"),
    "cover": re.compile(r"\bcover(ed)?\b|\bcovers\b"),
}

_YT_WATCH = "https://www.youtube.com/watch?v="


def _fold(text: str) -> str:
    """Lowercase and strip diacritics so matching survives "Kóncert" / "LIVE"."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


def _active_terms(query: str) -> list[re.Pattern]:
    """The penalties that still apply once the query's own wording is excluded."""
    folded = _fold(query)
    return [p for p in _DEMOTE.values() if not p.search(folded)]


def is_unwanted(title: str, query: str) -> bool:
    """Whether `title` looks like a variant the user did not ask for."""
    folded = _fold(title)
    return any(p.search(folded) for p in _active_terms(query))


def rank(candidates: list[dict], query: str) -> list[dict]:
    """Preferred results first, demoted ones after, original order within each.

    YouTube's own relevance ordering is good; this only moves the variants we
    would rather not hear to the back of it.
    """
    terms = _active_terms(query)
    preferred, demoted = [], []
    for cand in candidates:
        folded = _fold(cand.get("title", ""))
        (demoted if any(p.search(folded) for p in terms) else preferred).append(cand)
    return preferred + demoted


async def search(query: str, limit: int = 5, timeout: float = 20) -> list[dict]:
    """Top `limit` YouTube matches as `{"title", "id", "url"}`, in relevance order.

    `--flat-playlist` makes this a single search request with no per-video
    extraction, so it costs about a second regardless of `limit` — cheap enough
    to always run before picking, and it's the only way to see the titles the
    ranking needs. Availability is *not* known at this point; a candidate can
    still turn out to be blocked when its audio URL is extracted.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp", "--flat-playlist", "--no-warnings",
            "--print", "%(id)s\t%(title)s", f"ytsearch{limit}:{query}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except Exception:
        return []
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return []
    out = []
    for line in (stdout or b"").decode(errors="replace").splitlines():
        video_id, _, title = line.strip().partition("\t")
        if video_id and video_id != "NA":  # yt-dlp prints NA for a missing field
            out.append({"id": video_id, "title": title, "url": _YT_WATCH + video_id})
    return out
