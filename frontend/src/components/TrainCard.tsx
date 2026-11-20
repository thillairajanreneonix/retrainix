import { Link as RouterLink } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Link,
  Typography,
} from "@mui/material";
import ModelTrainingOutlinedIcon from "@mui/icons-material/ModelTrainingOutlined";
import type { Job, Project } from "../api";
import { formatCount, formatShare, plural, readNumber } from "../format";
import { useStepJob } from "../hooks";
import { ErrorRow, LoadingRow } from "./States";
import { JobEnded, WaitingNote } from "./Step";

const TRAIN_PARAMS = { compile_first: true };

const STAGE_WORDS: Record<string, string> = {
  compiling: "Compiling the dataset",
  training: "Training",
  exporting: "Exporting the weights",
  evaluating: "Scoring on the gold hold-out",
};

/** "40 training frames and 12 validation frames, 3 epochs, on Cloud Run job, 8 vCPU, CPU only. No GPU. ..." */
function estimateSentence(e: Record<string, unknown>): string | null {
  const train = readNumber(e, "train_images");
  const val = readNumber(e, "val_images");
  const epochs = readNumber(e, "epochs");
  const gpu = readNumber(e, "gpu_minutes");
  const max = readNumber(e, "max_minutes");
  const compute = typeof e.compute === "string" && e.compute ? e.compute : null;
  if (train === null || val === null || epochs === null) return null;
  let s = `${plural(train, "training frame", "training frames")} and ${plural(val, "validation frame", "validation frames")}, ${plural(epochs, "epoch", "epochs")}`;
  if (compute) s += `, on ${compute}`;
  s += ".";
  if (gpu !== null) s += gpu === 0 ? " No GPU." : ` ${formatCount(gpu)} GPU minutes.`;
  if (max !== null) s += ` Stops after at most ${plural(max, "minute", "minutes")}.`;
  return s;
}

function TrainProgress({ job, pollError }: { job: Job; pollError: string | null }) {
  const stage = typeof job.result?.stage === "string" ? job.result.stage : null;
  const total = job.progress?.total ?? 0;
  const done = job.progress?.done ?? 0;
  const training = stage === "training" || (stage === null && job.status === "running" && total > 0);
  const determinate = job.status === "running" && training && total > 0;

  let text: string;
  if (job.status === "queued") text = "Waiting to start";
  else if (determinate) text = `Training: ${formatCount(done)} of ${plural(total, "epoch", "epochs")} finished`;
  else text = stage ? `${STAGE_WORDS[stage] ?? stage}…` : "Running…";

  return (
    <Box role="group" aria-label="Training progress">
      <Typography variant="body2">{text}</Typography>
      <LinearProgress
        variant={determinate ? "determinate" : "indeterminate"}
        value={determinate ? Math.min(100, (done / total) * 100) : undefined}
        aria-label="Training progress"
        sx={{ mt: 0.75, height: 8, borderRadius: "4px" }}
      />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        Training runs on CPU on Cloud Run. You can leave this page; the run carries on.
        {job.trigger === "schedule" ? " This run was started by the schedule." : ""}
      </Typography>
      {pollError && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          The last progress check failed ({pollError}). Trying again every 2 seconds.
        </Typography>
      )}
    </Box>
  );
}

function TrainOutcome({ result }: { result: Record<string, unknown> }) {
  const version = readNumber(result, "version");
  const map50 = readNumber(result.metrics, "map50");
  const nImages = readNumber(result.metrics, "n_images");
  const nObjects = readNumber(result.metrics, "n_objects_gold");
  const previous = readNumber(result.previous, "map50");
  const previousVersion = readNumber(result.previous, "version");
  const promoted = typeof result.promoted === "boolean" ? result.promoted : null;
  const note = typeof result.promotion_note === "string" && result.promotion_note ? result.promotion_note : null;
  const minutes = readNumber(result, "train_minutes");
  const epochs = readNumber(result, "epochs_run");

  if (version === null) {
    return <Alert severity="warning">The last training run finished but did not report a version.</Alert>;
  }

  const counts =
    nImages !== null
      ? ` (n = ${plural(nImages, "image", "images")}${nObjects !== null ? `, ${plural(nObjects, "object", "objects")}` : ""})`
      : "";

  return (
    <Alert severity={promoted === false ? "warning" : "success"} sx={{ overflowWrap: "anywhere" }}>
      <Box>
        {map50 !== null
          ? `Version ${version} scored ${formatShare(map50)} mAP50 on the gold hold-out${counts}`
          : `Version ${version} was trained, but it reports no mAP50`}
        {previous !== null
          ? `; the previous active version${previousVersion !== null ? ` (v${previousVersion})` : ""} scored ${formatShare(previous)}.`
          : "."}
      </Box>
      {note && <Box sx={{ mt: 0.5 }}>{note}</Box>}
      {promoted !== null && (
        <Box sx={{ mt: 0.5, fontWeight: 500 }}>
          {promoted
            ? `Version ${version} is now the active model.`
            : `Version ${version} was kept but is not the active model.`}
        </Box>
      )}
      {(epochs !== null || minutes !== null) && (
        <Box sx={{ mt: 0.5 }}>
          {[epochs !== null ? plural(epochs, "epoch", "epochs") : null, minutes !== null ? `${minutes.toFixed(1)} minutes of training` : null]
            .filter(Boolean)
            .join(", ")}
          .
        </Box>
      )}
    </Alert>
  );
}

