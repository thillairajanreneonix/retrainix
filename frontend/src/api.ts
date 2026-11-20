// API client. Contract: docs/api.md ("Object shapes" section). Every call goes through here.

// ---------- Shapes (docs/api.md, docs/schemas.md) ----------

export type Health = { status: string; version: string };

export type PublicConfig = {
  product: string;
  region: string;
  limits: Record<string, number>;
  qa: { holdout_iou_min: number; max_retries: number };
  gold_set: {
    required_images: number;
    min_examples_per_class: number;
    exemplar_count: number;
    holdout_count: number;
  };
  schedule: { tick_minutes: number; min_interval_hours: number; min_new_approved_images: number };
};

export type ProjectCounts = {
  gold_exemplar: number;
  gold_holdout: number;
  frames: number;
  predicted: number;
  passed: number;
  human_review: number;
  human_done: number;
  rejected: number;
};

export type Project = {
  id: string;
  name: string;
  classes: string[];
  recipe: string;
  prelabel_recipe: string;
  class_map: Record<string, string>; // pre-label model class -> project class
  class_map_source: "name_match" | "user";
  state: string;
  retrain_interval_hours: number | null;
  last_retrain_at: string | null;
  active_model_version: number | null;
  counts: ProjectCounts;
  holdout?: HoldoutResult | null; // the last holdout_check result, once one has run
  schedule_set_at?: string | null;
  last_tick?: { at: string; decision: string; reason: string } | null; // why the last scheduled check did or did not run
  gemini_calls_used: number;
  created_at: string;
  updated_at: string;
};

export type NewProject = {
  name: string;
  classes: string[];
  recipe: string;
  prelabel_recipe: string;
  class_map: Record<string, string>;
};

export type ModelRecord = {
  id: string;
  name: string;
  task: string | null;
  input_size: number | null;
  dataset_format: string | null;
  licence: string | null;
  licence_notice: string | null;
  min_gpu_memory_gb: number | null;
  source_url: string | null;
  source: string;
  unverified_fields: string[];
  can_prelabel: boolean;
  can_train: boolean;
  classes: string[];
};

export type AssetSource = "file" | "camera";
export type AssetKind = "video" | "images" | "gold_images" | "gold_labels";
// "pending" (upload link issued, file not confirmed) is never listed by the API.
export type AssetStatus = "pending" | "uploaded" | "processing" | "ready" | "failed";

export type UploadRequest = {
  kind: AssetKind;
  filename: string;
  content_type: string; // the bare media type, e.g. "video/webm" - no ";codecs=" suffix
  size_bytes: number;
  source?: AssetSource; // "file" when left out
};

export type UploadTicket = {
  asset_id: string;
  upload_url: string; // absolute, or relative in local development
  method: string; // "PUT"
  headers: Record<string, string>; // send exactly these with the upload
};

export type Asset = {
  id: string;
  project_id: string;
  kind: AssetKind;
  filename: string;
  content_type: string;
  size_bytes: number;
  gcs_uri: string;
  session_id: string;
  status: AssetStatus;
  frames_extracted: number;
  frames_kept: number;
  job_id: string | null;
  created_at: string;
  source?: AssetSource; // absent on older assets = "file"
};

