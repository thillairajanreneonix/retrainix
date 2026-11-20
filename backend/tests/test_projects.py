"""Projects and the model catalogue against docs/api.md."""


def test_models_lists_the_one_seeded_record_with_its_licence(client):
    models = {m["id"]: m for m in client.get("/api/models").json()["models"]}
    assert set(models) == {"circularnet_rfdetr"}  # one model since 20 Nov 2026; Ultralytics YOLO was removed
    circularnet = models["circularnet_rfdetr"]
    assert circularnet["licence"] == "Apache-2.0" and circularnet["source_url"]
    assert len(circularnet["classes"]) == 50 and len(set(circularnet["classes"])) == 50
    # The same record pre-labels and is trained, and exports in the format its trainer reads.
    assert circularnet["can_prelabel"] is True and circularnet["can_train"] is True
    assert circularnet["dataset_format"] == "coco_json" and circularnet["input_size"] == 432
    seed = circularnet["seed"]
    assert (seed["decoder"], seed["input_size"], seed["first_class_index"]) == ("rfdetr_seg", 432, 1)
    assert seed["variant"] == "RFDETRSegMedium" and seed["onnx_key"] and seed["pt_key"]
    for model in models.values():
        # A value the source does not state is null and listed - never invented.
        for field in model["unverified_fields"]:
            assert model[field] is None


def test_create_project_normalises_classes_and_starts_in_model_selected(client, project):
    assert project["id"].startswith("p_")
    assert project["classes"] == ["glass", "plastic", "metal"]
    assert project["state"] == "model_selected"
    assert project["counts"]["frames"] == 0
    assert project["retrain_interval_hours"] is None
    listed = client.get("/api/projects").json()["projects"]
    assert [p["id"] for p in listed] == [project["id"]]
    assert client.get(f"/api/projects/{project['id']}").json()["name"] == "Mixed belt"


def test_create_project_rejects_bad_input_with_the_error_shape(client):
    base = {"name": "x", "classes": ["a"], "recipe": "circularnet_rfdetr",
            "prelabel_recipe": "circularnet_rfdetr"}  # fmt: skip
    cases = [
        {**base, "classes": []},
        {**base, "classes": ["a", "A"]},
        {**base, "recipe": "ultralytics_yolo"},  # removed from the product: no such recipe to train
        {**base, "recipe": "nope"},
        {**base, "prelabel_recipe": "ultralytics_yolo"},  # ... and none to pre-label with
        {**base, "prelabel_recipe": "nope"},
        {**base, "class_map": {"Glass_Bottle": "glass"}},  # glass is not a project class
        {**base, "class_map": {"Shard": "a"}},  # Shard is not a class of the pre-labelling model
    ]
    for body in cases:
        r = client.post("/api/projects", json=body)
        assert r.status_code == 422, body
        assert set(r.json()["error"]) == {"code", "message"}
    assert client.get("/api/projects").json()["projects"] == []  # a refused request leaves nothing behind
    assert client.post("/api/projects", json=base).status_code == 201  # the base itself is a valid project


def test_unknown_project_and_unknown_api_path_are_json_404s(client):
    for path in ("/api/projects/p_missing", "/api/does-not-exist"):
        r = client.get(path)
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "not_found"


def test_schedule_respects_the_minimum_interval(client, project):
    pid = project["id"]
    assert client.put(f"/api/projects/{pid}/schedule",
                      json={"retrain_interval_hours": 0.1}).status_code == 422  # fmt: skip
    ok = client.put(f"/api/projects/{pid}/schedule", json={"retrain_interval_hours": 6})
    assert ok.json()["retrain_interval_hours"] == 6
    off = client.put(f"/api/projects/{pid}/schedule", json={"retrain_interval_hours": None})
    assert off.json()["retrain_interval_hours"] is None
