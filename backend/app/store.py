"""Document store behind one small interface (docs/schemas.md section 3).

Two implementations: Firestore in the cloud, and an in-process dictionary for tests and
laptops. Paths are Firestore-style: "projects/p1/images/f1". Documents come back with
their id under "id". Timestamps are stored as ISO 8601 UTC strings.
"""
from __future__ import annotations

import copy
import threading
from datetime import UTC, datetime
from typing import Any, Protocol


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Store(Protocol):
    def get(self, path: str) -> dict[str, Any] | None: ...

    def set(self, path: str, data: dict[str, Any]) -> None: ...

    def update(self, path: str, data: dict[str, Any]) -> None:
        """Merge fields. Keys may be dotted ("progress.done") to reach into a map."""

    def increment(self, path: str, fields: dict[str, int]) -> None:
        """Atomically add to numeric fields. Keys may be dotted ("counts.frames")."""

    def list(
        self,
        collection: str,
        where: dict[str, Any] | None = None,
        limit: int | None = None,
        start_after: str | None = None,
        descending: bool = False,
    ) -> list[dict[str, Any]]:
        """Documents of one collection ordered by id, optionally filtered by equality."""

    def set_many(self, items: list[tuple[str, dict[str, Any]]]) -> None: ...


def _set_dotted(doc: dict[str, Any], key: str, value: Any) -> None:
    parts = key.split(".")
    for part in parts[:-1]:
        doc = doc.setdefault(part, {})
    doc[parts[-1]] = value


def _get_dotted(doc: dict[str, Any], key: str) -> Any:
    for part in key.split("."):
        if not isinstance(doc, dict):
            return None
        doc = doc.get(part)
    return doc


class MemoryStore:
    def __init__(self) -> None:
        self._docs: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()

    def get(self, path: str) -> dict[str, Any] | None:
        with self._lock:
            doc = self._docs.get(path)
            return None if doc is None else {**copy.deepcopy(doc), "id": path.rsplit("/", 1)[-1]}

    def set(self, path: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._docs[path] = copy.deepcopy({k: v for k, v in data.items() if k != "id"})

    def update(self, path: str, data: dict[str, Any]) -> None:
        with self._lock:
            doc = self._docs[path]
            for key, value in data.items():
                _set_dotted(doc, key, copy.deepcopy(value))

    def increment(self, path: str, fields: dict[str, int]) -> None:
        with self._lock:
            doc = self._docs[path]
            for key, delta in fields.items():
                _set_dotted(doc, key, (_get_dotted(doc, key) or 0) + delta)

    def list(self, collection, where=None, limit=None, start_after=None, descending=False):
        prefix = collection.rstrip("/") + "/"
        with self._lock:
            ids = sorted(
                (
                    p[len(prefix):]
                    for p in self._docs
                    if p.startswith(prefix) and "/" not in p[len(prefix):]
                ),
                reverse=descending,
            )
            out = []
            for doc_id in ids:
                if start_after is not None and (
                    doc_id >= start_after if descending else doc_id <= start_after
                ):
                    continue
                doc = self._docs[prefix + doc_id]
                if where and any(_get_dotted(doc, k) != v for k, v in where.items()):
                    continue
                out.append({**copy.deepcopy(doc), "id": doc_id})
                if limit is not None and len(out) >= limit:
                    break
            return out

    def set_many(self, items):
        for path, data in items:
            self.set(path, data)


class FirestoreStore:
    def __init__(self, project_id: str) -> None:
        from google.cloud import firestore  # noqa: PLC0415 - only needed in the cloud

        self._fs = firestore
        self._db = firestore.Client(project=project_id)

    def get(self, path: str) -> dict[str, Any] | None:
        snap = self._db.document(path).get()
        return {**snap.to_dict(), "id": snap.id} if snap.exists else None

    def set(self, path: str, data: dict[str, Any]) -> None:
        self._db.document(path).set({k: v for k, v in data.items() if k != "id"})

    def update(self, path: str, data: dict[str, Any]) -> None:
        self._db.document(path).update(data)

    def increment(self, path: str, fields: dict[str, int]) -> None:
        self._db.document(path).update({k: self._fs.Increment(v) for k, v in fields.items()})

    def list(self, collection, where=None, limit=None, start_after=None, descending=False):
        from google.cloud.firestore_v1.base_query import FieldFilter  # noqa: PLC0415

        ref = self._db.collection(collection)
        query = ref
        for key, value in (where or {}).items():
            query = query.where(filter=FieldFilter(key, "==", value))
        query = query.order_by("__name__")
        if descending:
            # Firestore refuses "order by id, descending" without an extra index (it
            # answered 500 on the live project, 20 Nov). The collections read newest-first
            # - jobs, assets, events - are small, so they are reversed here instead.
            docs = [{**snap.to_dict(), "id": snap.id} for snap in query.stream()]
            docs.reverse()
            if start_after is not None:
                docs = [d for d in docs if d["id"] < start_after]
            return docs if limit is None else docs[:limit]
        if start_after is not None:
            query = query.start_after({"__name__": ref.document(start_after)})
        if limit is not None:
            query = query.limit(limit)
        return [{**snap.to_dict(), "id": snap.id} for snap in query.stream()]

    def set_many(self, items):
        for start in range(0, len(items), 400):  # Firestore caps a batch at 500 writes
            batch = self._db.batch()
            for path, data in items[start:start + 400]:
                batch.set(self._db.document(path), {k: v for k, v in data.items() if k != "id"})
            batch.commit()
