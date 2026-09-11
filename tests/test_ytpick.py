"""Which YouTube result we pick, and — more importantly — which we don't demote.

The demotion list is the risky half of this feature: a keyword that fires on a
track whose real title contains it would push the correct result behind a live
recording. These pin both directions.
"""

from app.services import ytpick


def _titles(ranked):
    return [c["title"] for c in ranked]


def _cands(*titles):
    return [{"id": f"id{i}", "title": t, "url": ""} for i, t in enumerate(titles)]


def test_live_karaoke_cover_go_last_relevance_order_kept_inside_groups():
    ranked = ytpick.rank(
        _cands(
            "Christina Aguilera - Loyal Brave True (Live)",
            "Loyal Brave True - Karaoke Version",
            "Christina Aguilera - Loyal Brave True (Official Video)",
            "Loyal Brave True (Lyrics)",
            "Loyal Brave True - cover by SomeSinger",
        ),
        "Christina Aguilera Loyal Brave True",
    )
    assert _titles(ranked)[:2] == [
        "Christina Aguilera - Loyal Brave True (Official Video)",
        "Loyal Brave True (Lyrics)",
    ]
    assert _titles(ranked)[2] == "Christina Aguilera - Loyal Brave True (Live)"


def test_nothing_is_dropped():
    cands = _cands("a (Live)", "b (Karaoke)", "c cover")
    assert len(ytpick.rank(cands, "some song")) == 3


def test_a_term_the_user_asked_for_is_not_a_penalty():
    # Searching for the unplugged session must not bury every live result.
    ranked = ytpick.rank(
        _cands("Nirvana - About A Girl (Live Unplugged)", "Nirvana - About A Girl"),
        "Nirvana About A Girl Live Unplugged",
    )
    assert _titles(ranked)[0] == "Nirvana - About A Girl (Live Unplugged)"


def test_track_whose_own_title_contains_the_keyword():
    # "Live and Let Die" and "Cover Me" are songs, not variants.
    assert not ytpick.is_unwanted("Paul McCartney - Live and Let Die", "Live and Let Die")
    assert not ytpick.is_unwanted("Bruce Springsteen - Cover Me", "Cover Me")


def test_word_boundaries_do_not_fire_on_substrings():
    for title in ("Delivery", "Stayin' Alive", "Oliver's Army", "Discovery"):
        assert not ytpick.is_unwanted(title, "some song"), title


def test_matching_ignores_case_and_diacritics():
    assert ytpick.is_unwanted("Song KARAOKE", "some song")
    assert ytpick.is_unwanted("Písen - Kóncert v Praze", "some song")
