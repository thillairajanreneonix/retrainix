# plan.md — Retrainix (Reneonix, Buildathon MVP)

Product name: **Retrainix** (retrain + Reneonix; earlier working names "Vision Data Engine" and "GoldLoop"; trademark/domain check open).
Region: **Mumbai (asia-south1)**.

Status: scope frozen 19 Nov 2026. This file is the single source of truth for the build.
Read it fully before writing code. If something here conflicts with a later instruction
from the team, ask before changing scope.

## 0. Amendment A1 - 20 Nov 2026 (approved by the team lead; overrides the sections named)

The scope frozen on 19 Nov was changed once, on 20 Nov, by the team lead. Where this table
and a later section disagree, this table wins. The later sections are left as written so the
change stays visible.

**Submission deadline: 21 Nov 2026, 09:00 IST.**

| # | Topic | Frozen on 19 Nov | Now | Overrides |
|---|---|---|---|---|
| A1.1 | Labeller | SAM 3 auto-labels | The project's current model version pre-labels the frames (model in the loop). SAM 3 leaves the MVP, and with it the Hugging Face gate | section 1 step 5, section 2, agent 7, Phase 3 |
| A1.2 | Input | Images only; video out of scope | Video upload; frames sampled at a fixed interval, then de-duplicated and blur-filtered. Image folders are still accepted | section 2 OUT, agent 5 |
| A1.3 | Models | Ultralytics YOLO detection only; CircularNet is stretch item 4 | Two seeded records. CircularNet is the default pre-labelling model. Ultralytics YOLO is the training path that must work end to end first; CircularNet fine-tuning is attempted only after that | section 2, Phase 2 |
| A1.4 | Training compute | One Colab Enterprise run started by the user | A containerised training job on Google Cloud GPU compute. The target (Cloud Run job with GPU, Compute Engine VM, or Vertex AI custom job) is chosen after the quota check on the event project | section 3, agents 4 and 11, Phase 6 |
| A1.5 | Schedule | None | A retrain interval per project. A Cloud Scheduler tick starts a retrain only when approved labels have been added since the last model version | new |
| A1.6 | Accuracy trend | One report per run | Every model version is evaluated on the same frozen gold hold-out. The dashboard plots version against metric, with counts | agent 12 |
| A1.7 | Reuse | No REXTOR / IRES code or data in this repo | Reuse of the camera dashboard's tools, weights and labelled data is approved. Every reused file is listed in `docs/reuse.md` with its source path | section 10 IP, section 11 question 4 |

Retries without SAM 3 (replaces "re-run SAM 3 with Gemini's hints"): a failed image is
re-predicted with the next inference profile in `config/agents.yaml` (tiled, lower confidence),
and Gemini's class corrections are applied to the objects it named. Still a maximum of 2
retries, then the human queue.

Unchanged and still binding: gold images are never modified; metrics first, Gemini second,
human sample third; the loop always terminates; every metric is shown with its counts; every
paid step has a dry-run flag and a cap; CLAUDE.md Rule 1 (Google only).

Added after the amendment, 20 Nov evening, at the team lead's request: **SAM outlines.**
MobileSAM, prompted by a box, draws the outline of any object that has a box and none - in
practice the boxes a person draws in review. It does not label, classify or replace the
model's own outlines, so A1.1 stands: the project's model is still the labeller. Contract in
docs/api.md, "SAM outlines".

Cut order if the clock runs short, first cut first: model catalogue search (keep the two
seeded records) -> CircularNet fine-tuning -> email notifications -> the schedule (keep the
manual retrain button). The section 2 fallback (Option D) still applies after those.


### Amendment A2 - 20 Nov 2026, late evening (team lead; overrides A1.3 and the SAM outlines note above)

Instruction, as given: remove Ultralytics YOLO and the other models that are not Google's,
and use CircularNet for the demo.

