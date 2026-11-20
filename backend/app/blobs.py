"""File storage behind one small interface (docs/schemas.md section 1).

Keys are paths inside the bucket, e.g. "projects/p1/frames/f1.jpg". Cloud Storage in
the cloud; a local folder (outside OneDrive) for tests and laptops.
"""
from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Protocol
from urllib.parse import quote


class Blobs(Protocol):
    def uri(self, key: str) -> str: ...

    def exists(self, key: str) -> bool: ...

    def size(self, key: str) -> int: ...

    def read_bytes(self, key: str) -> bytes: ...

    def write_bytes(self, key: str, data: bytes, content_type: str) -> None: ...

    def download_to(self, key: str, path: Path) -> None: ...

    def upload_url(self, key: str, content_type: str) -> tuple[str, dict[str, str]]:
        """A URL the browser can PUT the file to, and the headers it must send."""

    def list_keys(self, prefix: str) -> list[str]: ...

    def download_url(self, key: str, filename: str) -> str:
        """A short-lived link the browser can download the file from, saved as `filename`."""


class LocalBlobs:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key: str) -> Path:
        target = (self.root / key).resolve()
        if self.root.resolve() not in target.parents:
            raise ValueError(f"key escapes the data folder: {key}")
        return target

    def uri(self, key: str) -> str:
        return f"local://{key}"

    def exists(self, key: str) -> bool:
        return self.path(key).is_file()

    def size(self, key: str) -> int:
        return self.path(key).stat().st_size

    def read_bytes(self, key: str) -> bytes:
        return self.path(key).read_bytes()

    def write_bytes(self, key: str, data: bytes, content_type: str) -> None:
        target = self.path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def download_to(self, key: str, path: Path) -> None:
        Path(path).write_bytes(self.read_bytes(key))

    def upload_url(self, key: str, content_type: str) -> tuple[str, dict[str, str]]:
        # Served by the API itself in local mode (routes/assets.py).
        return f"/api/_local/upload/{quote(key)}", {"Content-Type": content_type}

    def list_keys(self, prefix: str) -> list[str]:
        base = self.path(prefix.rstrip("/") + "/x").parent
        if not base.is_dir():
            return []
        root = self.root.resolve()
        return sorted(p.resolve().relative_to(root).as_posix() for p in base.rglob("*") if p.is_file())

    def download_url(self, key: str, filename: str) -> str:
        return f"/api/_local/download/{quote(key)}?filename={quote(filename)}"


class GcsBlobs:
    def __init__(self, bucket: str, project_id: str) -> None:
        from google.cloud import storage  # noqa: PLC0415 - only needed in the cloud

        self._bucket_name = bucket
        self._bucket = storage.Client(project=project_id).bucket(bucket)

    def uri(self, key: str) -> str:
        return f"gs://{self._bucket_name}/{key}"

    def exists(self, key: str) -> bool:
        return self._bucket.blob(key).exists()

    def size(self, key: str) -> int:
        blob = self._bucket.get_blob(key)
        return int(blob.size) if blob else 0

    def read_bytes(self, key: str) -> bytes:
        return self._bucket.blob(key).download_as_bytes()

    def write_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self._bucket.blob(key).upload_from_string(data, content_type=content_type)

    def download_to(self, key: str, path: Path) -> None:
        self._bucket.blob(key).download_to_filename(str(path))

    def upload_url(self, key: str, content_type: str) -> tuple[str, dict[str, str]]:
        """V4 signed URL. Cloud Run has no private key, so the signature is made by the
        IAM signBlob API - the service account needs Token Creator on itself."""
        import google.auth  # noqa: PLC0415
        from google.auth.transport.requests import Request  # noqa: PLC0415

        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        credentials.refresh(Request())
        url = self._bucket.blob(key).generate_signed_url(
            version="v4",
            expiration=timedelta(minutes=60),
            method="PUT",
            content_type=content_type,
            service_account_email=credentials.service_account_email,
            access_token=credentials.token,
        )
        return url, {"Content-Type": content_type}

    def list_keys(self, prefix: str) -> list[str]:
        return sorted(b.name for b in self._bucket.list_blobs(prefix=prefix) if not b.name.endswith("/"))

    def download_url(self, key: str, filename: str) -> str:
        import google.auth  # noqa: PLC0415
        from google.auth.transport.requests import Request  # noqa: PLC0415

        credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        credentials.refresh(Request())
        return self._bucket.blob(key).generate_signed_url(
            version="v4",
            expiration=timedelta(minutes=15),
            method="GET",
            response_disposition=f"attachment; filename={filename}",
            service_account_email=credentials.service_account_email,
            access_token=credentials.token,
        )
