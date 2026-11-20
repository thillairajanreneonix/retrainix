"""The two Store implementations must behave the same.

The Firestore half needs credentials and talks to the real project, so it only runs when
asked for:

    RETRAINIX_LIVE_FIRESTORE=desktop-application-515217 uv run pytest tests/test_store_parity.py

It exists because the in-memory store once hid a real difference: Firestore refused
"newest first" listing and the live API answered 500 (20 Nov 2026).
"""
import os
import secrets

import pytest

from app.store import FirestoreStore, MemoryStore


def exercise(store, root: str) -> dict:
    items = f"{root}/items"
    for i in range(5):
        store.set(
            f"{items}/i{i}",
            {"n": i, "kind": "even" if i % 2 == 0 else "odd", "nested": {"a": 0}},
        )
    store.update(f"{items}/i1", {"nested.a": 7, "extra": "x"})
    store.increment(f"{items}/i1", {"nested.a": 3, "n": 10})

    def ids(**kwargs):
        return [d["id"] for d in store.list(items, **kwargs)]

    out = {
        "get": store.get(f"{items}/i1"),
        "missing": store.get(f"{items}/nope"),
        "all": ids(),
        "desc": ids(descending=True),
        "desc_limit": ids(descending=True, limit=2),
        "desc_after": ids(descending=True, start_after="i3"),
        "where": ids(where={"kind": "even"}),
        "where_desc": ids(where={"kind": "even"}, descending=True),
        "page1": ids(limit=2),
        "page2": ids(limit=2, start_after="i1"),
        "where_page": ids(where={"kind": "even"}, limit=1, start_after="i0"),
    }
    store.set_many([(f"{items}/b{i}", {"n": i}) for i in range(3)])
    out["after_many"] = len(store.list(items))
    return out


EXPECTED_IDS = {
    "all": ["i0", "i1", "i2", "i3", "i4"],
    "desc": ["i4", "i3", "i2", "i1", "i0"],
    "desc_limit": ["i4", "i3"],
    "desc_after": ["i2", "i1", "i0"],
    "where": ["i0", "i2", "i4"],
    "where_desc": ["i4", "i2", "i0"],
    "page1": ["i0", "i1"],
    "page2": ["i2", "i3"],
    "where_page": ["i2"],
}


def test_memory_store_behaviour():
    out = exercise(MemoryStore(), "_selftest/unit")
    for key, expected in EXPECTED_IDS.items():
        assert out[key] == expected, key
    assert out["get"] == {
        "n": 11, "kind": "odd", "nested": {"a": 10}, "extra": "x", "id": "i1",
    }  # fmt: skip
    assert out["missing"] is None
    assert out["after_many"] == 8


@pytest.mark.skipif(
    not os.environ.get("RETRAINIX_LIVE_FIRESTORE"),
    reason="set RETRAINIX_LIVE_FIRESTORE=<project id> to compare against the real database",
)
def test_firestore_matches_memory():
    root = f"_selftest/{secrets.token_hex(4)}"
    live = FirestoreStore(os.environ["RETRAINIX_LIVE_FIRESTORE"])
    try:
        assert exercise(live, root) == exercise(MemoryStore(), root)
    finally:
        for doc in live._db.collection(f"{root}/items").stream():
            doc.reference.delete()
