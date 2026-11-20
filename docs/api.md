# api.md - HTTP contract

Contract for the Retrainix backend (FastAPI on Cloud Run). Implements `plan.md` as amended by
section 0 (A1). Owner: architect-lead. Document shapes are in `schemas.md`.

- JSON in, JSON out. No authentication in the MVP (plan section 2), except `/internal/*`.
- One Cloud Run service serves both the API and the built frontend, so the app has one URL.
- Errors: `{"error": {"code": "not_found", "message": "..."}}` with the matching HTTP status.
- Long work never runs in a request. Endpoints that start work return `202` and a job.
- Every rate in a response carries its counts, e.g. `{"pass_rate": 0.84, "n_images": 120}`.

## Health and catalogue

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{"status": "ok", "version": "<git sha or dev>"}`. `/healthz` also answers locally, but on Cloud Run Google's front end intercepts that path (measured 20 Nov), so nothing may depend on it |
| GET | `/api/models` | `{"models": [ModelRecord]}` - verified records only |
| GET | `/api/config` | public limits and thresholds from `agents.yaml` the UI needs to display |

## Projects

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/projects` | `{"name", "classes": [..], "recipe", "prelabel_recipe", "class_map"}` | `201` Project |
| GET | `/api/projects` | | `{"projects": [Project]}` |
| GET | `/api/projects/{pid}` | | Project |
| PUT | `/api/projects/{pid}/schedule` | `{"retrain_interval_hours": 6}` or `null` | Project |

`classes` needs at least one name. `recipe` and `prelabel_recipe` must be listed by `/api/models`
with `can_train` / `can_prelabel` respectively.

## Uploads

Files go straight from the browser to Cloud Storage; a video does not fit through a Cloud Run
request.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/projects/{pid}/uploads` | `{"kind", "filename", "content_type", "size_bytes"}` | `{"asset_id", "upload_url", "method": "PUT", "headers": {...}}` |
| POST | `/api/projects/{pid}/assets/{aid}/complete` | | `202` Job (`extract_frames` or `import_gold`) |
| GET | `/api/projects/{pid}/assets` | | `{"assets": [Asset]}` |

`kind` is `video`, `images` (zip), `gold_images` (zip) or `gold_labels` (zip of YOLO txt +
`classes.txt`, or one COCO json). Gold import fails, with the reason, when there are fewer than
`gold_set.required_images` images or fewer than `min_examples_per_class` of any class.

## Jobs

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/projects/{pid}/jobs` | `{"type", "dry_run": false, "params": {}}` | `202` Job |
| GET | `/api/projects/{pid}/jobs` | `?type=&status=` | `{"jobs": [Job]}` newest first |
| GET | `/api/projects/{pid}/jobs/{jid}` | | Job |
| POST | `/api/projects/{pid}/jobs/{jid}/cancel` | | Job |

Types a user may start: `prelabel`, `holdout_check`, `qa`, `compile`, `train`. `evaluate` always
follows `train`. A request is refused with `409` when the previous step's output does not exist
or a limit in `agents.yaml` would be exceeded; the message says which.

`dry_run: true` returns the job with `result.estimate` filled in (images, Gemini calls, GPU
minutes) and starts nothing. The UI shows this estimate before any bulk run.

