"""The served document must keep every node the frontend modules look up by id.

check-index.sh proves the partials and static/index.html AGREE, not that the page is
intact: a partial that lost a block builds a shorter page and the gate stays green.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
ARTIST_IDS = ["artistTop", "playArtistTop", "artistAlbumsHeader", "downloadArtist", "artistAlbums"]


def test_artist_page_nodes_exist_in_partials_and_index():
    partials = "".join(p.read_text() for p in sorted((ROOT / "frontend/partials").glob("*.html")))
    index = (ROOT / "static/index.html").read_text()
    js = (ROOT / "static/js/spotify.js").read_text()
    for i in ARTIST_IDS:
        assert re.search(rf'id="{i}"', partials), f"partials lack #{i}"
        assert re.search(rf'id="{i}"', index), f"index.html lacks #{i}"
    for i in ("artistTop", "playArtistTop", "artistAlbumsHeader"):
        assert f"#{i}" in js