/**
 * Starts a training run: a dry run first, its estimate confirmed, then the real job. Shows
 * the stage and epoch progress, and the hold-out score of the new version when it is done.
 */
export default function TrainCard({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const pid = project.id;
  const step = useStepJob(pid, "train", onChanged, TRAIN_PARAMS);
  const { job, active, ask } = step;

  let waiting: React.ReactNode = null;
  if (active) waiting = "A training run is in progress.";
  else if (!project.holdout) {
    waiting = (
      <>
        Run the hold-out check first —{" "}
        <Link component={RouterLink} to={`/projects/${encodeURIComponent(pid)}/qa`}>
          Annotation QA, step 4
        </Link>
        . Without it there is nothing to score a new version against.
      </>
    );
  }

  const estimateText =
    (ask.phase === "confirm" || ask.phase === "starting") && ask.estimate ? estimateSentence(ask.estimate) : null;
  const succeeded = job?.status === "succeeded" && job.result && readNumber(job.result, "version") !== null;

  return (
    <Card component="section" aria-labelledby="train-title">
      <CardContent sx={{ display: "grid", gap: 2, p: { xs: 2, sm: 3 } }}>
        <Box>
          <Typography id="train-title" variant="h5" component="h3">
            Train a new version
          </Typography>
          <Typography color="text.secondary">
            The frames that passed the check or were checked by a person are exported as a new dataset. Training
            starts from the active version and runs on CPU on Cloud Run, because this project has no GPU quota. The
            result is scored on the gold hold-out, and it becomes the active model only if it scores at least as
            well as the current one.
          </Typography>
        </Box>

        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
          <Button
            variant="contained"
            startIcon={step.busy ? <CircularProgress size={18} color="inherit" aria-hidden /> : <ModelTrainingOutlinedIcon />}
            disabled={waiting !== null || step.busy}
            aria-describedby={waiting ? "train-waiting" : undefined}
            onClick={() => void step.requestEstimate()}
          >
            {ask.phase === "estimating" ? "Getting the estimate…" : "Train a new version"}
          </Button>
          {waiting && <WaitingNote id="train-waiting">{waiting}</WaitingNote>}
        </Box>

        {ask.phase === "error" && (
          <Alert severity="error" role="alert" onClose={step.dismiss} sx={{ overflowWrap: "anywhere" }}>
            Training was not started: {ask.message}
          </Alert>
        )}

        {step.history.status === "loading" && <LoadingRow label="Checking for a training run…" />}
        {step.history.status === "error" && !job && (
          <ErrorRow what="Earlier training runs could not be loaded" message={step.history.message} onRetry={step.reloadHistory} />
        )}

        <Box aria-live="polite" sx={{ display: "grid", gap: 1.5 }}>
          {job && active && <TrainProgress job={job} pollError={step.pollError} />}
          {job && !active && <JobEnded job={job} name="Training" />}
          {job && succeeded && <TrainOutcome result={job.result} />}
        </Box>
      </CardContent>

      {(ask.phase === "confirm" || ask.phase === "starting") && (
        <Dialog
          open
          onClose={ask.phase === "starting" ? undefined : step.dismiss}
          fullWidth
          maxWidth="xs"
          aria-labelledby="train-confirm-title"
          aria-describedby="train-confirm-text"
        >
          <DialogTitle id="train-confirm-title">Train a new version?</DialogTitle>
          <DialogContent>
            {estimateText ? (
              <Typography id="train-confirm-text">{estimateText}</Typography>
            ) : (
              <Alert id="train-confirm-text" severity="warning">
                The API's estimate did not say how many frames or epochs this run would use.
              </Alert>
            )}
            <Typography color="text.secondary" variant="body2" sx={{ mt: 1 }}>
              A fresh dataset version is exported first. The new version replaces the active model only if it does
              at least as well on the gold hold-out.
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={step.dismiss} disabled={ask.phase === "starting"}>
              Cancel
            </Button>
            <Button
              variant="contained"
              disabled={ask.phase === "starting" || !estimateText}
              startIcon={ask.phase === "starting" ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
              onClick={() => void step.start(ask.estimate)}
            >
              {ask.phase === "starting" ? "Starting…" : "Start training"}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Card>
  );
}