## Images, labels and review

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/projects/{pid}/images` | `?status=&role=&limit=50&cursor=` | `{"images": [Image], "next_cursor"}` |
| GET | `/api/projects/{pid}/images/{iid}` | | `{"image": Image, "label": MasterLabel or null, "verdicts": [Verdict]}` |
| GET | `/api/projects/{pid}/images/{iid}/file` | `?w=` optional max width | the image bytes (resized for display only) |
| POST | `/api/projects/{pid}/images/{iid}/review` | `{"action", "objects": [...]}` | `{"image": Image, "label": MasterLabel}` |

`action` is `accept` (keep the label as is), `reject` (drop the image from training) or `fix`
(replace the object list; each object needs `class` and `bbox_xyxy`). A review writes a new
round with `source: "human"`. Reviewing an image with a gold role returns `403`.

## QA summary

| Method | Path | Returns |
|---|---|---|
| GET | `/api/projects/{pid}/qa/summary` | see below |

```json
{
  "holdout": {"mean_iou": 0.78, "threshold": 0.75, "n_images": 10, "n_objects": 412, "passed": true},
  "images": {"total": 300, "predicted": 0, "passed": 251, "human_review": 31, "human_done": 12, "rejected": 6},
  "pass_rate": 0.84, "n_images": 300,
  "rounds": {"0": 230, "1": 15, "2": 6},
  "gemini_calls": {"used": 342, "cap": 2000}
}
```

`holdout` is `null` until a `holdout_check` job has run.

## Models and trend

| Method | Path | Returns |
|---|---|---|
| GET | `/api/projects/{pid}/dataset-versions` | `{"dataset_versions": [DatasetVersion]}` |
| GET | `/api/projects/{pid}/model-versions` | `{"model_versions": [ModelVersion]}` oldest first - this is the trend chart's data |
| GET | `/api/projects/{pid}/model-versions/{n}/weights` | `?format=pt` or `onnx` - `302` to a short-lived download URL |
| GET | `/api/projects/{pid}/model-versions/{n}/report` | the evaluation report JSON |

## Notifications

| Method | Path | Returns |
|---|---|---|
| GET | `/api/projects/{pid}/events` | `?unread=true` - `{"events": [Event]}` newest first |
| POST | `/api/projects/{pid}/events/{eid}/read` | Event |

## Internal

| Method | Path | Caller | Does |
|---|---|---|---|
| POST | `/internal/tick` | Cloud Scheduler, with an OIDC token for the scheduler's service account | For each project with a `retrain_interval_hours`: when the interval has elapsed and approved labels were added since the last model version, start `compile` then `train` with `trigger: "schedule"` |
| POST | `/internal/jobs/{pid}/{jid}/status` | workers | progress and completion updates, if a worker cannot write Firestore directly |

`/internal/*` rejects any request without a valid Google-signed identity token.

## How a job reaches compute

The API writes the job document, then starts one execution of a worker container, passing only
`project_id` and `job_id`. The worker reads everything else from Firestore and `agents.yaml`.
The same container runs wherever the quota allows (Cloud Run job, Compute Engine VM, Vertex AI
custom job), which is why the contract does not name the compute. This replaces the Pub/Sub
fan-out in plan section 3 for the MVP; the job document is the queue.

**To verify against current docs before implementation** (plan section 6): how to start a Cloud
Run job execution with per-execution arguments, and browser upload to Cloud Storage without a
signed URL key. GPU availability is settled: the only open route is a Vertex AI custom job on one
spot T4 (see CLAUDE.md), so `train` jobs go there and every other job type runs on CPU.

## Object shapes

Every object the API returns is its stored document (`schemas.md` section 3) plus `id`, and
`project_id` where the object lives under a project. Timestamps are ISO 8601 strings in UTC.
Examples for the Phase 1 endpoints:

```jsonc
// Project
{
  "id": "p_9f2c1a", "name": "Mixed belt", "classes": ["aluminium", "glass", "plastic"],
  "recipe": "circularnet_rfdetr", "prelabel_recipe": "circularnet_rfdetr", "class_map": {},
  "state": "created", "retrain_interval_hours": null, "last_retrain_at": null,
  "active_model_version": null,
  "counts": {"gold_exemplar": 0, "gold_holdout": 0, "frames": 0, "predicted": 0, "passed": 0,
             "human_review": 0, "human_done": 0, "rejected": 0},
  "gemini_calls_used": 0,
  "created_at": "2026-11-20T09:00:00Z", "updated_at": "2026-11-20T09:00:00Z"
}

// ModelRecord (GET /api/models)
{
  "id": "circularnet_rfdetr", "name": "CircularNet", "task": "instance segmentation",
  "input_size": 432, "dataset_format": "coco_json", "licence": "Apache-2.0",
  "licence_notice": null, "min_gpu_memory_gb": null, "source_url": "https://...",
  "source": "seeded", "unverified_fields": ["min_gpu_memory_gb"],
  "can_prelabel": true, "can_train": false,
  "classes": ["Aluminium_Can", "..."]
}

// POST /api/projects/{pid}/uploads  ->  201
{
  "asset_id": "a_0001",
  "upload_url": "https://storage.googleapis.com/...signed...",   // may be a relative URL in local development
  "method": "PUT",
  "headers": {"Content-Type": "video/mp4"}                        // send exactly these headers with the PUT
}

// Asset
{
  "id": "a_0001", "project_id": "p_9f2c1a", "kind": "video", "filename": "belt.mp4",
  "content_type": "video/mp4", "size_bytes": 27300000, "gcs_uri": "gs://.../raw/a_0001/belt.mp4",
  "session_id": "a_0001", "status": "uploaded", "frames_extracted": 0, "frames_kept": 0,
  "job_id": null, "created_at": "..."
}

// Job
{
  "id": "j_0001", "project_id": "p_9f2c1a", "type": "extract_frames", "status": "running",
  "dry_run": false, "trigger": "user", "params": {"asset_id": "a_0001"},
  "progress": {"done": 40, "total": 120}, "result": {}, "error": null, "execution": null,
  "created_at": "...", "started_at": "...", "finished_at": null
}

// Image
{
  "id": "f_a_0001_000040", "project_id": "p_9f2c1a", "gcs_uri": "gs://.../frames/f_a_0001_000040.jpg",
  "width": 1280, "height": 800, "asset_id": "a_0001", "session_id": "a_0001",
  "role": "unlabelled", "phash": "c3a1...", "blur_score": 212.4,
  "label_status": "none", "round": 0, "label_uri": null, "object_count": 0,
  "timestamp_s": 40.0
}
```

- A seeded model record carries `source: "seeded"` and lists in `unverified_fields` every field
  its own page does not state; the UI shows those as "not stated by the source" and never
  invents a value. This relaxes `agents.yaml` "only verified records are listed" for the two
  seeded records only (plan A1 cut order keeps them when catalogue search is cut).
- `extract_frames` result: `{"frames_extracted": 120, "frames_kept": 97, "dropped_duplicate": 15,
  "dropped_blurry": 8, "video_seconds": 120.4, "sample_every_seconds": 1.0}`.
- Finished jobs are polled, not pushed: the UI re-reads `GET .../jobs/{jid}` every 2 seconds
  while `status` is `queued` or `running`.

## Pre-labelling (plan A1.1)

The project's model labels every frame that has no label yet. Nothing here calls Gemini.

| Method | Path | Body | Returns |
|---|---|---|---|
| PUT | `/api/projects/{pid}/class-map` | `{"class_map": {"<model class>": "<project class>"}}` | Project |
| POST | `/api/projects/{pid}/jobs` | `{"type": "prelabel", "dry_run": false, "params": {}}` | `202` Job |
| GET | `/api/projects/{pid}/images/{iid}` | | `{"image", "label", "verdicts"}` - `label` is the latest MasterLabel, or `null` |

**Class map.** A pre-labelling model has its own class names (`ModelRecord.classes`); the map
says which project class each one becomes. Model classes that are not in the map are dropped
and counted. When a project is created with an empty `class_map`, the API fills it by name:
a model class is mapped when a project class name appears in its material part (the text
before the first `_`, so `Plastics-HDPE_Bottle` -> `plastic`, but `Fiber_Cup-&-glass` is not
`glass`). The project then carries `"class_map_source": "name_match"`; after a `PUT` it is
`"user"`. `PUT` is refused with `422` when a key is not a class of the project's pre-label
model or a value is not a project class, and with `409` once frames have been pre-labelled.

**`prelabel` params** (all optional): `profile` - a key of `annotator_model.profiles` in
`agents.yaml`, default `"default"`; `image_ids` - label only these; otherwise every image with
`label_status: "none"` and `role: "unlabelled"`.

Refused with `409` when the project has no such images, or when another `prelabel` job is
queued or running.

```jsonc
// prelabel job result
{
  "images": 28, "objects": 512, "objects_per_image_mean": 18.3,
  "images_with_no_objects": 2, "unmapped_objects": 40,
  "per_class": {"glass": 200, "plastic": 180, "metal": 132},
  "label_model": {"recipe": "circularnet_rfdetr", "version": 0, "profile": "default"},
  "seconds": 31.2, "seconds_per_image": 1.11
}

// dry run:  result.estimate
{"images": 28, "gemini_calls": 0, "gpu_minutes": 0}

// MasterLabel (schemas.md section 2) as returned inside GET .../images/{iid}
{
  "image_id": "f_a_0001_000040", "width": 1280, "height": 800, "round": 0,
  "label_model": {"recipe": "circularnet_rfdetr", "version": 0, "profile": "default"},
  "objects": [
    {"id": "o1", "class": "glass", "bbox_xyxy": [412.0, 120.5, 498.0, 201.0],
     "polygon_xy": [[415.0, 122.0], [497.0, 130.5], [480.0, 200.0]],   // or null
     "mask_rle": null, "source": "model", "score": 0.91, "round": 0}
  ]
}
```

`label_model.version` is `0` while the project is still on the recipe's seed weights. After
a `prelabel` job each labelled image has `label_status: "predicted"`, its `object_count`, and
`round: 0`; `project.counts.predicted` rises by the number of images labelled, and the project
state moves to `labelling`.

## Review, gold set and the teacher loop (plan section 5, A1.1, A1.6)

Order is fixed: pre-label -> a person makes the gold set -> hold-out check -> Gemini QA -> review
queue. Each step is refused with `409` and a plain reason until the one before it has run.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/projects/{pid}/images/{iid}/review` | `{"action", "objects"}` | `{"image": Image, "label": MasterLabel or null}` |
| GET | `/api/projects/{pid}/gold` | | GoldStatus |
| POST | `/api/projects/{pid}/gold/freeze` | | GoldStatus; `409` with the reasons when not ready |
| POST | `/api/projects/{pid}/jobs` | `{"type": "holdout_check"}` | `202` Job |
| POST | `/api/projects/{pid}/jobs` | `{"type": "qa", "dry_run": false}` | `202` Job |
| GET | `/api/projects/{pid}/qa/summary` | | QaSummary |

### Review

`action` is one of:

- `accept` - the label is right as it stands. `objects` is ignored.
- `fix` - `objects` is the complete corrected list. Each entry is
  `{"id": "o3" or null, "class": "glass", "bbox_xyxy": [x0, y0, x1, y1]}`. An entry with the
  `id` of an existing object keeps that object's outline and score, and becomes `source:
  "human"` only if its class or box changed. An entry with `id: null` is a new object drawn by
  the reviewer: `source: "human"`, `polygon_xy: null`, `score: null`. Objects left out are
  deleted. An empty list is allowed (an empty belt).
- `reject` - the frame is dropped from training. No new label is written.

`accept` and `fix` write the next round of the label, with
`"review": {"by": "human", "action": "accept" | "fix", "at": "<timestamp>"}` at label level, and
set `label_status: "human_done"`. `reject` sets `rejected`. A frame can be reviewed again.
Reviewing a gold image returns `403`; an image with no label yet returns `409`.

### Gold set

The gold set is made by a person in this app: they review pre-labelled frames (`accept` /
`fix`), then freeze 30 of them. After the freeze those images are read-only for every job.

```jsonc
// GoldStatus
{
  "frozen": false,
  "required_images": 30, "exemplar_count": 20, "holdout_count": 10, "min_examples_per_class": 5,
  "reviewed_images": 12,                              // human_done frames available
  "objects_per_class": {"glass": 40, "ceramic": 3},   // in those frames; every project class is listed
  "ready_to_freeze": false,
  "blocking": ["12 of 30 frames have been checked by a person", "ceramic has 3 of 5 examples"],
  "gold_exemplar": 0, "gold_holdout": 0,
  "holdout_note": null
}
```

On freeze: the reviewed frames are ordered by capture session, then time. The last 10 become
the hold-out, the first 20 the exemplars, and any in between stay ordinary reviewed frames -
so the hold-out is one block of time, not frames scattered between exemplars. Their role
becomes `gold_holdout` / `gold_exemplar`, `label_status` becomes `"gold"`, every object's
`source` becomes `"gold"`, and they leave `counts.frames` and `counts.predicted`.
`holdout_note` then states which session and time range the hold-out covers.

### Hold-out check (teacher loop step A) - also the baseline of the accuracy trend

Refused with `409` until the gold set is frozen. The project's current model labels the 10
hold-out images and is scored against the human labels.

```jsonc
// holdout_check job result - also stored as project.holdout and as model version 0
{
  "mean_iou": 0.81, "threshold": 0.75, "passed": true,
  "n_images": 10, "n_objects_gold": 231, "n_objects_model": 228, "matched": 214,
  "precision": 0.94, "recall": 0.93, "class_agreement": 0.71,
  "map50": 0.62, "map50_95": 0.48,
  "per_class_recall": {"glass": {"recall": 0.80, "n": 50}},
  "label_model": {"recipe": "circularnet_rfdetr", "version": 0, "profile": "default"},
  "eval_set": "gold_holdout"
}
```

`mean_iou` is over matched pairs (a model box and a human box overlapping by IoU >= 0.5,
whatever their classes). `class_agreement` is the share of matched pairs with the same class.
`map50` counts a detection as right only when box and class both match. Every figure comes
with its counts; none is shown without them.

### Gemini QA (teacher loop step B)

Refused with `409` when: the hold-out check has not run or did not pass; no frame is waiting
(`label_status: "predicted"`); a `qa` job is already queued or running; or the worst-case
number of Gemini calls would pass the project cap (the message gives both numbers).

Per frame: cheap rule checks, then Gemini reviews the labels (drawn as numbered boxes) with
gold exemplars as reference. A frame that fails is corrected and reviewed again, at most
`max_retries` times, then goes to the review queue. The loop always ends.

```jsonc
// dry run:  result.estimate          (gemini_calls is the worst case)
{"images": 28, "gemini_calls": 84, "gpu_minutes": 0, "gemini_calls_remaining": 2000}

// qa job result
{
  "images": 28, "passed": 19, "human_review": 9,
  "rounds": {"0": 11, "1": 6, "2": 2},          // round in which each PASSED frame passed
  "gemini_calls": 47, "invalid_responses": 1, "cheap_check_failures": 2,
  "class_fixes_applied": 61, "objects_added": 14, "stopped_at_cap": false,
  "judge_model": "gemini-3.8-flash", "prompt_version": "qa-v1", "seconds": 212.4
}

// Verdict (inside GET .../images/{iid} "verdicts", oldest first)
{
  "id": "v_...", "image_id": "f_...", "round": 0, "stage": "gemini",   // or "cheap_check"
  "verdict": "fail", "class_ok": false, "missed_objects": 2, "bad_masks": ["o7"],
  "hints": {"class_fixes": [{"object_id": "o3", "class": "ceramic", "confidence": "high"}],
            "retry_profile": "tiled_lowconf", "note": "..."},
  "reason": "Two shards labelled aluminium are ceramic; two objects have no box.",
  "judge_model": "gemini-3.8-flash", "prompt_version": "qa-v1",
  "label_model": {"recipe": "circularnet_rfdetr", "version": 0, "profile": "default"},
  "created_at": "..."
}

// QaSummary
{
  "holdout": { /* the holdout_check result above */ } or null,
  "images": {"frames": 28, "predicted": 28, "waiting_for_qa": 0, "passed": 19,
             "human_review": 9, "human_done": 0, "rejected": 0},
  "pass_rate": 0.68, "n_images": 28,       // passed / (passed + human_review + human_done + rejected); null when n_images is 0
  "last_qa": { /* the last qa job result */ } or null,
  "gemini_calls": {"used": 47, "cap": 2000}
}
```

Image `label_status` values after this section: `none`, `predicted`, `passed`, `human_review`,
`human_done`, `rejected`, `gold`. `GET .../images?status=human_review` is the review queue.
A label corrected by Gemini carries, per changed object, `"class_source": "gemini"` and the
earlier class in `"model_class_before"`; an object added on a retry has `"added_in_round"`.

## Dataset, training, model versions and the schedule (plan Phases 5-6, A1.4-A1.6)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/projects/{pid}/jobs` | `{"type": "compile"}` | `202` Job |
| POST | `/api/projects/{pid}/jobs` | `{"type": "train", "dry_run": false, "params": {"compile_first": true}}` | `202` Job |
| GET | `/api/projects/{pid}/dataset-versions` | | `{"dataset_versions": [DatasetVersion]}` oldest first |
| GET | `/api/projects/{pid}/model-versions` | | `{"model_versions": [ModelVersion]}` oldest first - the trend |
| GET | `/api/projects/{pid}/model-versions/{n}/weights` | `?format=pt` or `onnx` | `{"url": "<short-lived download link>", "filename": "retrainix-<project>-v3.onnx"}` |
| PUT | `/api/projects/{pid}/schedule` | `{"retrain_interval_hours": 6}` or `null` | Project |
| POST | `/internal/tick` | | `{"checked": 3, "started": [{"project_id", "job_id"}], "skipped": [{"project_id", "reason"}]}` |

