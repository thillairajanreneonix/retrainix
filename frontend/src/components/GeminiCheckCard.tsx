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
  Typography,
} from "@mui/material";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import type { Project, QaSummary } from "../api";
import { formatCount, plural, readNumber } from "../format";
import { useStepJob, type Load } from "../hooks";
import { ErrorRow, LoadingRow } from "./States";
import { JobEnded, JobProgress, StepTitle, WaitingNote } from "./Step";

/** "28 frames, at most 84 Gemini calls (2,000 remaining of the project cap), no GPU time" */
function estimateSentence(estimate: Record<string, unknown>, cap: number | null): string | null {
  const images = readNumber(estimate, "images");
  const calls = readNumber(estimate, "gemini_calls");
  const gpu = readNumber(estimate, "gpu_minutes");
  const remaining = readNumber(estimate, "gemini_calls_remaining");
  if (images === null || calls === null) return null;

  let s = `${plural(images, "frame", "frames")}, at most ${plural(calls, "Gemini call", "Gemini calls")}`;
  if (remaining !== null) {
    s += ` (${formatCount(remaining)} remaining of the project cap${cap !== null ? ` of ${formatCount(cap)}` : ""})`;
  }
  if (gpu !== null) s += gpu === 0 ? ", no GPU time" : `, ${formatCount(gpu)} GPU ${gpu === 1 ? "minute" : "minutes"}`;
  return s;
}