| # | Topic | Under A1 | Now |
|---|---|---|---|
| A2.1 | Models | Two seeded records; Ultralytics YOLO is the training path | One record: Google's CircularNet. It pre-labels and it is the model that is retrained. The Ultralytics YOLO record, its seed weights and its decoder are removed |
| A2.2 | Outlines | MobileSAM outlines boxes a person draws | Removed (MobileSAM is not Google's). A box with no outline is exported as its rectangle; the screens count them |
| A2.3 | Dataset format | YOLO text labels | COCO segmentation in the layout CircularNet's training library reads (`train/`, `valid/`, `test/`) |
| A2.4 | Training | Ultralytics on CPU | CircularNet fine-tuning with the `rfdetr` library on CPU, starting from a checkpoint rebuilt from Google's published ONNX |

What this does not change, and what has to be said plainly in the pitch:

- CircularNet is Google's model, but it is built on RF-DETR, which is Roboflow's architecture
  and library (Apache-2.0 at this size). "Google's CircularNet" is accurate; "an all-Google
  model stack" is not.
- Stock CircularNet was measured twice as the wrong model for this belt (it calls nearly
  every fragment plastic, and has no ceramic or stone class). That is now the starting point
  of the demo, not a hidden weakness: the loop exists to retrain it on the customer's belt.
- Google's own CircularNet checkpoint download answers HTTP 403, so training starts from a
  checkpoint rebuilt from the published ONNX: 416 of 572 parameters are CircularNet's, the
  rest keep RF-DETR's COCO values, and the class head is new. See CLAUDE.md.

## 1. What we are building

A web app that takes a user from "I have images" to "I have a trained vision model":

1. User finds an open-source model through Google Search (Gemini grounding) or picks a verified one from a dropdown.
2. App shows the model's description, task, input size, dataset format, licence, minimum GPU memory.
3. User chooses compute: Google Colab Enterprise (recommended) or own hardware (checked by a local agent).
4. User uploads class names, 30 hand-annotated "gold" images, and a folder of unlabelled images.
5. SAM 3 auto-labels the unlabelled images using text + exemplar prompts from the gold set.
6. A teacher loop validates labels: metrics against held-out gold images first, Gemini review second.
   Pass -> saved to Cloud Storage. Fail -> re-prompt SAM 3, maximum 2 retries, then human review queue.
7. User is notified "dataset ready".
8. Dataset is compiled into the selected model's format and resolution, then the model is trained.
9. Model is evaluated on real held-out images; weights and a report are exported.

Built with Google Antigravity / Claude as coding agents. Deployed on Google Cloud.

## 2. Frozen MVP scope (Option B from the decision matrix)

IN scope — must work end to end:
- Model discovery: Grounding with Google Search + model-card verification
- One model family: Ultralytics YOLO detection (show AGPL-3.0 licence notice in UI)
- Compute: Colab Enterprise notebook execution
- Gold set upload (30 images, YOLO or COCO labels), split 20 exemplars / 10 hold-out
- SAM 3 auto-labelling
- Teacher loop: IoU metrics + Gemini review, max 2 retries, human review queue
- Versioned dataset in Cloud Storage, YOLO export
- Training run, evaluation on real test images, weights download
- 3 screens: Project setup, Annotation QA, Train & export
- "Dataset ready" and "Training done" notifications (in-app; email if time permits)

STRETCH — only after everything above is demo-ready, in this order:
1. COCO export + RT-DETR
2. Local hardware agent (GPU/VRAM/CUDA check, local venv)
3. ResNet-50 classification export (ImageFolder of object crops, 224x224)
4. CircularNet export (TFRecord)
5. Synthetic data generation (cut-out compositing)

OUT of scope: user accounts/billing, multi-tenant security, video, free-Colab automation
(free Colab has no API — offer only an "Open in Colab" link).

FALLBACK if training integration slips: ship the annotation + QA + dataset export only (Option D).

## 3. Architecture

| Layer | Choice |
|---|---|
| Frontend | React + TypeScript (Vite), served from Cloud Run |
| Backend API | Python 3.12, FastAPI, on Cloud Run |
| Metadata | Firestore (projects, images, labels, jobs, QA verdicts) |
| Files | Cloud Storage: gs://<bucket>/projects/<id>/{gold,raw,labels,datasets/v<n>,weights,reports} |
| Async jobs | Pub/Sub (or Cloud Tasks) -> worker services |
| GPU labelling worker | SAM 3 in a container: Vertex AI custom job or Cloud Run with GPU (check region availability) |
| LLM | Gemini API. Flash-class model for bulk QA; Pro-class for hard cases. Google Search grounding for discovery |
| Training | Colab Enterprise notebook execution from a parameterised notebook + runtime template |
| Containers | Artifact Registry, one image per model family, pinned dependencies |
| Secrets | Secret Manager. Never commit keys |

Master label format (stored once, exported per model): per image a JSON with
`{image_id, width, height, objects: [{class, mask_rle, bbox_xyxy, source: gold|sam3|human, score, round}]}`.
Originals are never resized in storage; resizing happens at export/train time.

## 4. Repository layout

```
/frontend            React app (3 screens)
/backend
  /app               FastAPI routes, schemas, Firestore + GCS clients
  /agents            one module per runtime agent (section 5)
  /exporters         yolo.py (MVP), coco.py, imagefolder.py, tfrecord.py (stretch)
  /tests
/workers
  /sam3_annotator    GPU container
  /trainer           training notebook + runtime template config
/local_agent         stretch: hardware profiler CLI
/infra               Dockerfiles, deploy scripts, env templates
/config/agents.yaml  runtime agent rules (thresholds, limits, formats) — loaded by the orchestrator
/.claude/agents      development subagent definitions (YAML frontmatter + rules)
/CLAUDE.md           project instructions for Claude
/docs                plan.md, api.md, schemas.md, demo script
```

## 5. Runtime agents (inside the product)

Each is a Python module with a clear input/output contract and its own tests.
"Agent" = a pipeline component; only catalogue, teacher and orchestrator call an LLM.

| # | Agent | Input -> Output | MVP? |
|---|---|---|---|
| 1 | Orchestrator | project state -> next step; retries, cost caps, status events | Yes |
| 2 | Model catalogue | user query -> verified model records (task, input size, format, licence, VRAM, source URL) via Google Search grounding + model-card fetch | Yes |
| 3 | Hardware profiler | local machine -> GPU/VRAM/CUDA/RAM/disk report + feasible yes/no | Stretch |
| 4 | Environment provisioner | model + compute choice -> Colab Enterprise runtime (or local venv) | Yes (Colab) |
| 5 | Data intake | uploads -> validated, de-duplicated, blur-filtered images; split by capture session | Yes |
| 6 | Synthetic data | class names/cut-outs -> labelled composite images tagged synthetic | Stretch |
| 7 | Annotator (SAM 3) | image + class prompts + exemplars -> masks, boxes, scores | Yes |
| 8 | Teacher / QA (Gemini) | image + labels + gold examples -> verdict pass/fail, reason, re-prompt hints (structured JSON) | Yes |
| 9 | Human-review router | failed-twice images -> review queue; records corrections | Yes (simple) |
| 10 | Dataset compiler | master labels + model record -> model-ready dataset version | Yes (YOLO) |
| 11 | Trainer | dataset version + model -> training run, live metrics, weights | Yes |
| 12 | Evaluator / reporter | weights + real test set -> mAP, per-class recall, report | Yes |
| 13 | Notifier | events -> in-app / email messages | Yes (in-app) |

Teacher loop rules (do not change without asking):
- Step A, metrics: label the 10 hold-out gold images with SAM 3, compute mask/box IoU vs human labels.
  If mean IoU is below the project threshold, fix prompts before labelling the full set.
- Step B, per image: cheap checks (empty mask, tiny/huge area, object count outliers), then Gemini review
  with 3-5 gold examples in the prompt. Gemini returns JSON: `{verdict, class_ok, missed_objects, bad_masks, hints}`.
- Fail -> re-run SAM 3 with Gemini's hints (points/boxes/prompt). Max 2 retries -> human queue.
- Gold images are never modified by any agent.
- Log every verdict with model version, prompt version, round number.

## 6. Development agents (how Claude should work on this repo)

Use subagents / parallel sessions with these roles. One owner per directory to avoid conflicts.

| Dev agent | Owns | Responsibilities |
|---|---|---|
| Architect / lead | /docs, API contracts | Keeps this plan current, defines schemas first, reviews merges |
| Backend | /backend/app | FastAPI, Firestore, GCS, Pub/Sub, auth-less MVP API |
| ML pipeline | /workers/sam3_annotator, /backend/agents (7, 8, 10) | SAM 3 inference, teacher loop, exporters |
| Training / MLOps | /workers/trainer, /infra | Colab Enterprise execution, containers, deploy scripts |
| Frontend | /frontend | 3 screens matching the mock-up |
| QA / test | /backend/tests, e2e | Unit tests per agent, one end-to-end test on a tiny dataset |

Working rules for Claude:
- Define the API schema and Firestore document shapes before implementing endpoints.
- Verify every external API against current official docs before coding (Gemini API, Grounding with
  Google Search, Colab Enterprise executions, SAM 3 repo). Do not rely on remembered signatures.
- Small commits per task; run tests before marking a task done.
- No secrets in code. Read config from environment variables (section 9).
- Any step that costs money (GPU job, bulk Gemini calls) must have a dry-run flag and a hard cap.
- If blocked on access (SAM 3 checkpoint, GCP quota), stop and report; build against a stub interface meanwhile.

## 7. Build phases and acceptance criteria

Phase 0 — Setup
- [x] Repo scaffold, lint, test runner, Dockerfiles
- [x] GCP project: enable Cloud Run, Firestore, Storage, Vertex AI, Artifact Registry, Secret Manager, Cloud Scheduler (Pub/Sub not enabled - replaced by the job document, see docs/api.md)
- [ ] ~~Request SAM 3 checkpoint access on Hugging Face (facebook/sam3)~~ - retired by A1.1
- Done when: "hello" API and frontend are deployed on Cloud Run. **Done 20 Nov 2026** - https://retrainix-801692371835.asia-south1.run.app

Phase 1 — Project + data intake
- [x] Create project (name, classes, models); upload video to GCS; sample, de-duplicate and blur-filter frames (A1.2) - live 20 Nov
- [ ] Upload the gold set (30 human-labelled images)
- [ ] Parse gold labels (YOLO/COCO) into master format; 20/10 split; de-dup + blur filter
- Done when: a project shows correct image counts and gold labels render as overlays.

Phase 2 — Model catalogue with Google Search
- [ ] Gemini call with google_search tool -> candidate models with source URLs
- [ ] Fetch model card, extract structured record, mark verified/unverified
- [ ] Seed one fully verified record: Ultralytics YOLO detection
- Done when: a search query returns cited candidates and the dropdown shows only verified models.

Phase 3 — SAM 3 annotator
- [x] Model pre-labelling instead of SAM 3 (A1.1): both recipes as ONNX on CPU; outputs outlines, boxes, scores in the master format; class map from model classes to project classes - 20 Nov
- [ ] ~~GPU container with SAM 3; text + exemplar prompting; outputs masks, boxes, scores~~ - retired by A1.1
- [ ] Batch job triggered from the API; progress events
- Done when: 100 unlabelled images are labelled and visible in the QA screen.

Phase 4 — Teacher loop
- [x] Hold-out IoU metric; cheap checks; Gemini structured review; retry with hints; human queue - built 20 Nov
- [x] Review UI: accept / reject / fix class / delete / draw a missing box - built 20 Nov
- [x] Gold set made in the app from frames a person reviewed, then frozen (replaces "upload 30 hand-annotated images") - built 20 Nov
- [ ] A person has made the real gold set (30 frames) for the demo project
- Done when: the QA screen shows pass rate, IoU on hold-out, at least one rejected-then-fixed image,
  and the loop always terminates.

Phase 5 — Dataset compiler
- [x] YOLO export (images/, labels/, data.yaml), split by session or by blocks of time, version v<n> in GCS - live 20 Nov; Ultralytics' own loader accepted an export (40 images, 0 corrupt)
- Done when: `yolo val` (or a format validator) accepts the exported dataset.

Phase 6 — Training + evaluation
- [x] Training launched from the backend as a Cloud Run job on CPU (A1.4; no GPU or Colab quota was usable) - a real run completed live 20 Nov: 3 epochs on 22 frames in 0.5 min
- [x] Epoch progress; weights (.pt, .onnx) saved to GCS and downloadable; every version scored on the frozen gold hold-out; promotion only if not worse - live 20 Nov
- [x] Retrain schedule (A1.5): Cloud Scheduler -> /internal/tick with a signed token; decision recorded per project - verified live 20 Nov (a skip; a scheduled START has not been observed live)
- [ ] ~~Parameterised notebook; Colab Enterprise runtime template~~ - replaced by the Cloud Run job
- Done when: one click produces weights and an mAP figure on held-out real images.

Phase 7 — Frontend polish + demo
- [ ] Three screens match the mock-up; notifications; licence notice
- [ ] Demo script with one real material dataset (e.g. PET / glass / aluminium)
- Done when: full flow runs live in under the demo time without manual fixes.

Phase 8 — Stretch items (section 2 order).

## 8. Testing

- Unit tests per runtime agent with small fixtures (5 images).
- Teacher loop test with a mocked Gemini response for pass, fail, and malformed JSON.
- Exporter test: round-trip master format -> YOLO -> boxes match.
- One end-to-end test on ~20 images with training limited to 1 epoch.
- Report all metrics with counts (n images, n objects), never a bare percentage.

## 9. Configuration (environment variables)

```
GCP_PROJECT_ID=
GCP_REGION=asia-south1     # Mumbai; fallback asia-southeast1 if a GPU/Colab Enterprise feature is missing
GCS_BUCKET=retrainix-data-<project-id>
GEMINI_API_KEY=            # from Secret Manager
GEMINI_MODEL_BULK=gemini-3.8-flash        # re-check current id in docs
GEMINI_MODEL_HARD=gemini-3.1-pro-preview  # preview id, re-check before the event
HF_TOKEN=                  # for gated SAM 3 weights
COLAB_RUNTIME_TEMPLATE=
QA_IOU_THRESHOLD=0.75      # suggested default
QA_MAX_RETRIES=2
GEMINI_MAX_CALLS_PER_PROJECT=2000   # suggested default
```

## 10. Risks and guardrails

- SAM 3 access is gated: request early; keep a stub annotator so other work continues.
- Gemini cannot judge pixel accuracy alone: metrics first, Gemini second, human sample third.
- 30 gold images is a small exam: require >= 5 examples per class; show sample size next to scores.
- Train/test leakage: split by capture session, never adjacent frames.
- Licences: show licence in the model dropdown (YOLO is AGPL-3.0 or paid licence).
- Cost: cap retries and Gemini calls; show an estimate before any bulk run.
- Privacy: images stay in the customer's bucket; no third-party uploads besides the Gemini API.
- IP: no REXTOR / IRES code or data goes into this repo.

## 11. Open questions for the team (answer before Phase 3)

1. Which Gemini models and what API budget for the event?
2. Is SAM 3 checkpoint access approved? Which GPU quota/region do we have?
3. Which real dataset is used for the demo, and who labels the 30 gold images?
4. Buildathon rules on reusing existing code.

## 12. Files that must exist before coding starts

| File | Purpose | Status |
|---|---|---|
| docs/plan.md | This plan | Ready |
| CLAUDE.md | Project-level instructions for Claude | Ready |
| config/agents.yaml | Rules for the 13 runtime agents (section 5) | Ready (suggested defaults; add project id to bucket name) |
| .claude/agents/architect-lead.md | Dev agent: contracts, plan, review | Ready |
| .claude/agents/backend-engineer.md | Dev agent: API, orchestrator, intake | Ready |
| .claude/agents/ml-pipeline-engineer.md | Dev agent: catalogue, SAM 3, teacher loop, exporters | Ready |
| .claude/agents/mlops-training-engineer.md | Dev agent: infra, Colab Enterprise, training | Ready |
| .claude/agents/frontend-engineer.md | Dev agent: Material 3 web UI | Ready |
| .claude/agents/qa-test-engineer.md | Dev agent: independent tests | Ready |
| docs/api.md, docs/schemas.md | Endpoint and document contracts | To write in Phase 0 (architect-lead) |
| infra/.env.example | Variables from section 9 | To write in Phase 0 |

UI: Material Design 3 (top app bar with search, navigation drawer, rounded cards, pill buttons, Roboto).
Do not use Google logos, product names or Google Sans.

## 13. References

- Product brief & validation (report): https://claude.ai/artifact/SKNXen99pGSbu75xXThjkz
- Dashboard mock-up: https://claude.ai/artifact/Lw3Rn8XeE8fBqfRjzZS18k
- SAM 3: https://ai.meta.com/blog/segment-anything-model-3/
- Grounding with Google Search: https://ai.google.dev/gemini-api/docs/google-search
- Colab Enterprise notebook executions: https://docs.cloud.google.com/colab/docs/schedule-notebook-run