**What is trained.** CircularNet (RF-DETR segmentation, the Medium size Google's published
model uses), fine-tuned with the `rfdetr` library. A first run starts from a checkpoint
rebuilt from Google's published ONNX (`seed.pt_key` in `config/models.yaml`); later runs
start from the active version's own checkpoint. `weights.pt` is that PyTorch checkpoint.

**Compute.** Training runs on CPU, as a Cloud Run job in the project's region. This project has
no usable GPU quota (CLAUDE.md records the refusals), so `gpu_minutes` is always 0.

**`compile`** needs at least one frame that passed the check or was checked by a person
(`409` otherwise). Result:

```jsonc
{
  "version": 2, "gcs_prefix": "projects/p_x/datasets/v2/", "format": "coco_json", "image_size": 432,
  "images": 56,
  "splits": {"train": {"images": 40, "objects": 1010, "sessions": ["a_1", "a_2"]},
             "val":   {"images": 12, "objects": 320,  "sessions": ["a_1", "a_2"]},
             "test":  {"images": 4,  "objects": 115,  "sessions": ["a_2"]}},
  "label_sources": {"gemini_corrected": 112, "gold": 380, "human": 41, "model": 912},   // objects, by who made the label
  "objects_per_class": {"glass": 130, "plastic": 246},
  "validated": true, "validated_by": "format_check"
}
```