/** "11 passed first time, 6 after one correction, 2 after two" */
function roundsSentence(rounds: unknown): string | null {
  if (!rounds || typeof rounds !== "object") return null;
  const words = ["first time", "after one correction", "after two", "after three", "after four"];
  const parts = Object.entries(rounds as Record<string, unknown>)
    .map(([k, v]) => [Number(k), v] as const)
    .filter((e): e is readonly [number, number] => Number.isInteger(e[0]) && e[0] >= 0 && typeof e[1] === "number")
    .sort((a, b) => a[0] - b[0])
    .filter(([, n]) => n > 0)
    .map(([round, n], i) => `${formatCount(n)}${i === 0 ? " passed" : ""} ${words[round] ?? `after ${round} corrections`}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function QaOutcome({ result }: { result: Record<string, unknown> }) {
  const images = readNumber(result, "images");
  const passed = readNumber(result, "passed");
  const review = readNumber(result, "human_review");
  if (images === null || passed === null) {
    return <Alert severity="warning">The last Gemini check finished but reported no counts.</Alert>;
  }
  const rounds = roundsSentence(result.rounds);
  const fixes = readNumber(result, "class_fixes_applied");
  const added = readNumber(result, "objects_added");
  const calls = readNumber(result, "gemini_calls");
  const invalid = readNumber(result, "invalid_responses");
  const cheap = readNumber(result, "cheap_check_failures");
  const seconds = readNumber(result, "seconds");
  const judge = typeof result.judge_model === "string" ? result.judge_model : null;
  const prompt = typeof result.prompt_version === "string" ? result.prompt_version : null;

  const lastInvalid =
    typeof result.last_invalid_reason === "string" && result.last_invalid_reason ? result.last_invalid_reason : null;

  const facts: string[] = [];
  if (fixes !== null) facts.push(`${plural(fixes, "class fix", "class fixes")} applied`);
  if (added !== null) facts.push(`${plural(added, "object", "objects")} added`);
  if (calls !== null) facts.push(`${plural(calls, "Gemini call", "Gemini calls")} used by this run`);
  if (invalid !== null && invalid > 0) {
    facts.push(
      `${plural(invalid, "invalid response", "invalid responses")} from Gemini${lastInvalid ? `. The last one: ${lastInvalid}` : ""}`,
    );
  }
  if (cheap !== null && cheap > 0) {
    facts.push(`${plural(cheap, "time", "times")} a frame failed a rule check in a round, before Gemini saw it`);
  }

  return (
    <Box sx={{ display: "grid", gap: 1 }}>
      {result.stopped_at_cap === true && (
        <Alert severity="warning">
          This run stopped early because the project's Gemini call cap was reached.
        </Alert>
      )}
      <Typography>
        <Box component="span" sx={{ color: "text.secondary" }}>
          Last run:{" "}
        </Box>
        {formatCount(passed)} of {plural(images, "frame", "frames")} passed
        {review !== null ? `; ${formatCount(review)} ${review === 1 ? "needs" : "need"} a person.` : "."}
      </Typography>
      {rounds && <Typography sx={{ overflowWrap: "anywhere" }}>{rounds}.</Typography>}
      {facts.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {facts.map((f) => (
            <Typography component="li" key={f} sx={{ overflowWrap: "anywhere" }}>
              {f}
            </Typography>
          ))}
        </Box>
      )}
      {(judge || prompt || seconds !== null) && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          {[
            judge ? `Judged by ${judge}` : null,
            prompt ? `prompt ${prompt}` : null,
            seconds !== null ? `took ${seconds.toFixed(1)} s` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Typography>
      )}
    </Box>
  );
}

/**
 * Step 5: Gemini reviews each waiting frame's labels. A dry run comes first and its estimate,
 * with the worst-case number of Gemini calls, is confirmed before the real run starts.
 */
export default function GeminiCheckCard({
  project,
  summary,
  onRetrySummary,
  onChanged,
}: {
  project: Project;
  summary: Load<QaSummary>;
  onRetrySummary: () => void;
  onChanged: () => void;
}) {
  const step = useStepJob(project.id, "qa", onChanged);
  const { job, active, ask } = step;
  const s = summary.status === "ready" ? summary.data : null;

  const fromJob = job?.status === "succeeded" && job.result && Object.keys(job.result).length > 0 ? job.result : null;
  const result = fromJob ?? (active ? null : ((s?.last_qa as Record<string, unknown> | null | undefined) ?? null));

  let waiting: string | null = null;
  if (active) waiting = "The Gemini check is running.";
  else if (s) {
    if (!s.holdout) waiting = "Waiting for the hold-out check (step 4).";
    else if (!s.holdout.passed) waiting = "The hold-out check did not pass (step 4), so the Gemini check cannot start.";
    else if ((s.images?.waiting_for_qa ?? 0) === 0) waiting = "No frames are waiting for the check.";
  }

  const cap = s?.gemini_calls ? s.gemini_calls.cap : null;
  const estimateText = ask.phase === "confirm" || ask.phase === "starting" ? (ask.estimate ? estimateSentence(ask.estimate, cap) : null) : null;

  return (
    <Card component="section" aria-labelledby="gemini-title">
      <CardContent sx={{ display: "grid", gap: 2, p: { xs: 2, sm: 3 } }}>
        <Box>
          <StepTitle n={5} id="gemini-title">
            Gemini check
          </StepTitle>
          <Typography color="text.secondary">
            Gemini looks at each waiting frame's labels with the gold exemplars as reference. A frame that fails is
            corrected and checked again; if it still fails it goes to a person.
          </Typography>
        </Box>

        {summary.status === "loading" && <LoadingRow label="Loading the QA summary…" />}
        {summary.status === "error" && (
          <ErrorRow what="The QA summary could not be loaded" message={summary.message} onRetry={onRetrySummary} />
        )}

        {s && (
          <Box>
            {s.gemini_calls && (
              <Typography>
                {formatCount(s.gemini_calls.used)} of {plural(s.gemini_calls.cap, "Gemini call", "Gemini calls")} used
                by this project.
              </Typography>
            )}
            {s.pass_rate !== null && s.pass_rate !== undefined && s.n_images > 0 && (
              <Typography>
                Pass rate {s.pass_rate.toFixed(2)} — n = {plural(s.n_images, "frame", "frames")} checked so far by
                Gemini or a person
                {typeof s.images?.passed === "number" ? `, ${formatCount(s.images.passed)} passed` : ""}.
              </Typography>
            )}
          </Box>
        )}

        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
          <Button
            variant="contained"
            startIcon={step.busy ? <CircularProgress size={18} color="inherit" aria-hidden /> : <FactCheckOutlinedIcon />}
            disabled={waiting !== null || step.busy || summary.status === "loading"}
            aria-describedby={waiting ? "gemini-waiting" : undefined}
            onClick={() => void step.requestEstimate()}
          >
            {ask.phase === "estimating" ? "Getting the estimate…" : "Check labels with Gemini"}
          </Button>
          {waiting && <WaitingNote id="gemini-waiting">{waiting}</WaitingNote>}
        </Box>

        {ask.phase === "error" && (
          <Alert severity="error" role="alert" onClose={step.dismiss} sx={{ overflowWrap: "anywhere" }}>
            The Gemini check was not started: {ask.message}
          </Alert>
        )}

        {step.history.status === "loading" && <LoadingRow label="Checking for an earlier Gemini check…" />}
        {step.history.status === "error" && !job && (
          <ErrorRow what="Earlier Gemini checks could not be loaded" message={step.history.message} onRetry={step.reloadHistory} />
        )}

        <Box aria-live="polite" sx={{ display: "grid", gap: 1.5 }}>
          {job && active && <JobProgress job={job} name="Gemini check" unit="frames" pollError={step.pollError} />}
          {job && !active && <JobEnded job={job} name="The Gemini check" />}
          {result && <QaOutcome result={result} />}
        </Box>
      </CardContent>

      {(ask.phase === "confirm" || ask.phase === "starting") && (
        <Dialog
          open
          onClose={ask.phase === "starting" ? undefined : step.dismiss}
          fullWidth
          maxWidth="xs"
          aria-labelledby="gemini-confirm-title"
          aria-describedby="gemini-confirm-text"
        >
          <DialogTitle id="gemini-confirm-title">Check these frames with Gemini?</DialogTitle>
          <DialogContent>
            {estimateText ? (
              <Typography id="gemini-confirm-text">
                This run will use: <strong>{estimateText}</strong>.
              </Typography>
            ) : (
              <Alert id="gemini-confirm-text" severity="warning">
                The API's estimate did not say how many frames or Gemini calls this run would use.
              </Alert>
            )}
            <Typography color="text.secondary" variant="body2" sx={{ mt: 1 }}>
              The number of Gemini calls is the worst case; the run stops if the project cap is reached.
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
              {ask.phase === "starting" ? "Starting…" : "Start the check"}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Card>
  );
}
