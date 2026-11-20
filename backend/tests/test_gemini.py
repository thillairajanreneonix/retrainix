"""The Gemini client: which Google route it takes, and that the key never leaks.

No network: the HTTP session is replaced by one that records the request and answers from a script.
"""
import json

import pytest

from app import gemini, settings

SECRET = "AIza-test-key-123"


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code, self._body = status_code, body
        self.text = json.dumps(body)

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, response):
        self.response, self.requests = response, []

    def post(self, url, json=None, headers=None, timeout=None):
        self.requests.append({"url": url, "headers": headers or {}, "body": json})
        if isinstance(self.response, Exception):
            raise self.response
        return self.response

    def get(self, url, headers=None, params=None, timeout=None):
        self.requests.append({"url": url, "headers": headers or {}})
        return FakeResponse(200, {"models": [
            {"name": "models/gemini-flash-x", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/embed-only", "supportedGenerationMethods": ["embedContent"]},
        ]})  # fmt: skip


def answer(payload):
    return FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}]})


@pytest.fixture
def key_client(monkeypatch):
    """A client on the API-key route, with a trailing newline on the key as a pasted secret has."""
    monkeypatch.setenv("GEMINI_API_KEY", SECRET + "\n")
    monkeypatch.setenv("GEMINI_MODEL_BULK", "gemini-test-flash")
    settings.get_settings.cache_clear()
    gemini._status.update(at=0.0, value=None)

    def make(response):
        client = gemini.GeminiClient()
        session = FakeSession(response)
        client._local.session = session
        return client, session

    yield make
    settings.get_settings.cache_clear()
    gemini._status.update(at=0.0, value=None)


def test_with_a_key_the_call_goes_to_the_gemini_api_with_the_key_in_a_header(key_client):
    client, session = key_client(answer({"verdict": "ok"}))
    assert client.route == "api_key"
    out = client.generate_json([{"text": "check this"}, {"jpeg": b"\xff\xd8fake"}], {"type": "OBJECT"})
    assert out == {"verdict": "ok"}
    request = session.requests[0]
    assert request["url"] == "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-flash:generateContent"
    assert request["headers"] == {"x-goog-api-key": SECRET}  # stripped of the pasted newline
    assert SECRET not in request["url"]  # never in the address, where it would end up in logs
    parts = request["body"]["contents"][0]["parts"]
    assert parts[0] == {"text": "check this"} and parts[1]["inlineData"]["mimeType"] == "image/jpeg"
    assert request["body"]["generationConfig"]["responseMimeType"] == "application/json"


def test_a_refusal_is_reported_without_the_key(key_client):
    refused = FakeResponse(403, {"error": {"message": f"API key {SECRET} is not allowed"}})
    client, _ = key_client(refused)
    with pytest.raises(gemini.GeminiUnavailable) as caught:
        client.generate_json([{"text": "x"}], {"type": "OBJECT"})
    assert "403" in str(caught.value) and SECRET not in str(caught.value) and "<key>" in str(caught.value)

    client, _ = key_client(ConnectionError(f"could not reach host with {SECRET}"))
    with pytest.raises(gemini.GeminiUnavailable) as caught:
        client.ping()
    assert SECRET not in str(caught.value)


def test_an_answer_that_is_not_json_is_invalid_not_unavailable(key_client):
    not_json = FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": "sorry, no"}]}}]})
    client, _ = key_client(not_json)
    with pytest.raises(gemini.InvalidResponse):
        client.generate_json([{"text": "x"}], {"type": "OBJECT"})


def test_without_a_key_the_route_is_vertex_ai(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("GEMINI_MODEL_BULK", "gemini-test-flash")
    monkeypatch.setenv("GCP_PROJECT_ID", "some-project")
    settings.get_settings.cache_clear()
    monkeypatch.setattr("google.auth.default", lambda scopes=None: (object(), "some-project"))
    client = gemini.GeminiClient()
    assert client.route == "vertex" and client._headers() == {}
    assert client._url("generateContent") == (
        "https://aiplatform.googleapis.com/v1/projects/some-project/locations/global"
        "/publishers/google/models/gemini-test-flash:generateContent"
    )
    settings.get_settings.cache_clear()


def test_status_says_which_route_and_remembers_the_answer(key_client, monkeypatch):
    calls = []

    def fake_ping(self):
        calls.append(1)

    monkeypatch.setattr(gemini.GeminiClient, "ping", fake_ping)
    first = gemini.status()
    assert (first["ok"], first["route"], first["model"], first["error"]) == (True, "api_key", "gemini-test-flash", None)
    assert gemini.status() is first and calls == [1]  # the second look made no second call


def test_status_reports_a_refusal_and_lists_the_models_the_key_can_use(key_client, monkeypatch):
    def refused(self):
        raise gemini.GeminiUnavailable("Gemini answered 404: model not found")

    monkeypatch.setattr(gemini.GeminiClient, "ping", refused)
    monkeypatch.setattr(gemini.GeminiClient, "_session", lambda self: FakeSession(None))
    out = gemini.status()
    assert out["ok"] is False and "404" in out["error"] and out["route"] == "api_key"
    assert out["models_available"] == ["gemini-flash-x"]  # only models that can generate
    assert SECRET not in json.dumps(out)