A DatasetVersion document is the same fields plus `created_at`.

The export is COCO segmentation, in the layout CircularNet's training library reads:
`train/`, `valid/` (the `val` split) and - only when there are test frames - `test/`, each
holding its images and one `_annotations.coco.json`. Images are squashed to the model's
432 x 432 input and outlines are scaled with them. Category ids are 1-based, in the
project's class order. An object with a box and no outline is written as its rectangle:
nothing draws outlines for hand-drawn boxes since MobileSAM was removed (20 Nov 2026).

**`train`** params: `compile_first` (default `true`: export a fresh dataset version, then train
on it), `dataset_version` (train on this existing version instead), `epochs` (default from
`agents.yaml` `trainer.epochs`). Refused with `409` when: the hold-out check has not run (there
would be nothing honest to score the new model against); another `train` job is queued or
running; or there is nothing to train on.

```jsonc
// dry run:  result.estimate
{"train_images": 40, "val_images": 12, "epochs": 3, "gemini_calls": 0, "gpu_minutes": 0,
 "compute": "Cloud Run job, 8 vCPU, CPU only", "max_minutes": 120}

// while running: job.progress is {"done": <epochs finished>, "total": <epochs>} and
// job.result carries {"stage": "compiling" | "training" | "exporting" | "evaluating"}

// train job result  ==  the new ModelVersion's main fields
{
  "version": 1, "dataset_version": 2, "parent": "seed", "epochs_run": 10, "train_minutes": 6.4,
  "metrics": { /* same shape as the holdout_check result: map50, map50_95, precision, recall,
                  class_agreement, per_class_recall, n_images, n_objects_gold, eval_set ... */ },
  "previous": {"version": 0, "map50": 0.52},
  "promoted": true,
  "promotion_note": "mAP50 on the gold hold-out rose from 0.52 to 0.61 (n = 10 images, 231 objects)."
}

// ModelVersion (GET .../model-versions)
{
  "id": "0001", "version": 1, "recipe": "circularnet_rfdetr", "parent": "seed",   // or "v2"
  "dataset_version": 2, "status": "ready",        // training | evaluating | ready | failed
  "trigger": "user",                              // seed | user | schedule
  "metrics": { ... }, "promoted": true, "promotion_note": "...",
  "weights": {"pt": true, "onnx": true},          // which downloads exist
  "train_minutes": 6.4, "epochs_run": 10, "created_at": "..."
}
```

