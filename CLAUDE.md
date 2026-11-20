# Retrainix - project instructions

Read `docs/plan.md` before any work. It is the frozen scope and the source of truth.

- Runtime agent rules live in `config/agents.yaml`. Code reads thresholds and limits from there.
- Development subagents live in `.claude/agents/`. Use the owner of a directory for work in it:
  architect-lead, backend-engineer, ml-pipeline-engineer, mlops-training-engineer, frontend-engineer, qa-test-engineer.
- Order of work for every task: contract (architect-lead) -> implementation (owner) -> tests (qa-test-engineer).
- Verify external APIs against current official docs before coding.
- No secrets in the repo. No REXTOR / IRES code or data.
- Anything that costs money needs a dry-run flag and a cap.
- If blocked on access or quota, stop and report; do not work around it.

Everything above this line is the agent pack's own `CLAUDE.md`, unchanged. Everything below
was added on 20 Nov 2026 when the workspace was created.

## Rule 1 - Google only (team lead, 20 Nov 2026)

This is a Startup Buildathon India 2026 entry (Google DeepMind / Google Cloud). It overrides
convenience everywhere:

- **AI comes from Google**: Gemini via Google AI Studio / the Gemini API. No other LLM provider
  in the product.
- **The application is deployed on Google Cloud itself** - Cloud Run, Cloud Storage, Firestore
  and the rest of plan.md section 3. Nothing is hosted elsewhere, including "just for the demo".
- **No Google Cloud resource is created before the event credentials exist.** They are issued at
  15:00 IST on 20 Nov 2026. Until then, build against stubs and local emulation only.
- Coding agents (Claude, Antigravity) are development tools, not part of the product. The deck
  says development tools are listed only when actually used - keep that honest.

## Event clock

| | |
|---|---|
| Credentials issued | 20 Nov 2026, 15:00 IST |
| Prototype submission | **21 Nov 2026, 09:00 IST** (confirmed by the team lead, 20 Nov) |
| Region | `asia-south1` (Mumbai), fallback `asia-southeast1` |

With that little time, plan.md's fallback matters: if training integration slips, ship
annotation + QA + dataset export only (Option D). Decide that early, not at the deadline.

## Scope - settled 20 Nov 2026

The scope frozen on 19 Nov was amended once by the team lead on 20 Nov. The amendment is
**`docs/plan.md` section 0 (Amendment A1)** and it overrides the later sections it names. In
short: the project's own model pre-labels video frames instead of SAM 3, CircularNet is the
default pre-labelling model, training is a containerised GPU job on Google Cloud that can also
run on a schedule, and every model version is scored on the same frozen gold hold-out.

The pack rule above, "No REXTOR / IRES code or data", is superseded by A1.7 for the camera
dashboard only - see the next section.

One point was never open: **the accuracy shown to the user must be measured on human-labelled
hold-out images that no model produced.** A model retrained on its own predictions and scored
against its own predictions will always look like it improved. The 10 hold-out gold images are
that mechanism. No human-labelled images exist yet (the dashboard's dataset was built from zero
human annotations), so the gold set has to be made by a person before any accuracy is quoted.

**Second amendment, 20 Nov late evening - `docs/plan.md` Amendment A2.** The team lead's
instruction: remove Ultralytics YOLO and the other models that are not Google's, and use
CircularNet for the demo. So there is ONE model now, Google's CircularNet: it pre-labels and
it is the model that is retrained. The Ultralytics YOLO recipe, its seed weights, its decoder
and MobileSAM (the outline step) are gone from the product. Sections below that still
describe YOLO or SAM measurements are kept as the record of what was measured, and say so.

Two things to keep honest whenever this is described:

- **CircularNet is Google's model, built on RF-DETR, which is Roboflow's architecture and
  library** (`rfdetr`, Apache-2.0 at this size). Google's own CircularNet fine-tuning
  notebook uses that library. "Google's CircularNet" is accurate; "an all-Google model
  stack" is not.
- **Stock CircularNet is the wrong model for this belt** - measured in August by the
  dashboard project and twice on 20 Nov here (it calls nearly every fragment plastic and has
  no ceramic or stone class). That is the demo's starting point: the loop exists to retrain
  it on the customer's own belt. Do not present the stock labels as good.

## The base application - reference only

