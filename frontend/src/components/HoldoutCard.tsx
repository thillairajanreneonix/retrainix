import { Alert, Box, Button, Card, CardContent, CircularProgress, Typography } from "@mui/material";
import RuleOutlinedIcon from "@mui/icons-material/RuleOutlined";
import type { GoldStatus, HoldoutResult, Project, QaSummary } from "../api";
import { formatCount, formatShare, inClassOrder, plural, readNumber } from "../format";
import { useStepJob, type Load } from "../hooks";
import { ErrorRow, LoadingRow } from "./States";
import { JobEnded, JobProgress, StepTitle, WaitingNote } from "./Step";

/** A holdout result is usable only when the figures behind the pass / fail line are all there. */
function asHoldout(value: unknown): HoldoutResult | null {
  if (!value || typeof value !== "object") return null;
  const ok =
    readNumber(value, "mean_iou") !== null &&
    readNumber(value, "threshold") !== null &&
    readNumber(value, "n_images") !== null &&
    typeof (value as { passed?: unknown }).passed === "boolean";
  return ok ? (value as HoldoutResult) : null;
}

function Figure({ name, value, counts }: { name: string; value: number | null; counts: string }) {
  if (value === null) return null;
  return (
    <>
      <Typography component="dt" color="text.secondary">
        {name}
      </Typography>
      <Typography component="dd" sx={{ m: 0, overflowWrap: "anywhere" }}>
        <Box component="span" sx={{ fontWeight: 500 }}>
          {formatShare(value)}
        </Box>{" "}
        ({counts})
      </Typography>
    </>
  );
}

function HoldoutOutcome({ result, classes }: { result: HoldoutResult; classes: string[] }) {
  const matched = readNumber(result, "matched");
  const nGold = readNumber(result, "n_objects_gold");
  const nModel = readNumber(result, "n_objects_model");
  const images = plural(result.n_images, "image", "images");
  const per = result.per_class_recall ?? {};
  const names = inClassOrder(Object.keys(per), classes);

  return (
    <Box sx={{ display: "grid", gap: 1.5 }}>
      <Alert severity={result.passed ? "success" : "error"} sx={{ overflowWrap: "anywhere" }}>
        <Box component="span" sx={{ fontWeight: 500 }}>
          {result.passed ? "Passed." : "Not passed."}
        </Box>{" "}
        Mean IoU {formatShare(result.mean_iou)} against a minimum of {formatShare(result.threshold)} — n = {images}
        {matched !== null ? `, ${plural(matched, "matched object", "matched objects")}` : ""}.
        {!result.passed && (
          <>
            {" "}
            The Gemini check (step 5) cannot start, because the model's mean IoU on the hold-out is below the
            minimum.
          </>
        )}
      </Alert>

      <Box
        component="dl"
        sx={{
          m: 0,
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "max-content minmax(0, 1fr)" },
          columnGap: 2,
          rowGap: { xs: 0, sm: 0.5 },
          "& dt": { mt: { xs: 0.75, sm: 0 } },
        }}
      >
        <Figure
          name="Precision"
          value={readNumber(result, "precision")}
          counts={`${matched !== null ? `${formatCount(matched)} matched` : "matched not reported"}, ${
            nModel !== null ? plural(nModel, "model object", "model objects") : "model objects not reported"
          }`}
        />
        <Figure
          name="Recall"
          value={readNumber(result, "recall")}
          counts={`${matched !== null ? `${formatCount(matched)} matched` : "matched not reported"}, ${
            nGold !== null ? plural(nGold, "human-labelled object", "human-labelled objects") : "human-labelled objects not reported"
          }`}
        />
        <Figure
          name="Class agreement"
          value={readNumber(result, "class_agreement")}
          counts={matched !== null ? `same class, of ${plural(matched, "matched pair", "matched pairs")}` : "matched pairs not reported"}
        />
        <Figure
          name="mAP50"
          value={readNumber(result, "map50")}
          counts={`box and class both right; n = ${images}${
            nGold !== null ? `, ${plural(nGold, "human-labelled object", "human-labelled objects")}` : ""
          }`}
        />
        <Figure name="mAP50-95" value={readNumber(result, "map50_95")} counts={`n = ${images}`} />
      </Box>

      {names.length > 0 && (
        <Box sx={{ overflowX: "auto" }}>
          <Box
            component="table"
            sx={{
              borderCollapse: "collapse",
              minWidth: 260,
              "& caption": { textAlign: "left", fontWeight: 500, pb: 0.5 },
              "& th": { textAlign: "left", fontWeight: 500, color: "text.secondary" },
              "& th, & td": { py: 0.5, pr: 3 },
              "& tbody tr": { borderTop: "1px solid", borderColor: "divider" },
            }}
          >
            <caption>Recall per class on the hold-out</caption>
            <thead>
              <tr>
                <th scope="col">Class</th>
                <th scope="col">Recall</th>
                <th scope="col">n (human-labelled objects)</th>
              </tr>
            </thead>
            <tbody>
              {names.map((name) => {
                const row = per[name];
                const recall = readNumber(row, "recall");
                const n = readNumber(row, "n");
                return (
                  <tr key={name}>
                    <Box component="th" scope="row" sx={{ color: "text.primary !important", overflowWrap: "anywhere" }}>
                      {name}
                    </Box>
                    <td>{recall !== null ? formatShare(recall) : "not reported"}</td>
                    <td>{n !== null ? formatCount(n) : "not reported"}</td>
                  </tr>
                );
              })}
            </tbody>
          </Box>
        </Box>
      )}

      {result.label_model && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          Model scored: {result.label_model.recipe} v{result.label_model.version}, profile {result.label_model.profile}
          {result.eval_set ? ` · scored on ${result.eval_set}` : ""}.
        </Typography>
      )}
    </Box>
  );
}

