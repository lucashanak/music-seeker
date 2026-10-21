"""Last.fm's universal placeholder is not a cover, and must not be served as one.

The grey star at .../2a96cbd8b46e442fc41c2b86b821562f.png is what Last.fm
answers with for everything it has no art for. It is a valid URL that loads, so
nothing downstream can tell it apart from a real cover — a Discover tag page
came out as a wall of identical grey stars instead of the card's own empty
state. The only place that can tell is the one that reads the address.
"""
from app.services.lastfm import _pick_image

PLACEHOLDER = (
    "https://lastfm.freetls.fastly.net/i/u/300x300/"
    "2a96cbd8b46e442fc41c2b86b821562f.png"
)
REAL = "https://lastfm.freetls.fastly.net/i/u/300x300/8c1bd1ee8e5a4a0e9b1c0d6f7a2b3c4d.png"


def _img(size, text):
    return {"size": size, "#text": text}


def test_placeholder_is_not_a_cover():
    images = [_img(s, PLACEHOLDER) for s in ("extralarge", "large", "medium")]
    assert _pick_image(images) == ""


def test_real_cover_is_returned_unchanged():
    assert _pick_image([_img("extralarge", REAL)]) == REAL


def test_no_images_at_all():
    assert _pick_image([]) == ""


def test_placeholder_in_the_preferred_size_does_not_hide_a_real_cover():
    # The sizes are a preference order, not a single attempt: a placeholder in
    # extralarge has to be stepped over, not taken as the final answer.
    images = [_img("extralarge", PLACEHOLDER), _img("large", REAL)]
    assert _pick_image(images) == REAL
