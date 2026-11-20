"""The process-wide store and blob storage, chosen from settings."""
from __future__ import annotations

from functools import lru_cache

from .blobs import Blobs, GcsBlobs, LocalBlobs
from .settings import get_settings
from .store import FirestoreStore, MemoryStore, Store


@lru_cache
def get_store() -> Store:
    s = get_settings()
    if s.store_backend == "firestore":
        return FirestoreStore(s.gcp_project_id)
    return MemoryStore()


@lru_cache
def get_blobs() -> Blobs:
    s = get_settings()
    if s.blob_backend == "gcs":
        return GcsBlobs(s.gcs_bucket, s.gcp_project_id)
    return LocalBlobs(s.local_data_dir)


def reset_for_tests() -> None:
    get_store.cache_clear()
    get_blobs.cache_clear()
