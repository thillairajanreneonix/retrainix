"""Phase 0 contract checks (docs/api.md, "Health and catalogue")."""
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import load_agents_config

client = TestClient(create_app())


def test_health_answers_on_both_paths():
    for path in ("/api/health", "/healthz"):
        r = client.get(path)
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        assert "version" in r.json()


def test_public_config_comes_from_agents_yaml():
    cfg = load_agents_config()
    body = client.get("/api/config").json()
    assert body["limits"] == cfg["limits"]
    assert body["qa"]["max_retries"] == cfg["agents"]["teacher_qa"]["thresholds"]["max_retries"]
    assert body["gold_set"]["holdout_count"] == 10


def test_public_config_leaks_no_secret_names():
    text = client.get("/api/config").text.lower()
    for word in ("api_key", "token", "secret", "password"):
        assert word not in text


def test_agents_config_matches_amendment_a1():
    agents = load_agents_config()["agents"]
    assert "annotator_model" in agents and "annotator_sam3" not in agents
    assert agents["teacher_qa"]["thresholds"]["max_retries"] == 2
    assert agents["model_catalogue"]["default_prelabel_recipe"] == "circularnet_rfdetr"
