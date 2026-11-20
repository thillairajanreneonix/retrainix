"""Configuration: environment variables (plan.md section 9) and config/agents.yaml.

Nothing tunable lives in code. Thresholds, limits and model ids come from
config/agents.yaml; deployment values and secrets come from the environment.
"""
from __future__ import annotations

import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    gcp_project_id: str = ""
    gcp_region: str = "asia-south1"
    gcs_bucket: str = ""
    gemini_location: str = "global"
    # Set (from Secret Manager) to call Gemini with a Google AI Studio key instead of Vertex AI.
    gemini_api_key: str = ""
    gemini_model_bulk: str = ""
    gemini_model_hard: str = ""

    # Backends. The defaults need no cloud access, so tests and a laptop run offline;
    # the deploy script sets the cloud values.
    store_backend: Literal["memory", "firestore"] = "memory"
    blob_backend: Literal["local", "gcs"] = "local"
    # inline = a thread in this process; sync = inside the request (tests only);
    # cloud_run = one execution of the worker job per job.
    job_runner: Literal["inline", "sync", "cloud_run"] = "inline"
    worker_job_name: str = "retrainix-worker"
    # The same code in an image that also has the training framework, with more CPU.
    trainer_job_name: str = "retrainix-trainer"
    # /internal/tick accepts only a Google-signed token for this audience and account.
    # Both empty = a laptop, where the endpoint is open.
    tick_audience: str = ""
    tick_service_account: str = ""
    local_data_dir: Path = Path(tempfile.gettempdir()) / "retrainix-data"

    # Where the runtime agent rules, the seeded model records and the built frontend
    # live. Overridable so the container and the tests can point somewhere else.
    agents_config_path: Path = REPO_ROOT / "config" / "agents.yaml"
    models_config_path: Path = REPO_ROOT / "config" / "models.yaml"
    static_dir: Path = REPO_ROOT / "frontend" / "dist"

    # Set by the deploy script; "dev" on a laptop.
    app_version: str = "dev"


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def load_agents_config(path: Path | None = None) -> dict[str, Any]:
    """Parse config/agents.yaml once. Raises if it is missing - the app must not
    start with silent defaults for thresholds and caps."""
    path = path or get_settings().agents_config_path
    with open(path, encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict) or "agents" not in data:
        raise ValueError(f"{path} is not a Retrainix agents config")
    return data


@lru_cache
def load_models(path: Path | None = None) -> list[dict[str, Any]]:
    """Seeded model records (docs/schemas.md section 4)."""
    path = path or get_settings().models_config_path
    with open(path, encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return list(data["models"])