`../Reneonix-Camera-Dashboard-/` is the existing PyQt6 desktop app for the ECS inspection rig
(RealSense D456, YOLO + CircularNet inference, tracking, counting, run reports). It is a
separate git repo and it is IRES work.

- **Reuse of its tools, weights and labelled data is approved** (team lead, 20 Nov; plan.md
  A1.7). List every file brought across in `docs/reuse.md` with its source path. Weights and
  footage go to Cloud Storage, never into git.
- **What is actually on this PC (checked 20 Nov):** the trained 6-class YOLO segmentation
  weights (`Model_Handoff/weights/`), the YOLOv8l detector (`models/Yolo/best.pt`), Google's
  stock CircularNet ONNX with 50 classes (`models/circularnet/`), two mixed-belt videos
  (`Mixed object/`), three captured clips, the SAM weights and everything in `tools/`.
- **What is NOT on this PC:** the 41,539-instance labelled dataset, the 32 source videos, the
  YOLO training runs and both fine-tuned CircularNet checkpoints. `HANDOFF.md` places them on
  `A:\`, and this machine's `A:` drive does not have them. Do not plan around them unless
  someone brings that drive.
- It is still the best record of what has already been measured. Read
  `Model_Handoff/HANDOFF.md` and `TODO.md` section 7 there before making any claim about
  CircularNet - stock CircularNet was measured as the wrong model for that belt (19 detections
  against 53), and useful only as starting weights for fine-tuning.

## Local toolchain (checked 20 Nov 2026)

| Tool | State |
|---|---|
| Node 24.18 / npm 11.16 | installed |
| uv 0.11, Python 3.13 (system) and 3.12 | installed |
| git, gh | installed |
| gcloud CLI 594.0.0 | installed at `%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`; not on every shell's PATH, so call it by that path if `gcloud` is not found |
| **Docker** | **not installed** - `gcloud run deploy --source .` builds the root `Dockerfile` in Cloud Build. The Dockerfile has therefore never been built locally |

## Commands

```bash
# Backend (FastAPI). The venv is kept outside OneDrive on purpose.
cd backend
export UV_PROJECT_ENVIRONMENT="$LOCALAPPDATA/retrainix/backend-venv"
export UV_PYTHON="$LOCALAPPDATA/Programs/Python/Python312/python.exe"
uv sync
uv run pytest -q                                  # all tests
uv run pytest tests/test_health.py::test_health_answers_on_both_paths   # one test
uv run ruff check .
uv run uvicorn app.main:app --port 8080 --reload  # API on :8080

# Frontend (React + TypeScript + MUI, Vite)
cd frontend
npm install
npm run dev        # :5173, proxies /api to :8080
npm run build      # type-check + build into frontend/dist

# After changing backend dependencies, refresh the pinned list the Dockerfile installs:
cd backend && uv export --no-dev --no-hashes --no-emit-project -o requirements.txt
```

- **`UV_PYTHON` is needed on this PC.** Without it uv stops on a `python3.12.exe` that belongs
  to another Windows account and is not readable ("Access is denied").
- When `frontend/dist` exists, the API serves it, so `http://localhost:8080` is the whole app -
  the same arrangement as the container. Run `npm run build` again to refresh it.
- Health is served on `/api/health` and `/healthz`. Rely on `/api/health` once deployed.

This folder sits inside OneDrive. `node_modules/` currently lives in it and installs worked; if
they start failing on locked files, pause the sync - the dashboard project hit the same problem
and moved its ML environment to `%LOCALAPPDATA%`.

## How the backend is put together

Read `docs/api.md` and `docs/schemas.md` first - they are the contract and the code follows
them. The parts that span files:

- **Two interfaces hide the cloud.** `app/store.py` (`Store`: Firestore, or a dictionary) and
  `app/blobs.py` (`Blobs`: Cloud Storage, or a local folder). `app/deps.py` picks one of each
  from `STORE_BACKEND` / `BLOB_BACKEND`. The defaults are the offline ones, so the tests and a
  laptop need no credentials; `infra/env.sh` `runtime_env` sets the cloud ones. New code takes
  a `Store` and a `Blobs` and never imports a Google client directly.
- **The job document is the queue.** `app/jobs.py` writes `projects/{pid}/jobs/{jid}` and then
  starts the worker with only those two ids. `JOB_RUNNER` decides how: `cloud_run` (one
  execution of the Cloud Run job `retrainix-worker`), `inline` (a thread, for a laptop) or
  `sync` (inside the request - tests only).