/**
 * Step 4: the project's current model labels the hold-out images and is scored against the
 * human labels. Every figure is shown with the counts the API gave for it.
 */
export default function HoldoutCard({
  project,
  gold,
  summary,
  onChanged,
}: {
  project: Project;
  gold: Load<GoldStatus>;
  summary: Load<QaSummary>;
  onChanged: () => void;
}) {
  const step = useStepJob(project.id, "holdout_check", onChanged);
  const { job, active } = step;

  const fromJob = job?.status === "succeeded" ? asHoldout(job.result) : null;
  const stored = asHoldout(summary.status === "ready" ? summary.data.holdout : null) ?? asHoldout(project.holdout);
  const result = fromJob ?? (active ? null : stored);

  let waiting: string | null = null;
  if (gold.status === "ready" && !gold.data.frozen) waiting = "Waiting for the gold set to be frozen (step 3).";
  else if (active) waiting = "The hold-out check is running.";

  return (
    <Card component="section" aria-labelledby="holdout-title">
      <CardContent sx={{ display: "grid", gap: 2, p: { xs: 2, sm: 3 } }}>
        <Box>
          <StepTitle n={4} id="holdout-title">
            Hold-out check
          </StepTitle>
          <Typography color="text.secondary">
            The model labels the hold-out frames and is scored against the labels a person made. It has to pass
            before Gemini checks the rest.
          </Typography>
        </Box>

        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
          <Button
            variant="contained"
            startIcon={step.busy ? <CircularProgress size={18} color="inherit" aria-hidden /> : <RuleOutlinedIcon />}
            disabled={waiting !== null || step.busy || gold.status !== "ready"}
            aria-describedby={waiting ? "holdout-waiting" : undefined}
            onClick={() => void step.start(null)}
          >
            {step.busy ? "Starting…" : result ? "Score the model again" : "Score the model on the hold-out"}
          </Button>
          {waiting && <WaitingNote id="holdout-waiting">{waiting}</WaitingNote>}
        </Box>

        {step.ask.phase === "error" && (
          <Alert severity="error" role="alert" onClose={step.dismiss} sx={{ overflowWrap: "anywhere" }}>
            The hold-out check was not started: {step.ask.message}
          </Alert>
        )}

        {step.history.status === "loading" && <LoadingRow label="Checking for an earlier hold-out check…" />}
        {step.history.status === "error" && !job && (
          <ErrorRow what="Earlier hold-out checks could not be loaded" message={step.history.message} onRetry={step.reloadHistory} />
        )}

        <Box aria-live="polite" sx={{ display: "grid", gap: 1.5 }}>
          {job && active && <JobProgress job={job} name="Hold-out check" unit="images" pollError={step.pollError} />}
          {job && !active && <JobEnded job={job} name="The hold-out check" />}
          {job?.status === "succeeded" && !fromJob && !stored && (
            <Alert severity="warning">The hold-out check finished but reported no figures.</Alert>
          )}
          {result && <HoldoutOutcome result={result} classes={project.classes} />}
        </Box>
      </CardContent>
    </Card>
  );
}
