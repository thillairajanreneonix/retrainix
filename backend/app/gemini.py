"""Gemini, by one of two Google routes (CLAUDE.md Rule 1: Google AI only).

- **API key** (Google AI Studio / the Gemini API) - used when GEMINI_API_KEY is set. The key
  comes from Secret Manager; it is never in the repo, a log or an error message.
- **Vertex AI** with the service account - used otherwise. Measured 20 Nov 2026: both project
  models answer at locations/global and return 404 at asia-south1.

The key route was added on 20 Nov 2026 because Vertex AI began refusing every generation
request for the project ("Request rejected in accordance with our terms of use and policies").
The request and answer shapes are the same on both routes, so nothing else in the app changes.
"""
from __future__ import annotations

import base64
import json
import threading
import time
from typing import Any

from .settings import get_settings

KEY_HOST = "https://generativelanguage.googleapis.com/v1beta"


class InvalidResponse(Exception):
    """Gemini answered, but not with JSON that fits the schema."""


class GeminiUnavailable(Exception):
    """The call itself failed: refused, rate-limited, timed out or unreachable. Not a
    judgement about any label - nothing may be decided from it."""


class GeminiClient:
    def __init__(self, model: str | None = None) -> None:
        s = get_settings()
        self.model = model or s.gemini_model_bulk
        if not self.model:
            raise RuntimeError("GEMINI_MODEL_BULK is not set")
        self._key = s.gemini_api_key.strip()
        self.route = "api_key" if self._key else "vertex"
        self._project, self._location = s.gcp_project_id, s.gemini_location
        self._credentials = None
        if self.route == "vertex":
            import google.auth  # noqa: PLC0415 - only needed on the Vertex route

            self._credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        self._local = threading.local()

    def _session(self) -> Any:
        if not hasattr(self._local, "session"):  # one HTTP session per worker thread
            if self.route == "vertex":
                from google.auth.transport.requests import AuthorizedSession  # noqa: PLC0415

                self._local.session = AuthorizedSession(self._credentials)
            else:
                import requests  # noqa: PLC0415

                self._local.session = requests.Session()
        return self._local.session

    def _url(self, method: str) -> str:
        if self.route == "api_key":
            return f"{KEY_HOST}/models/{self.model}:{method}"
        host = (
            "aiplatform.googleapis.com"
            if self._location == "global"
            else f"{self._location}-aiplatform.googleapis.com"
        )
        return (
            f"https://{host}/v1/projects/{self._project}/locations/{self._location}"
            f"/publishers/google/models/{self.model}:{method}"
        )

    def _headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self._key} if self.route == "api_key" else {}

    def _post(self, body: dict[str, Any], timeout: int) -> dict[str, Any]:
        try:
            response = self._session().post(
                self._url("generateContent"), json=body, headers=self._headers(), timeout=timeout
            )
        except Exception as exc:  # network error or timeout
            raise GeminiUnavailable(f"{type(exc).__name__}: {self._scrub(str(exc))}"[:300]) from exc
        if response.status_code >= 300:
            try:
                detail = response.json()["error"]["message"]
            except Exception:
                detail = response.text[:200]
            raise GeminiUnavailable(f"Gemini answered {response.status_code}: {self._scrub(detail)}"[:300])
        return response.json()

    def _scrub(self, text: str) -> str:
        """An error text must never carry the key, whatever the server echoes back."""
        return text.replace(self._key, "<key>") if self._key else text

    def generate_json(self, parts: list[dict[str, Any]], schema: dict[str, Any]) -> dict[str, Any]:
        """One generateContent call that must return JSON matching `schema`.

        `parts` are {"text": ...} or {"jpeg": bytes}. Raises InvalidResponse when the
        answer is not usable JSON, and GeminiUnavailable when the call itself fails.
        """
        wire_parts = [
            {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(p["jpeg"]).decode()}}
            if "jpeg" in p
            else {"text": p["text"]}
            for p in parts
        ]
        body = {
            "contents": [{"role": "user", "parts": wire_parts}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": schema,
                "temperature": 0,
            },
        }
        answer = self._post(body, timeout=180)
        try:
            candidate = answer["candidates"][0]
            text = "".join(p.get("text", "") for p in candidate["content"]["parts"])
            data = json.loads(text)
        except (KeyError, IndexError, ValueError, TypeError) as exc:
            raise InvalidResponse(f"unusable answer: {exc}") from exc
        if not isinstance(data, dict):
            raise InvalidResponse("the answer is not a JSON object")
        return data

    def ping(self) -> None:
        """The smallest possible generation call. Raises GeminiUnavailable if it is refused."""
        body = {
            "contents": [{"role": "user", "parts": [{"text": "Reply with the single word: ready"}]}],
            "generationConfig": {"maxOutputTokens": 64},
        }
        self._post(body, timeout=60)

    def list_models(self) -> list[str]:
        """Model ids this key may generate with (API key route only). Empty on any failure."""
        if self.route != "api_key":
            return []
        try:
            response = self._session().get(
                f"{KEY_HOST}/models", headers=self._headers(), params={"pageSize": 200}, timeout=30
            )
            models = response.json().get("models", [])
        except Exception:
            return []
        return sorted(
            m["name"].split("/")[-1]
            for m in models
            if "generateContent" in m.get("supportedGenerationMethods", [])
        )


_status: dict[str, Any] = {"at": 0.0, "value": None}
_status_lock = threading.Lock()
STATUS_TTL_SECONDS = 120


def status() -> dict[str, Any]:
    """Can Gemini be used right now, and by which route? One tiny call, remembered for two
    minutes so that opening the page cannot be turned into a stream of paid requests."""
    from .store import now_iso  # noqa: PLC0415

    with _status_lock:
        if _status["value"] is not None and time.time() - _status["at"] < STATUS_TTL_SECONDS:
            return _status["value"]
        value: dict[str, Any] = {"ok": False, "route": None, "model": None, "error": None, "checked_at": now_iso()}
        try:
            client = GeminiClient()
            value.update(route=client.route, model=client.model)
            try:
                client.ping()
                value["ok"] = True
            except GeminiUnavailable as exc:
                value["error"] = str(exc)
                if client.route == "api_key":
                    # If the model id is wrong for this key, say which ones it can use.
                    value["models_available"] = [m for m in client.list_models() if "flash" in m or "pro" in m][:40]
        except Exception as exc:
            value["error"] = f"{type(exc).__name__}: {exc}"[:300]
        _status.update(at=time.time(), value=value)
        return value