- **One image, two roles.** The root `Dockerfile` builds the web service; the worker job runs
  the same image with `python -m app.worker <pid> <jid>`. `infra/deploy.sh` deploys both.
- **`app/worker.py` `HANDLERS`** maps a job type to a function in `backend/agents/`. A handler
  takes a `JobContext` (store, blobs, config, job, `progress()`) and returns the job's
  `result`. Adding a pipeline step = one agent module + one line in `HANDLERS`. A job type
  with no handler fails with "not built yet" rather than pretending.
- **`backend/agents/`** is one module per runtime agent of plan.md section 5. They read every
  threshold from `config/agents.yaml` through `ctx.config`.
- **Ids sort by time** (`jobs.sortable_id`), and lists are ordered by id. That keeps every
  query to a single-field filter, so Firestore needs no composite index.
- **Uploads go browser -> bucket** through a signed URL (`GcsBlobs.upload_url`); locally the
  API stands in for the bucket at `/api/_local/upload/...`. An asset is `pending` until
  `/complete` confirms the file arrived.

Measured on real belt clips (20 Nov): sharpness scores (variance of Laplacian) sit around
50-110 on this dark belt, so the blur filter is relative to each video's median, not an
absolute number. An empty-belt clip correctly collapses to a few frames (14 sampled -> 4 kept).

## Pre-labelling - what was measured (20 Nov 2026)

**Since Amendment A2 the only labelling model is CircularNet**, an ONNX file run with
onnxruntime on CPU (`backend/agents/annotator.py`), so the worker carries no deep-learning
framework. Only training needs one. The YOLO rows and the YOLO decoder check below are the
record of the comparison that was made before the YOLO recipe was removed; that decoder no
longer exists in the code.

- **Where a model keeps its classes.** Google's published ONNX has 51 class logits with
  index 0 for background, so its classes start at 1 (`seed.first_class_index: 1`). A
  version trained here has its classes at 0..n-1 and one spare logit at the end, because
  the training library renumbers categories from 0. Verified on a real trained export
  (20 Nov): a model trained on labels that were almost all "plastic" (project class 4)
  put 157 of 157 detections on logit 4; decoded with `first=0` they read "plastic", with
  `first=1` they would have read "metal". `annotator.TRAINED_FIRST_CLASS_INDEX` is that 0.
- **Second measurement, same result (20 Nov, late evening, 43 frames of the second belt
  clip, CircularNet only):** 627 objects kept, 14.6 per frame, 623 of them plastic and 4
  metal; 229 more were dropped because their CircularNet class maps to none of the six
  project classes. 0.54 s per frame on the laptop CPU.
- **The YOLO decoder is verified against the original weights.** On 6 real 1280x800 frames,
  the ONNX path and ultralytics running the original `.pt` agree on 168 of 168 detections
  (same class, mean box IoU 0.9985, identical scores). Frames are squashed to a square before
  inference, not letterboxed, because that is how the seed model's training frames were made.
