import { useCallback, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Link,
  Typography,
} from "@mui/material";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import { api, errorMessage, isJobActive, type DryRunEstimate, type Job, type Project } from "../api";
import { formatCount, inClassOrder, plural } from "../format";
import { useJobPolling, useLoad } from "../hooks";
import { ErrorRow, LoadingRow } from "./States";
import { StepTitle } from "./Step";

const POLL_MS = 2000;

function num(source: unknown, key: string): number | null {
  if (!source || typeof source !== "object") return null;
  const v = (source as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readEstimate(job: Job): DryRunEstimate | null {
  const e = job.result?.estimate;
  const images = num(e, "images");
  const gemini = num(e, "gemini_calls");
  const gpu = num(e, "gpu_minutes");
  if (images === null || gemini === null || gpu === null) return null;
  return { images, gemini_calls: gemini, gpu_minutes: gpu };
}

/** "28 frames, no Gemini calls, no GPU time" */
function estimateSentence(e: DryRunEstimate): string {
  const gemini = e.gemini_calls === 0 ? "no Gemini calls" : plural(e.gemini_calls, "Gemini call", "Gemini calls");
  const gpu = e.gpu_minutes === 0 ? "no GPU time" : `${formatCount(e.gpu_minutes)} GPU ${e.gpu_minutes === 1 ? "minute" : "minutes"}`;
  return `${plural(e.images, "frame", "frames")}, ${gemini}, ${gpu}`;
}

type Ask =
  | { phase: "idle" }
  | { phase: "estimating" }
  | { phase: "confirm"; estimate: DryRunEstimate }
  | { phase: "starting"; estimate: DryRunEstimate }
  | { phase: "error"; message: string };

/**
 * Starts pre-labelling and shows its progress and outcome. Always asks the API for a dry-run
 * estimate first and shows it before the real job is created.
 */
export default function PrelabelCard({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const pid = project.id;
  const frames = project.counts?.frames ?? 0;
  const unlabelled = Math.max(0, frames - (project.counts?.predicted ?? 0));

  // The newest real (not dry-run) prelabel job, so progress and result survive a reload.
  const [history, reloadHistory] = useLoad(
    async () => (await api.listJobs(pid, { type: "prelabel" })).find((j) => !j.dry_run) ?? null,
    [pid],
  );
  const [started, setStarted] = useState<Job | null>(null); // a job started or re-read on this page
  const job = started ?? (history.status === "ready" ? history.data : null);

  const [ask, setAsk] = useState<Ask>({ phase: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const onJobUpdate = useCallback(
    (next: Job) => {
      setStarted(next);
      if (!isJobActive(next)) onChanged();
    },
    [onChanged],
  );
  const pollError = useJobPolling(pid, job, onJobUpdate);

  const active = job !== null && isJobActive(job);
  const busy = ask.phase === "estimating" || ask.phase === "starting";

  const requestEstimate = async () => {
    setAsk({ phase: "estimating" });
    try {
      let dry = await api.createJob(pid, { type: "prelabel", dry_run: true, params: {} });
      // A dry run is a job like any other: re-read it until it has finished.
      while (isJobActive(dry)) {
        await new Promise((r) => window.setTimeout(r, POLL_MS));
        if (!alive.current) return;
        dry = await api.getJob(pid, dry.id);
      }
      if (!alive.current) return;
      if (dry.status !== "succeeded") {
        setAsk({ phase: "error", message: dry.error ?? `The estimate ${dry.status === "cancelled" ? "was cancelled" : "failed"} without a reason.` });
        return;
      }
      const estimate = readEstimate(dry);
      if (!estimate) {
        setAsk({ phase: "error", message: "The API returned no estimate, so nothing was started." });
        return;
      }
      setAsk({ phase: "confirm", estimate });
    } catch (err) {
      if (alive.current) setAsk({ phase: "error", message: errorMessage(err) });
    }
  };

  const start = async (estimate: DryRunEstimate) => {
    setAsk({ phase: "starting", estimate });
    try {
      const real = await api.createJob(pid, { type: "prelabel", dry_run: false, params: {} });
      if (!alive.current) return;
      setStarted(real);
      setAsk({ phase: "idle" });
      onChanged();
    } catch (err) {
      if (alive.current) setAsk({ phase: "error", message: errorMessage(err) });
    }
  };

  let reason: string | null = null;
  if (frames === 0) reason = "Add a video on Project setup first.";
  else if (unlabelled === 0) reason = "Every frame already has a label.";
  else if (active) reason = "Pre-labelling is running.";

  const total = job?.progress?.total ?? 0;
  const done = job?.progress?.done ?? 0;

  return (
    <Card component="section" aria-labelledby="prelabel-title">
      <CardContent sx={{ display: "grid", gap: 2, p: { xs: 2, sm: 3 } }}>
        <Box>
          <StepTitle n={2} id="prelabel-title">
            Pre-label frames
          </StepTitle>
          <Typography color="text.secondary">
            {frames === 0
              ? "This project has no frames yet."
              : unlabelled === 0
                ? `${frames === 1 ? "The 1 frame has" : `All ${formatCount(frames)} frames have`} a label.`
                : `${plural(unlabelled, "frame has", "frames have")} no label yet, out of ${formatCount(frames)}.`}{" "}
            Labelling starts by itself when a video's frames are ready; the button labels any frames that are still
            without a label.
          </Typography>
        </Box>

        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
          <Button
            variant="contained"
            startIcon={busy ? <CircularProgress size={18} color="inherit" aria-hidden /> : <AutoFixHighOutlinedIcon />}
            disabled={reason !== null || busy}
            aria-describedby={reason ? "prelabel-reason" : undefined}
            onClick={() => void requestEstimate()}
          >
            {ask.phase === "estimating"
              ? "Getting the estimate…"
              : unlabelled > 0
                ? `Pre-label ${plural(unlabelled, "frame", "frames")}`
                : "Pre-label frames"}
          </Button>
          {reason && (
            <Typography id="prelabel-reason" color="text.secondary">
              {reason}{" "}
              {frames === 0 && (
                <Link component={RouterLink} to={`/projects/${encodeURIComponent(pid)}`}>
                  Go to Project setup
                </Link>
              )}
            </Typography>
          )}
        </Box>

        {ask.phase === "error" && (
          <Alert severity="error" role="alert" onClose={() => setAsk({ phase: "idle" })} sx={{ overflowWrap: "anywhere" }}>
            Pre-labelling was not started: {ask.message}
          </Alert>
        )}

        {history.status === "loading" && <LoadingRow label="Checking for a pre-labelling run…" />}
        {history.status === "error" && !started && (
          <ErrorRow what="Earlier pre-labelling runs could not be loaded" message={history.message} onRetry={reloadHistory} />
        )}

        <Box aria-live="polite" sx={{ display: "grid", gap: 1.5 }}>
          {job && active && (
            <Box role="group" aria-label="Pre-labelling progress">
              <Typography variant="body2">
                {job.trigger === "auto" ? "Started by itself after the upload. " : ""}
                {job.status === "queued"
                  ? "Pre-labelling: waiting to start"
                  : total > 0
                    ? `Pre-labelling: ${formatCount(done)} of ${plural(total, "frame", "frames")}`
                    : "Pre-labelling…"}
              </Typography>
              <LinearProgress
                variant={job.status === "running" && total > 0 ? "determinate" : "indeterminate"}
                value={total > 0 ? Math.min(100, (done / total) * 100) : undefined}
                aria-label="Pre-labelling progress"
                sx={{ mt: 0.75, height: 8 }}
              />
              {pollError && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  The last progress check failed ({pollError}). Trying again every 2 seconds.
                </Typography>
              )}
            </Box>
          )}
          {job?.status === "failed" && (
            <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
              Pre-labelling failed: {job.error ?? "the job gave no reason."}
            </Alert>
          )}
          {job?.status === "cancelled" && <Alert severity="info">The last pre-labelling run was cancelled.</Alert>}
          {job?.status === "succeeded" && <PrelabelOutcome job={job} classes={project.classes} />}
        </Box>
      </CardContent>

      {(ask.phase === "confirm" || ask.phase === "starting") && (
        <Dialog
          open
          onClose={ask.phase === "starting" ? undefined : () => setAsk({ phase: "idle" })}
          fullWidth
          maxWidth="xs"
          aria-labelledby="prelabel-confirm-title"
          aria-describedby="prelabel-confirm-text"
        >
          <DialogTitle id="prelabel-confirm-title">Pre-label these frames?</DialogTitle>
          <DialogContent>
            <Typography id="prelabel-confirm-text">
              This run will use: <strong>{estimateSentence(ask.estimate)}</strong>.
            </Typography>
            <Typography color="text.secondary" variant="body2" sx={{ mt: 1 }}>
              The estimate comes from the API. The class mapping cannot be changed once frames are labelled.
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setAsk({ phase: "idle" })} disabled={ask.phase === "starting"}>
              Cancel
            </Button>
            <Button
              variant="contained"
              disabled={ask.phase === "starting"}
              startIcon={ask.phase === "starting" ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
              onClick={() => void start(ask.estimate)}
            >
              {ask.phase === "starting" ? "Starting…" : `Pre-label ${plural(ask.estimate.images, "frame", "frames")}`}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Card>
  );
}

/** The result of a finished run, in the job's own counts. Missing fields are left out. */
function PrelabelOutcome({ job, classes }: { job: Job; classes: string[] }) {
  const r = job.result;
  const images = num(r, "images");
  const objects = num(r, "objects");
  const mean = num(r, "objects_per_image_mean");
  const empty = num(r, "images_with_no_objects");
  const unmapped = num(r, "unmapped_objects");
  const seconds = num(r, "seconds");
  const perImage = num(r, "seconds_per_image");

  const perClassRaw = r?.per_class;
  // Firestore keeps no key order, so the chips follow the project's own class order.
  const perClassMap = (perClassRaw && typeof perClassRaw === "object" ? perClassRaw : {}) as Record<string, unknown>;
  const perClass: [string, number][] = inClassOrder(Object.keys(perClassMap), classes)
    .map((name) => [name, perClassMap[name]] as const)
    .filter((e): e is [string, number] => typeof e[1] === "number");

  const lm = r?.label_model as { recipe?: unknown; version?: unknown; profile?: unknown } | null | undefined;
  const labelledBy =
    lm && typeof lm.recipe === "string" && typeof lm.version === "number" && typeof lm.profile === "string"
      ? `Labelled by ${lm.recipe} v${lm.version}, profile ${lm.profile}`
      : null;

  if (images === null || objects === null) {
    return <Alert severity="success">The last pre-labelling run finished. It reported no counts.</Alert>;
  }

  const sentences = [
    `${plural(objects, "object", "objects")} on ${plural(images, "frame", "frames")}${
      mean !== null ? ` (${mean.toFixed(1)} per frame)` : ""
    }.`,
  ];
  if (empty !== null) {
    sentences.push(empty === 0 ? "Every frame had at least one object." : `${plural(empty, "frame", "frames")} had no objects.`);
  }
  if (unmapped !== null && unmapped > 0) {
    sentences.push(
      `${plural(unmapped, "detection was", "detections were")} ignored because ${
        unmapped === 1 ? "its" : "their"
      } class is not mapped.`,
    );
  }

  const timing =
    seconds !== null
      ? `Took ${seconds.toFixed(1)} s${perImage !== null ? ` (${perImage.toFixed(2)} s per frame)` : ""}.`
      : null;

  return (
    <Box sx={{ display: "grid", gap: 1 }}>
      <Typography>
        <Box component="span" sx={{ color: "text.secondary" }}>
          Last run:{" "}
        </Box>
        {sentences.join(" ")}
      </Typography>
      {perClass.length > 0 && (
        <Box component="ul" aria-label="Objects per class" sx={{ listStyle: "none", p: 0, m: 0, display: "flex", flexWrap: "wrap", gap: 1 }}>
          {perClass.map(([name, n]) => (
            <li key={name}>
              <Chip variant="outlined" label={`${name} ${formatCount(n)}`} sx={{ maxWidth: "100%" }} />
            </li>
          ))}
        </Box>
      )}
      {(labelledBy || timing) && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          {[labelledBy ? `${labelledBy}.` : null, timing].filter(Boolean).join(" ")}
        </Typography>
      )}
    </Box>
  );
}
