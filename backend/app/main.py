"""Retrainix API. Contract: docs/api.md."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import errors
from .routes import assets, live, projects, qa, train, work
from .settings import get_settings, load_agents_config, load_models


def create_app() -> FastAPI:
    settings = get_settings()
    agents = load_agents_config()  # fail at start-up, not on the first request
    load_models()

    app = FastAPI(title="Retrainix API", version=settings.app_version)
    errors.install(app)

    def health() -> dict[str, str]:
        return {"status": "ok", "version": settings.app_version}

    # /api/health is the one to rely on: Cloud Run answers /healthz itself.
    app.add_api_route("/api/health", health, methods=["GET"], tags=["health"])
    app.add_api_route("/healthz", health, methods=["GET"], tags=["health"])

    @app.get("/api/config", tags=["health"])
    def public_config() -> dict:
        """Limits and thresholds the UI displays. No secrets, no model keys."""
        qa = agents["agents"]["teacher_qa"]["thresholds"]
        return {
            "product": agents["product"],
            "region": settings.gcp_region,
            "limits": agents["limits"],
            "qa": {
                "holdout_iou_min": qa["holdout_iou_min"],
                "max_retries": qa["max_retries"],
            },
            "gold_set": agents["agents"]["data_intake"]["gold_set"],
            "schedule": agents["agents"]["orchestrator"]["schedule"],
        }

    app.include_router(projects.router)
    app.include_router(assets.router)
    app.include_router(work.router)
    app.include_router(qa.router)
    app.include_router(train.router)
    app.include_router(live.router)
    if settings.blob_backend == "local":
        app.include_router(assets.local_router)
        app.include_router(train.local_router)

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"],
                   include_in_schema=False)  # fmt: skip
    def unknown_api(path: str) -> JSONResponse:
        # Without this an unknown /api path would fall through to the page below.
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "not_found", "message": f"/api/{path} does not exist"}},
        )

    # The built frontend, when present (it is in the container; usually not on a laptop,
    # where Vite serves it instead).
    static_dir = settings.static_dir
    if (static_dir / "index.html").is_file():
        assets_dir = static_dir / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            candidate = (static_dir / path).resolve()
            if path and candidate.is_file() and static_dir.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(static_dir / "index.html")

    return app


app = create_app()