- **On this belt, stock CircularNet calls everything plastic.** Same 28 frames, same settings:

  | Pre-labelling model | Objects | Per frame | Classes found | Time per frame (laptop CPU) |
  |---|---|---|---|---|
  | YOLO seed (dashboard `sammix`) | 648 | 23.1 | all six | 0.13 s |
  | CircularNet (Google's ONNX) | 392, plus 41 unmapped | 14.0 | plastic only (392 of 392) | 0.57 s |

  CircularNet has no ceramic or stone class at all, and its classes describe whole products
  (bottles, cups, lids), not fragments. This repeats what the dashboard measured in August. So
  CircularNet stays selectable, but a fragment-belt project should pre-label with the YOLO seed.
- These counts say how much each model finds, **not how correct it is**. Neither figure is an
  accuracy until it is scored against human-labelled gold frames. Visible errors in the YOLO
  labels: some wrong classes (a white ceramic piece called aluminium) and a few missed objects.
- A model can put two classes on one object; `one_label_per_object` keeps the higher score.

Local runs need the two ONNX files under `%TEMP%/retrainix-data/seed/<recipe>/` (the same
paths as in the bucket); copy them there once.

**One trial of the Gemini review, before the teacher loop is built (20 Nov).** One frame, 34
YOLO labels drawn as numbered boxes, sent to `gemini-3.8-flash` through Vertex AI at
`locations/global` with a response schema. It answered valid JSON for all 34 boxes in 23 s
(about 4,800 tokens, of which 1,800 were thinking), called 10 classes wrong with a
replacement for each, and counted 3 objects with no box - the frame does show exactly 3
unboxed objects, and the class changes looked right by eye (white and patterned shards moved
from aluminium to ceramic). This is one frame judged by eye, not a measurement: it shows the
approach is workable, not how accurate Gemini is. Numbered boxes drawn on the image worked as
the way to refer to objects. 23 s per frame means the QA job must call Gemini in parallel.

## The teacher loop as built

Order, enforced by `app/routes/work.py` `_check_can_start` (each step answers 409 with a plain
reason until the one before has run):

    pre-label  ->  a person reviews frames  ->  freeze gold set  ->  hold-out check  ->  Gemini QA  ->  review queue

- **The gold set is made in the app, not uploaded.** A person accepts or corrects pre-labelled
  frames; `POST /gold/freeze` turns 30 of them into 20 exemplars and a 10-frame hold-out
  (`agents/review_router.py`). This replaces plan.md's "upload 30 hand-annotated images" - no
  hand-labelled data existed and there was no time to label 30 frames from scratch.
- **What that costs in honesty.** Gold boxes start as the model's own boxes, so box overlap
  (`mean_iou`, precision, recall) on the hold-out flatters the model that proposed them. The
  human signal is in the classes a person changed and the boxes they added or deleted - so
  `class_agreement` and `map50` (which need the class right) are the figures to watch, and box
  IoU alone should not be quoted as accuracy.
- **`agents/labels.py` is the only way labels are written.** One file per round, never
  overwritten; `set_status` keeps the project counters in step; a gold image raises on write.
- **Gemini does not decide a pass.** It reports per box (class right? box right? how sure?)
  and a count of unboxed objects; `teacher_qa.judge` applies the thresholds from
  `agents.yaml`. Remarks under `min_fix_confidence` change nothing.
- **A correction is conservative.** Classes Gemini named are changed (and tagged
  `class_source: gemini`), boxes it called bad are dropped, and only when it reports missed
  objects does a second, tiled prediction run - whose results are added only where they overlap
  nothing already there. Existing objects are never replaced by a re-prediction.
- **The loop ends by construction**: a `for` over `max_retries + 1` rounds. An unusable answer
  is retried once, then the frame goes to a person. The per-project call cap is checked before
  every call and again before a job may start.
- **First full run with the real Gemini (20 Nov, local worker, prompt qa-v1).** Two belt clips,
  56 frames; 30 auto-accepted as a stand-in gold set (plumbing only - see the next point),
  26 frames checked: 78 Gemini calls in 982 s, 4 unusable answers, 8 passed (3 after one
  correction, 5 after two, none first time), 18 sent to a person, 112 class changes applied,
  216 objects added by the second look. Two things were wrong and were changed for qa-v2:
  the second look added far more objects than Gemini had reported missing, many of them belt
  marks that failed the next round (now capped at the number reported missing, best score
  first); and Gemini failed boxes for objects cut off by the frame edge (the prompt now says
  that is acceptable). One call took about 75 s with four reference photos, so the reference
  photos went from 4 to 2 and parallel calls from 6 to 12.
- **A stand-in gold set scores 1.000 on everything.** When the "gold" is the model's own
  output accepted without changes, the hold-out check returns mean IoU, precision, recall,
  class agreement and mAP of exactly 1.0. That number means nothing - it is the model agreeing
  with itself - and it is the clearest demonstration of why the real gold set must be
  corrected by a person. Never show a score from an unreviewed gold set.
- Whether Gemini's class changes are right has NOT been measured. The commonest in that run
  were aluminium -> glass (22) and aluminium -> plastic (19). Only a human-made gold set can
  say whether those are corrections or new errors.
- `evaluator.score` is the one scoring function: the hold-out check uses it now, and every
  trained model version will use it, so versions are comparable (plan A1.6). The hold-out
  check also writes model version 0 - the seed weights, scored before any training.

## Training as built (CircularNet, since Amendment A2)

- **What is trained.** CircularNet = RF-DETR segmentation, the Medium size (read from
  Google's ONNX by the dashboard project: 12 backbone layers at 384, 5 decoder layers).
  `agents/trainer.py` `run_training` fine-tunes it with `rfdetr` 1.5.2 on CPU and exports
  ONNX; it is the only place that library is imported, and tests replace it.
- **Where a first run starts.** Google's own checkpoint download answers HTTP 403
  (dashboard HANDOFF.md section 4.4), so the start is a checkpoint rebuilt from the published
  ONNX by the dashboard's `tools/circularnet_onnx_to_pth.py`. Rebuilt on this PC on 20 Nov:
  416 of 572 parameters copied from CircularNet, 28 class-head parameters skipped, 156 left
  at RF-DETR's COCO values - the same counts the dashboard recorded. The tool's own output
  comparison against the ONNX reports a difference, as it must for a partial copy. **It is
  not a faithful copy of Google's model; never call it one.** It lives in the bucket at
  `seed/circularnet_rfdetr/checkpoint_circularnet_recovered.pth` (143 MB, `seed.pt_key`);
  later runs start from the active version's own checkpoint (`weights/v<n>/best.pt`).
- **The dataset is COCO**, in the layout the library reads (`train/`, `valid/`, `test/`,
  each with `_annotations.coco.json` beside its images), 432 x 432, category ids 1-based.
  A box with no outline is exported as its rectangle - nothing draws outlines for
  hand-drawn boxes since MobileSAM was removed. The screens count those boxes.
- **Settings**, from `config/agents.yaml` `trainer`: 3 epochs, batch 2 with gradients
  accumulated over 4 steps (the dashboard's CircularNet setting), one image size, no test
  pass (the exam is the gold hold-out, scored afterwards by the app's own `evaluator.score`).
- **Measured on the build PC's CPU (12 logical cores, 20 Nov):** one epoch on 11 training
  frames (168 objects) and 3 validation frames took 326 s from start to finished ONNX
  export, most of it fixed cost (building the model, validation, export); peak memory
  4.7 GB. The library writes about 2 GB of checkpoints per run, which on Cloud Run is held
  in memory - inside the trainer job's 16 GiB, but worth knowing.
- **The trainer image is defined but NOT built.** `workers/trainer/Dockerfile.base` now
  installs CPU PyTorch + `rfdetr==1.5.2` + OpenCV 4 (the dashboard found rfdetr needs OpenCV
  below 5, so the API's OpenCV 5 pin is left out of that image). The same package set was
  installed together on the build PC and the worker, the trainer and `rfdetr` all import.
  Cloud Build has not built it: the project's billing was off when it was written. The
  first `bash infra/deploy_trainer.sh --apply --base` is the test of that file.
- **Two images, three Cloud Run resources.** `infra/deploy.sh` builds the web image and
  deploys the service, the `retrainix-worker` job (same image) and the Cloud Scheduler job.
  `infra/deploy_trainer.sh` builds the trainer image and deploys `retrainix-trainer` (8 vCPU,
  16 GiB). `app/jobs.py` sends `train` jobs to the trainer and everything else to the worker.
- **Re-run `deploy_trainer.sh --apply` after any backend change that training touches** - the
  trainer carries its own copy of `backend/`. Add `--base` only when
  `workers/trainer/Dockerfile.base` or `backend/requirements.txt` changes.
- **Do not run both deploy scripts at once.** One attempt failed with an HttpError from Cloud
  Build while two builds were in flight; run alone, the same deploy passed.
- The trainer runs as an unprivileged user, so its home folder must exist and be writable
  (the first live failure of the earlier trainer was exactly that).
- `annotator.active_model` decides which weights label and score: Google's published ONNX
  through the project's class map until a version is promoted, then the project's own ONNX
  with an identity class map.
- Only `extract_frames`, `prelabel` and `holdout_check` are retried automatically. Training,
  export and the Gemini check are not: a retry costs money and leaves duplicate versions.
- **Before the first deploy of this version:** copy the 143 MB checkpoint to the bucket at
  `seed.pt_key`. Projects created before A2 have `recipe: ultralytics_yolo`, which no longer
  exists: they cannot label or train, so the demo needs a new project.
- NOT measured: how long a run takes on the Cloud Run job's 8 vCPU; whether a few epochs on
  a few dozen frames make CircularNet better on a real, person-made gold set.
- History: until A2 the trainer fine-tuned Ultralytics YOLO (live on 20 Nov: 22 frames, 3
  epochs, 0.48 min, correctly not promoted against a stand-in gold set). That code is gone.

## Outlines for hand-drawn boxes - removed

On the evening of 20 Nov a MobileSAM step drew outlines for boxes a person draws in review
(job type `outline`, live-tested at 2 boxes in 13.8 s). MobileSAM is not Google's, so
Amendment A2 removed it the same night: `agents/outliner.py` is deleted and the job type
answers 422. What is left are counts (`missing_outlines`, `boxes_without_outline`, the QA
summary's `outlines`), so the screens can say how many objects will be exported as
rectangles. A Google route for this exists on paper - MediaPipe Interactive Segmenter - and
has not been tried.

## Camera recording as built (added 20 Nov 2026, evening)

- **It is a recording, not a stream.** The browser records from a camera attached to the PC
  it runs on (`getUserMedia` + `MediaRecorder`), and when recording stops the file goes up
  through the ordinary three upload calls with `"source": "camera"`. Nothing connects a
  camera to the cloud directly, and nothing is sent while recording. Say it that way.
- **Browser recordings are sampled by timestamp.** A `MediaRecorder` file reports no frame
  count and a "frame rate" that is really its clock resolution, so counting frames would
  sample it wrongly. `data_intake.reliable_timing` detects that and `TimestampSampler` picks
  one frame per interval from each frame's own time. Ordinary files still go by frame index.
- **Verified locally with a real `MediaRecorder` file** (VP9 WebM, 6.5 s, made from a canvas
  in the browser pane, since the build PC had no camera on hand): the job reported
  `timing: "timestamps"`, a length of 6.5 s and 7 frames at 0, 1.04 ... 6.04 s.
- **Verified live the same way** (20:57 IST, version dev-202611201521): the browser PUT the
  recording straight to the signed Cloud Storage URL, and the Cloud Run worker extracted 7
  frames from the 6.5 s file with `timing: "timestamps"` in 11 s. This was also the first
  upload made by a real browser rather than by curl. The test project is `p_a72ed8`.
- **NOT verified: a real camera.** The rig's RealSense D456 has not been tried in the browser.
  Its colour stream should appear as an ordinary webcam on Windows, but that is untested, and
  a camera can only be opened by one program at a time - close RealSense Viewer and the
  dashboard app first. The browser also decides the resolution and applies its own exposure
  handling; the locked exposure, gain and white balance the dashboard app sets are NOT
  applied by a browser recording. For dataset-grade footage the dashboard app's recorder
  is still the right tool; browser recording is the quick path.
- The page must be on https or localhost, or the browser will not offer the camera.

## Google Cloud - what exists (measured 20 Nov 2026)

**Billing went off on the evening of 20 Nov.** At 22:49 IST every billing account this login
can see was closed (`open: false`), including "GDP Event Credit: Startup Buildathon -
Chennai" that the project is linked to; the live site answers 503 and most gcloud calls
answer "billing to be enabled". The bucket still listed. The team lead says the event
credits expired and another person's credits will be used. Nothing can be deployed until an
open billing account is linked to this project (that person grants this login "Billing
Account User" on it), or the app is set up in a project of theirs with `GCP_PROJECT_ID`
and `SERVICE_URL` overridden. **The CircularNet-only version has never been deployed.**

| | |
|---|---|
| Project | `desktop-application-515217` (number 801692371835). The event credits can only be claimed on this account, so this is the project |
| Live app | https://retrainix-801692371835.asia-south1.run.app - Cloud Run service `retrainix`, **public, no sign-in** |
| Bucket | `gs://retrainix-data-desktop-application-515217`, `asia-south1`, public access prevented |
| Database | Firestore `(default)`, Native mode, `asia-south1` |
| API identity | `retrainix-api@desktop-application-515217.iam.gserviceaccount.com` - Firestore user, object admin on the one bucket |

Scripts, all dry-run unless given `--apply`: `infra/bootstrap.sh` (one-time setup, safe to
repeat), `infra/deploy.sh` (build in Cloud Build + deploy), `infra/teardown.sh`. Shared values
are in `infra/env.sh`.

**GPU - only one route is open.** Read from the project's quotas, not assumed:

| Route | Quota | Usable |
|---|---|---|
| Compute Engine GPU VM | "GPUs (all regions)" = 0; T4 and L4 = 0 in Mumbai and Singapore | no |
| Cloud Run with GPU | L4 allocation reads as 0 | no |
| **Vertex AI custom training, spot T4** | **1 in `asia-south1`** (also 1 in Singapore and us-central1) | **yes** |
| Vertex AI custom training, on-demand T4 or L4 | reads as 0 | no |

**Correction, same day: that last route is not usable either.** A spot-T4 custom job was
submitted and refused: `custom_model_training_preemptible_cpus` is 1 per region, and the
smallest machine a T4 can attach to on Vertex AI (`n1-highmem-2`) has 2 vCPUs
(`n1-standard-1` is "not supported"). The on-demand N1/E2 training CPU quota is also 1. The
only training CPU quota above 1 is C3/C4/C4D (7), and `c3-standard-4` is "not supported in
region asia-south1 or any other asia regions" while `c4-standard-4` is "not supported".

**So there is no GPU, and no usable Vertex AI training machine in Asia, on this project today.**
Training therefore runs on CPU as a Cloud Run job in Mumbai (up to 8 vCPU per task, no extra
quota needed). `workers/trainer/train.py` (written for the Vertex GPU route) is kept for the
day the quota arrives: raising "Custom model training preemptible CPUs per region" for
asia-south1 from 1 to 8 would open the spot T4. Google's prebuilt image for that route exists
at `asia-docker.pkg.dev/vertex-ai/training/pytorch-gpu.2-4.py310`. Pre-labelling runs on CPU
either way.

**Gemini - both plan ids are real, but only on the `global` location.** `gemini-3.8-flash` (GA)
and `gemini-3.1-pro-preview` (preview) answered a test prompt through Vertex AI at
`locations/global`; both return 404 at `locations/asia-south1`. Call Gemini through Vertex AI
with the service account (no API key to store); AI Studio is for testing prompts.

**⚠ Gemini generation is REFUSED for this project since 20 Nov 2026, 10:17 UTC (15:47 IST).**
Every `generateContent` call - a one-word text prompt included, from the owner's own login as
well as from the service account - returns `403 PERMISSION_DENIED: "Request rejected in
accordance with our terms of use and policies."` `countTokens` still answers, the billing
account ("GDP Event Credit: Startup Buildathon - Chennai") is open, and no IAM binding
changed. Timeline: about 250 image-review requests were sent to `gemini-3.8-flash` between
14:55 and 15:47 IST (one probe, two local pipeline runs of 78 and 74 calls, one live run);
on the live run 49 calls succeeded, then 46 in a row were refused at 0 seconds. The cause is
NOT known - it reads like an automatic usage restriction on a new credit account, not a
quota (that would be a 429) and not a permission (that names the missing permission). Do not
retry in a loop. What to try, in order: one single test call after a pause; the event
organisers, who issued the credit account; an AI Studio API key (a different serving path)
- which needs a key the team creates and stores in Secret Manager, and a key mode in
`app/gemini.py`.

Still refused at 20:40 IST, five hours on. **The way round it, built the same evening: an API
key route.** `app/gemini.py` calls the Gemini API (`generativelanguage.googleapis.com`) with a
Google AI Studio key when `GEMINI_API_KEY` is set, and Vertex AI otherwise. The key lives only
in Secret Manager (`gemini-api-key`, created empty by `infra/bootstrap.sh`; a person adds the
version). `infra/deploy.sh` passes it to the service and the worker only when the secret holds
an enabled version, and prints which route the deploy will use. `GET /api/gemini/status` makes
one tiny call (remembered for two minutes) and says whether Gemini answers, by which route,
and - if the model id is wrong for the key - which models the key can use. The key is sent in
a header, never in a URL, and is scrubbed from every error text. NOT yet verified against the
real Gemini API: only against a scripted HTTP session.

Because of this, `agents/teacher_qa.py` treats a failed CALL differently from a bad ANSWER:
a refused or timed-out call decides nothing, the frame stays `predicted`, the run stops, and
the job fails with the reason. The live run of 15:40 IST predates that fix: its project
(`p_ab3c01`, a throwaway) has 23 frames in the review queue that Gemini mostly never judged.

**Cloud Run does not serve `/healthz`** - Google's front end answers it with its own 404 before
the app sees it. Use `/api/health`.

## Review panel

`docs/PERSONAS.md` is the review panel; the `review-panel` subagent runs it. Use it before a
phase is closed and before the submission, not instead of the qa-test-engineer.
