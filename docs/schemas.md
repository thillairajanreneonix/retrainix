# schemas.md - stored shapes

Contract for everything Retrainix stores. Implements `plan.md` section 3 as amended by
section 0 (A1). Owner: architect-lead. Code follows this file; if code needs something
different, this file changes first.

All timestamps are UTC, ISO 8601. All ids are lowercase strings. Counts are integers and are
always stored beside any rate derived from them.

## 1. Cloud Storage layout

```
gs://<GCS_BUCKET>/projects/<project_id>/
   gold/images/<image_id>.<ext>        human-labelled images - READ-ONLY after import
   gold/labels/<image_id>.json         master label format, source = gold
   raw/<asset_id>/<original filename>  uploaded videos and image folders, as uploaded
   frames/<image_id>.jpg               frames sampled from video, original resolution
   labels/<image_id>/r<round>.json     master label format, one file per round (never overwritten)
   datasets/v<n>/                      compiled, immutable dataset version
   weights/v<n>/                       model version: best weights, exported ONNX, metrics.json
   reports/v<n>/report.json            evaluation report for model version n
gs://<GCS_BUCKET>/seed/<recipe>/       starting weights for each recipe (uploaded once)
```

Originals are never resized in storage. Resizing happens at export or train time.

## 2. Master label format (one JSON per image, per round)

```json
{
  "image_id": "f_000123",
  "width": 1280,
  "height": 800,
  "round": 0,
  "label_model": {"recipe": "circularnet_rfdetr", "version": 2, "profile": "default"},
  "objects": [
    {
      "id": "o1",
      "class": "glass",
      "bbox_xyxy": [412.0, 120.5, 498.0, 201.0],
      "polygon_xy": [[415.0, 122.0], [497.0, 130.5], [480.0, 200.0]],
      "mask_rle": null,
      "source": "model",
      "score": 0.91,
      "round": 0
    }
  ]
}
```

- `source` is one of `gold`, `model`, `human`. (`sam3` from the frozen plan is retired by A1.1;
  `synthetic` is reserved for the stretch item.)
- `polygon_xy` is the object outline as `[x, y]` points in pixels of the stored original, or
  `null` when the labelling model produced boxes only. It is what the exporters and the UI
  use; `mask_rle` stays in the format for models that only give a raster mask.
- `bbox_xyxy` is in pixels of the stored original. `mask_rle` is COCO RLE (`{"size":[h,w],"counts":"..."}`)
  or `null` when the labelling model produced boxes only.
- `class` must be one of the project's class names. A model class with no mapping is dropped at
  pre-label time and counted in the job's `unmapped_objects`.
- `label_model` is `null` for gold labels.
- A human correction writes a new round file with `source: "human"` on the objects it touched.

## 3. Firestore

Collection paths are relative to the database root.

### `projects/{project_id}`

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `classes` | string[] | fixed at creation; order is the class index used by every export |
| `recipe` | string | `circularnet_rfdetr` - the only recipe since plan.md A2 |
| `prelabel_recipe` | string | recipe used for pre-labelling until the project has its own model version |
| `class_map` | map<string,string> | pre-label model class -> project class; unmapped classes are dropped |
| `class_map_source` | string | `name_match` (filled by the API at creation) or `user` |
| `state` | string | one of `agents.yaml` orchestrator states |
| `retrain_interval_hours` | number or null | null = manual only |
| `last_retrain_at` | timestamp or null | |
| `active_model_version` | integer or null | version used for pre-labelling |
| `counts` | map | `gold_exemplar`, `gold_holdout`, `frames`, `predicted`, `passed`, `human_review`, `human_done`, `rejected`. `frames` counts only `role: "unlabelled"` images. `predicted` is cumulative - frames that have been pre-labelled at least once - and never falls when a frame later passes QA or goes to review, so `frames - predicted` is always the number still waiting for a label |
| `gemini_calls_used` | integer | compared with `limits.gemini_max_calls_per_project` before every call |
| `created_at`, `updated_at` | timestamp | |

### `projects/{project_id}/assets/{asset_id}`

| Field | Type | Notes |
|---|---|---|
| `kind` | string | `video`, `images`, `gold_images`, `gold_labels` |
| `gcs_uri` | string | under `raw/` or `gold/` |
| `session_id` | string | capture session; one per video. Splits are made on this, never on frames |
| `status` | string | `pending` (upload link issued, file not confirmed - never listed by the API), `uploaded`, `processing`, `ready`, `failed` |
| `key` | string | path inside the bucket; `gcs_uri` is the same object as a `gs://` address |
| `filename`, `content_type`, `size_bytes`, `job_id` | | as uploaded; `job_id` is the job the upload started |
| `frames_extracted`, `frames_kept` | integer | kept = after de-dup and blur filter |
| `created_at` | timestamp | |

