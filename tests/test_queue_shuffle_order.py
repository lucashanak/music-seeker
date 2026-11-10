"""The shuffle order travels with the queue.

It is saved in the same PUT as the queue because the two only mean anything
together: the order is a list of positions into that queue. A model that drops
the field silently loses the user's running order on every restart.
"""

import json

import pytest

from app.models import QueueState
from app.services import player


ORDER = {"played": [0, 4], "tail": [1, 3, 2]}


def test_queue_state_keeps_the_shuffle_order():
    state = QueueState(
        queue=[{"name": f"t{i}", "artist": "a"} for i in range(5)],
        current_index=2,
        shuffle_order=ORDER,
    )
    assert state.model_dump()["shuffle_order"] == ORDER


def test_a_queue_without_a_shuffle_order_is_still_valid():
    assert QueueState().model_dump()["shuffle_order"] is None


def test_the_order_survives_the_round_trip_to_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(player, "PLAYER_DIR", tmp_path)
    state = QueueState(
        queue=[{"name": "t0", "artist": "a"}],
        current_index=0,
        shuffle_order=ORDER,
    ).model_dump()

    player.save_queue("someone", state, "phone")
    loaded = player.load_queue("someone", "phone")

    assert loaded["shuffle_order"] == ORDER


def test_an_older_saved_queue_loads_without_an_order(tmp_path, monkeypatch):
    """Files written before this field existed must still open."""
    monkeypatch.setattr(player, "PLAYER_DIR", tmp_path)
    (tmp_path / "someone_phone.json").write_text(
        json.dumps({"queue": [{"name": "t0"}], "current_index": 0})
    )

    loaded = player.load_queue("someone", "phone")

    assert loaded["queue"] == [{"name": "t0"}]
    assert loaded.get("shuffle_order") is None