- Version 0 is the seed weights, scored by the hold-out check before any training. It has
  `trigger: "seed"`, `dataset_version: null` and no downloads.
- **Every version is scored on the same frozen gold hold-out**, by the same code, so the
  numbers are comparable. `metrics.n_images` and `metrics.n_objects_gold` go with every figure.
- **Promotion.** A new version becomes the project's `active_model_version` (the one that
  pre-labels from then on) only when its `map50` on the hold-out is at least the active
  version's. Otherwise it is kept, marked `promoted: false`, and the note says by how much it
  fell short. The app never reports an improvement that the hold-out did not show.
- After a version is promoted, the model's classes are the project's own classes, so the class
  map no longer applies to its labels.

**Schedule.** `retrain_interval_hours` is `null` (manual only) or at least
`orchestrator.schedule.min_interval_hours`. Cloud Scheduler calls `/internal/tick` every
`tick_minutes`. For each project with an interval, a `train` job with `trigger: "schedule"` and
`compile_first: true` starts when all of these hold: the interval has passed since
`last_retrain_at` (or since the schedule was set, for the first run); at least
`min_new_approved_images` frames have passed or been checked by a person since the last
dataset version; and no `train` job is queued or running. Otherwise the project is listed
under `skipped` with the reason. Project gains `schedule_set_at`, `last_retrain_at`,
`last_tick` (`{"at", "decision", "reason"}`) so the UI can show why nothing ran.