### `projects/{project_id}/images/{image_id}`

| Field | Type | Notes |
|---|---|---|
| `gcs_uri`, `key` | string | the object as a `gs://` address, and its path inside the bucket |
| `width`, `height` | integer | |
| `timestamp_s` | number | seconds into the source video (frames only) |
| `asset_id`, `session_id` | string | |
| `role` | string | `gold_exemplar`, `gold_holdout`, `unlabelled` |
| `phash` | string | perceptual hash used for de-dup |
| `blur_score` | number | variance of Laplacian |
| `label_status` | string | `none`, `predicted`, `passed`, `failed`, `human_review`, `human_done`, `rejected` |
| `round` | integer | latest label round, 0-based |
| `label_uri` | string or null | latest round file |
| `object_count` | integer | objects in the latest round |

`role` never changes after import. Images with a gold role are never written by any job.

### `projects/{project_id}/verdicts/{verdict_id}`

One per QA decision. Never updated.

| Field | Type | Notes |
|---|---|---|
| `image_id` | string | |
| `round` | integer | |
| `stage` | string | `cheap_check` or `gemini` |
| `verdict` | string | `pass` or `fail` |
| `class_ok` | boolean | |
| `missed_objects` | integer | |
| `bad_masks` | string[] | object ids |
| `hints` | map | `{"class_fixes": [{"object_id": "o3", "class": "metal"}], "retry_profile": "tiled_lowconf", "note": "..."}` |
| `reason` | string | short, human-readable |
| `judge_model` | string | Gemini model id, or `rules` for cheap checks |
| `prompt_version` | string | |
| `label_model` | map | copied from the label file |
| `created_at` | timestamp | |

### `projects/{project_id}/jobs/{job_id}`

| Field | Type | Notes |
|---|---|---|
| `type` | string | `extract_frames`, `import_gold`, `prelabel`, `holdout_check`, `qa`, `compile`, `train`, `evaluate` |
| `status` | string | `queued`, `running`, `succeeded`, `failed`, `cancelled` |
| `dry_run` | boolean | a dry run writes an estimate into `result` and changes nothing else |
| `trigger` | string | `user` or `schedule` |
| `params` | map | type-specific |
| `progress` | map | `{"done": 12, "total": 100}` |
| `result` | map | type-specific; includes the counts behind any number shown |
| `error` | string or null | |
| `execution` | string or null | name of the Google Cloud execution running it |
| `created_at`, `started_at`, `finished_at` | timestamp | |

### `projects/{project_id}/dataset_versions/{n}`

| Field | Type | Notes |
|---|---|---|
| `gcs_prefix` | string | `datasets/v<n>/` |
| `format` | string | `coco_json` |
| `splits` | map | per split: `{"images": 70, "objects": 3400, "sessions": ["..."]}` |
| `label_sources` | map | objects by `source`: `{"model": 3100, "human": 300}` |
| `validated` | boolean | accepted by the target framework's own loader |
| `created_at` | timestamp | |

Gold hold-out images are never in any dataset version.

### `projects/{project_id}/model_versions/{n}`

| Field | Type | Notes |
|---|---|---|
| `recipe` | string | |
| `parent` | string | `seed` or `v<n>` |
| `dataset_version` | integer or null | null for version 0 (the seed weights, evaluated as-is) |
| `weights_uri` | string | |
| `status` | string | `training`, `evaluating`, `ready`, `failed` |
| `trigger` | string | `seed`, `user`, `schedule` |
| `metrics` | map | `map50`, `map50_95`, `per_class_recall`, plus `n_images`, `n_objects`, `eval_set: "gold_holdout"` |
| `train_minutes` | number | |
| `created_at` | timestamp | |

Version 0 is the seed weights scored on the gold hold-out before any training. It is the
baseline the trend chart starts from.

### `projects/{project_id}/events/{event_id}`

| Field | Type | Notes |
|---|---|---|
| `type` | string | `dataset_ready`, `training_done`, `needs_human_review`, `pipeline_failed` |
| `message` | string | |
| `job_id` | string or null | |
| `read` | boolean | |
| `created_at` | timestamp | |

## 4. Model records (seeded, served by `GET /api/models`)

Stored in `config/models.yaml`, not Firestore. A record is listed only when `verified: true`.

| Field | Notes |
|---|---|
| `id` | `circularnet_rfdetr` |
| `name`, `task`, `input_size`, `dataset_format`, `licence`, `min_gpu_memory_gb`, `source_url` | the required fields from `agents.yaml` |
| `verified` | true only when every field above was read from the model's own page |
| `can_prelabel`, `can_train` | which halves of the loop this recipe supports in this build |
| `licence_notice` | text shown in the UI; required for AGPL models |