export type JobType =
  | "extract_frames"
  | "import_gold"
  | "prelabel"
  | "holdout_check"
  | "qa"
  | "compile"
  | "train"
  | "evaluate";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type Job = {
  id: string;
  project_id: string;
  type: JobType;
  status: JobStatus;
  dry_run: boolean;
  trigger: "user" | "schedule";
  params: Record<string, unknown>;
  progress: { done: number; total: number };
  result: Record<string, unknown>;
  error: string | null;
  execution: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

// `result` of a succeeded extract_frames job.
export type ExtractFramesResult = {
  frames_extracted: number;
  frames_kept: number;
  dropped_duplicate: number;
  dropped_blurry: number;
  video_seconds: number;
  sample_every_seconds: number;
  timing?: "timestamps" | "frame_index"; // browser recordings are sampled by each frame's timestamp
  stopped_at_max_frames?: boolean; // the recording was longer than the frame cap covers
};

export type ImageRole = "gold_exemplar" | "gold_holdout" | "unlabelled";
export type LabelStatus =
  | "none"
  | "predicted"
  | "passed"
  | "failed"
  | "human_review"
  | "human_done"
  | "rejected"
  | "gold";

export type Image = {
  id: string;
  project_id: string;
  gcs_uri: string;
  width: number;
  height: number;
  asset_id: string;
  session_id: string;
  role: ImageRole;
  phash: string;
  blur_score: number | null;
  label_status: LabelStatus;
  round: number;
  label_uri: string | null;
  object_count: number;
  timestamp_s: number | null;
  missing_outlines?: number; // objects in the latest label with no outline; absent on older data = 0
};

export type ImagePage = { images: Image[]; next_cursor: string | null };

// ---------- Pre-labelling (docs/api.md "Pre-labelling (plan A1.1)") ----------

export type LabelModel = { recipe: string; version: number; profile: string };

export type LabelSource = "gold" | "model" | "human";

export type LabelObject = {
  id: string;
  class: string; // one of the project's class names
  bbox_xyxy: [number, number, number, number]; // pixels of the stored original
  polygon_xy: [number, number][] | null; // outline in the same pixels, or null when the object has only a box
  mask_rle: { size: [number, number]; counts: string } | null;
  source: LabelSource;
  score: number | null;
  round: number;
  class_source?: "gemini"; // the class was changed by the Gemini check
  model_class_before?: string; // the class before that change
  added_in_round?: number; // the object was added on a retry
};

/** Master label format, schemas.md section 2. */
export type MasterLabel = {
  image_id: string;
  width: number;
  height: number;
  round: number;
  label_model: LabelModel | null; // null for gold labels
  objects: LabelObject[];
  review?: { by: string; action: "accept" | "fix"; at: string };
};

/** One QA decision, schemas.md section 3. Read here, shown by the review task. */
export type Verdict = {
  id: string;
  image_id: string;
  round: number;
  stage: "cheap_check" | "gemini";
  verdict: "pass" | "fail";
  class_ok: boolean;
  missed_objects: number;
  bad_masks: string[];
  hints: {
    class_fixes?: { object_id: string; class: string; confidence?: string }[];
    retry_profile?: string;
    note?: string;
  };
  reason: string;
  judge_model: string;
  prompt_version: string;
  label_model: LabelModel | null;
  created_at: string;
};

export type ImageDetail = { image: Image; label: MasterLabel | null; verdicts: Verdict[] };

export type NewJob = { type: JobType; dry_run: boolean; params: Record<string, unknown> };

// `result` of a succeeded prelabel job.
export type PrelabelResult = {
  images: number;
  objects: number;
  objects_per_image_mean: number;
  images_with_no_objects: number;
  unmapped_objects: number;
  per_class: Record<string, number>;
  label_model: LabelModel;
  seconds: number;
  seconds_per_image: number;
};

// `result.estimate` of a succeeded dry-run job.
export type DryRunEstimate = { images: number; gemini_calls: number; gpu_minutes: number };

// ---------- Review, gold set and the teacher loop (docs/api.md, last section) ----------

/** One entry of a "fix": an existing object by id, or a new box with id null. */
export type ReviewObject = { id: string | null; class: string; bbox_xyxy: [number, number, number, number] };

export type ReviewBody =
  | { action: "accept"; objects: ReviewObject[] } // objects is ignored
  | { action: "reject"; objects: ReviewObject[] } // objects is ignored
  | { action: "fix"; objects: ReviewObject[] }; // the complete corrected list

export type ReviewResponse = { image: Image; label: MasterLabel | null };

export type GoldStatus = {
  frozen: boolean;
  required_images: number;
  exemplar_count: number;
  holdout_count: number;
  min_examples_per_class: number;
  reviewed_images: number; // human_done frames available
  objects_per_class: Record<string, number>; // in those frames; every project class is listed
  ready_to_freeze: boolean;
  blocking: string[];
  gold_exemplar: number;
  gold_holdout: number;
  holdout_note: string | null;
  boxes_without_outline?: number; // in the reviewed frames, before the freeze; 0 after; absent = 0
};

// `result` of a holdout_check job; also QaSummary.holdout and project.holdout.
export type HoldoutResult = {
  mean_iou: number;
  threshold: number;
  passed: boolean;
  n_images: number;
  n_objects_gold: number;
  n_objects_model: number;
  matched: number;
  precision: number;
  recall: number;
  class_agreement: number;
  map50: number;
  map50_95: number;
  per_class_recall: Record<string, { recall: number; n: number }>;
  label_model: LabelModel;
  eval_set: string;
};

// `result.estimate` of a qa dry run. gemini_calls is the worst case.
export type QaEstimate = DryRunEstimate & { gemini_calls_remaining: number };

// `result` of a qa job; also QaSummary.last_qa.
export type QaResult = {
  images: number;
  passed: number;
  human_review: number;
  rounds: Record<string, number>; // round in which each passed frame passed
  gemini_calls: number;
  invalid_responses: number;
  last_invalid_reason?: string | null;
  cheap_check_failures: number; // frame-rounds that a rule failed
  class_fixes_applied: number;
  objects_added: number;
  stopped_at_cap: boolean;
  judge_model: string;
  prompt_version: string;
  seconds: number;
};

export type QaSummary = {
  holdout: HoldoutResult | null;
  images: {
    frames: number;
    predicted: number;
    waiting_for_qa: number;
    passed: number;
    human_review: number;
    human_done: number;
    rejected: number;
  };
  pass_rate: number | null; // passed / (passed + human_review + human_done + rejected); null when n_images is 0
  n_images: number;
  last_qa: QaResult | null;
  gemini_calls: { used: number; cap: number };
  // Plain counts of boxes with no outline, on frames that are not gold; absent = none.
  // Nothing draws those outlines: a box-only object is exported as its rectangle.
  outlines?: { frames_missing: number; objects_missing: number };
};

// ---------- Dataset, training, model versions and the schedule (docs/api.md, last section) ----------

export type DatasetSplit = { images: number; objects: number; sessions: string[] };

// `result` of a compile job; a DatasetVersion document is the same fields plus created_at.
export type DatasetVersion = {
  id?: string;
  version: number;
  gcs_prefix: string;
  format: string; // "coco_json": train/, valid/, test/ folders, each with _annotations.coco.json beside its images
  image_size: number;
  images: number;
  splits: Record<string, DatasetSplit>; // train, val, test
  label_sources: Record<string, number>; // objects, by who made the label
  objects_per_class: Record<string, number>;
  validated: boolean;
  validated_by: string;
  created_at: string;
};

/** Same shape as the holdout_check result; every figure goes with n_images and n_objects_gold. */
export type ModelMetrics = HoldoutResult;

export type ModelVersion = {
  id: string;
  version: number;
  recipe: string;
  parent: string; // "seed" or "v<n>"
  dataset_version: number | null; // null for version 0, the seed weights
  status: "training" | "evaluating" | "ready" | "failed";
  trigger: "seed" | "user" | "schedule";
  metrics: Partial<ModelMetrics> | null;
  promoted?: boolean | null;
  promotion_note?: string | null;
  weights?: { pt: boolean; onnx: boolean }; // which downloads exist
  train_minutes?: number | null;
  epochs_run?: number | null;
  created_at: string;
};

// `result.estimate` of a train dry run.
export type TrainEstimate = {
  train_images: number;
  val_images: number;
  epochs: number;
  gemini_calls: number;
  gpu_minutes: number;
  compute: string;
  max_minutes: number;
};

export type TrainStage = "compiling" | "training" | "exporting" | "evaluating";

// `result` of a succeeded train job (the new ModelVersion's main fields).
export type TrainResult = {
  version: number;
  dataset_version: number;
  parent: string;
  epochs_run: number;
  train_minutes: number;
  metrics: Partial<ModelMetrics>;
  previous: { version: number; map50: number } | null;
  promoted: boolean;
  promotion_note: string;
};

export type WeightsFormat = "pt" | "onnx";
export type WeightsLink = { url: string; filename: string };

export type EventType = "dataset_ready" | "training_done" | "needs_human_review" | "pipeline_failed";

export type ProjectEvent = {
  id: string;
  project_id: string;
  type: EventType;
  message: string;
  job_id: string | null;
  read: boolean;
  created_at: string;
};

export function isJobActive(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

// ---------- Errors ----------

/** An error answered by the API as {"error": {"code", "message"}}, or a transport failure. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** Text safe to show a person for anything thrown by this client. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

function errorFromBody(body: unknown, status: number): ApiError {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; detail?: unknown };
    if (b.error && typeof b.error === "object") {
      const e = b.error as { code?: unknown; message?: unknown };
      const code = typeof e.code === "string" ? e.code : "error";
      const message = typeof e.message === "string" && e.message ? e.message : `The API answered ${status}.`;
      return new ApiError(message, code, status);
    }
    // FastAPI's own validation errors, in case one slips through un-wrapped.
    if (typeof b.detail === "string") return new ApiError(b.detail, "error", status);
  }
  return new ApiError(`The API answered ${status}.`, "http_error", status);
}

async function request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("The API could not be reached. Check the connection and try again.", "network", 0);
  }

  let parsed: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) throw errorFromBody(parsed, res.status);
  if (parsed === undefined) {
    throw new ApiError("The API answered with something that is not JSON.", "bad_response", res.status);
  }
  return parsed as T;
}

const enc = encodeURIComponent;

// ---------- Calls ----------

export const api = {
  health: () => request<Health>("GET", "/api/health"),
  config: () => request<PublicConfig>("GET", "/api/config"),

  listModels: async () => (await request<{ models: ModelRecord[] }>("GET", "/api/models")).models,

  listProjects: async () => (await request<{ projects: Project[] }>("GET", "/api/projects")).projects,
  getProject: (pid: string) => request<Project>("GET", `/api/projects/${enc(pid)}`),
  createProject: (body: NewProject) => request<Project>("POST", "/api/projects", body),
  /** Replaces the whole class map. Ignored model classes are simply left out. */
  putClassMap: (pid: string, classMap: Record<string, string>) =>
    request<Project>("PUT", `/api/projects/${enc(pid)}/class-map`, { class_map: classMap }),

  createUpload: (pid: string, body: UploadRequest) =>
    request<UploadTicket>("POST", `/api/projects/${enc(pid)}/uploads`, body),
  completeAsset: (pid: string, assetId: string) =>
    request<Job>("POST", `/api/projects/${enc(pid)}/assets/${enc(assetId)}/complete`),
  listAssets: async (pid: string) =>
    (await request<{ assets: Asset[] }>("GET", `/api/projects/${enc(pid)}/assets`)).assets,

  getJob: (pid: string, jid: string) => request<Job>("GET", `/api/projects/${enc(pid)}/jobs/${enc(jid)}`),
  createJob: (pid: string, body: NewJob) => request<Job>("POST", `/api/projects/${enc(pid)}/jobs`, body),
  /** Newest first. */
  listJobs: async (pid: string, opts: { type?: JobType; status?: JobStatus } = {}) => {
    const q = new URLSearchParams();
    if (opts.type) q.set("type", opts.type);
    if (opts.status) q.set("status", opts.status);
    const qs = q.toString();
    return (await request<{ jobs: Job[] }>("GET", `/api/projects/${enc(pid)}/jobs${qs ? `?${qs}` : ""}`)).jobs;
  },

  listImages: (
    pid: string,
    opts: { limit?: number; cursor?: string | null; status?: LabelStatus; role?: ImageRole } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.role) q.set("role", opts.role);
    q.set("limit", String(opts.limit ?? 60));
    if (opts.cursor) q.set("cursor", opts.cursor);
    return request<ImagePage>("GET", `/api/projects/${enc(pid)}/images?${q.toString()}`);
  },
  /** accept / fix / reject one frame. 403 for a gold image, 409 when the frame has no label yet. */
  reviewImage: (pid: string, imageId: string, body: ReviewBody) =>
    request<ReviewResponse>("POST", `/api/projects/${enc(pid)}/images/${enc(imageId)}/review`, body),

  getGold: (pid: string) => request<GoldStatus>("GET", `/api/projects/${enc(pid)}/gold`),
  /** Cannot be undone. 409 with the reasons when the set is not ready. */
  freezeGold: (pid: string) => request<GoldStatus>("POST", `/api/projects/${enc(pid)}/gold/freeze`),
  getQaSummary: (pid: string) => request<QaSummary>("GET", `/api/projects/${enc(pid)}/qa/summary`),

  /** Oldest first. */
  listDatasetVersions: async (pid: string) =>
    (await request<{ dataset_versions: DatasetVersion[] }>("GET", `/api/projects/${enc(pid)}/dataset-versions`))
      .dataset_versions,
  /** Oldest first: the accuracy trend. */
  listModelVersions: async (pid: string) =>
    (await request<{ model_versions: ModelVersion[] }>("GET", `/api/projects/${enc(pid)}/model-versions`))
      .model_versions,
  /** A short-lived download link for one version's weights. */
  getWeightsLink: (pid: string, version: number, format: WeightsFormat) =>
    request<WeightsLink>(
      "GET",
      `/api/projects/${enc(pid)}/model-versions/${enc(String(version))}/weights?format=${format}`,
    ),
  /** Hours between scheduled retrains, or null for manual only. 422 below the minimum interval. */
  putSchedule: (pid: string, hours: number | null) =>
    request<Project>("PUT", `/api/projects/${enc(pid)}/schedule`, { retrain_interval_hours: hours }),

  /** Newest first. */
  listEvents: async (pid: string, opts: { unread?: boolean } = {}) =>
    (await request<{ events: ProjectEvent[] }>("GET", `/api/projects/${enc(pid)}/events${opts.unread ? "?unread=true" : ""}`))
      .events,
  markEventRead: (pid: string, eventId: string) =>
    request<ProjectEvent>("POST", `/api/projects/${enc(pid)}/events/${enc(eventId)}/read`),

  /** One image with its latest label (or null) and its QA verdicts (oldest first). */
  getImageDetail: (pid: string, imageId: string) =>
    request<ImageDetail>("GET", `/api/projects/${enc(pid)}/images/${enc(imageId)}`),

  /** URL of an image's bytes, resized for display only. Used as an <img src>. */
  imageFileUrl: (pid: string, imageId: string, width?: number) =>
    `/api/projects/${enc(pid)}/images/${enc(imageId)}/file${width ? `?w=${width}` : ""}`,
};

// ---------- Direct-to-storage upload ----------

export type UploadHandle = { done: Promise<void>; abort: () => void };

/**
 * Sends the file straight to storage with the method, URL and exactly the headers the API
 * returned. XMLHttpRequest is used because fetch has no upload progress events.
 */
export function uploadFile(
  ticket: UploadTicket,
  file: File,
  onProgress: (sentBytes: number, totalBytes: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open(ticket.method || "PUT", ticket.upload_url);
    for (const [name, value] of Object.entries(ticket.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(ev.loaded, ev.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let body: unknown = undefined;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      const err = errorFromBody(body, xhr.status);
      reject(
        err.code === "http_error"
          ? new ApiError(`Storage refused the upload (${xhr.status}).`, "upload_failed", xhr.status)
          : err,
      );
    };
    xhr.onerror = () =>
      reject(new ApiError("The upload was interrupted. Check the connection and try again.", "network", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", "aborted", 0));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}