## Objects without an outline

A box a person draws in review has no outline. Until the evening of 20 Nov 2026 an `outline`
job drew one with MobileSAM; that model is not Google's and was removed with Ultralytics
YOLO, so the job type no longer exists (`422`). What remains are counts, so the screens can
say how many objects will be exported as rectangles:

```jsonc
Image:      "missing_outlines": 2            // objects in the latest label with no outline
QaSummary:  "outlines": {"frames_missing": 4, "objects_missing": 9}   // frames that are not gold
GoldStatus: "boxes_without_outline": 3       // in the reviewed frames, before the freeze; 0 after
```

## Recording from a camera (added 20 Nov 2026 at the team lead's request)

The browser records from a camera attached to the PC it runs on and uploads the recording
through the same three upload calls as a file. There is no stream to the cloud: the recording
is made in the browser, then sent whole when recording stops.

- `POST /api/projects/{pid}/uploads` takes one more optional field, `"source"`: `"file"`
  (default) or `"camera"`. It is stored on the Asset and returned with it.
- A camera recording is `kind: "video"` with the content type the browser's recorder
  produced, normally `video/webm` (possibly with a `;codecs=...` suffix) or `video/mp4`.
  The filename is `camera-<YYYYMMDD-HHMMSS>.webm` (or `.mp4`).
- Browser recordings usually carry no frame count and report an unreliable frame rate, so
  `extract_frames` samples them by each frame's timestamp instead of its index. Its result
  gains `"timing": "timestamps"` (or `"frame_index"` for ordinary files) and
  `"stopped_at_max_frames": true` when the recording was longer than the frame cap covers.
