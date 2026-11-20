import { Alert, Box, Button, CircularProgress, Typography } from "@mui/material";
import GestureOutlinedIcon from "@mui/icons-material/GestureOutlined";
import type { QaSummary } from "../api";
import { formatCount, plural, readNumber } from "../format";
import { useStepJob, type Load } from "../hooks";
import { JobEnded, JobProgress } from "./Step";

/** "9 outlines drawn on 4 frames in 14.2 s." plus the boxes SAM could not outline, from the job's own counts. */
export function outlineSentences(result: unknown): string[] {
  const objects = readNumber(result, "objects");
  const images = readNumber(result, "images");
  const failed = readNumber(result, "failed_objects");
  const seconds = readNumber(result, "seconds");
  if (objects === null || images === null) return [];
  const out = [
    `${plural(objects, "outline", "outlines")} drawn on ${plural(images, "frame", "frames")}${
      seconds !== null ? ` in ${seconds.toFixed(1)} s` : ""
    }.`,
  ];
  if (failed !== null && failed > 0) {
    out.push(
      `${plural(failed, "box", "boxes")} could not be outlined and ${failed === 1 ? "stays as a box" : "stay as boxes"}.`,
    );
  }
  return out;
}

/**
 * Boxes a person drew have no outline. This says how many there are (QaSummary.outlines) and
 * runs the `outline` job, which draws them with SAM (MobileSAM). SAM is an annotation aid: it
 * draws the shape inside a box and never decides a class. It shows nothing when there is
 * nothing to say: no box is missing an outline and no outline job has ever run.
 */
export default function OutlinesNote({
  pid,
  summary,
  onChanged,
}: {
  pid: string;
  summary: Load<QaSummary>;
  onChanged: () => void;
}) {
  const step = useStepJob(pid, "outline", onChanged);
  const { job, active } = step;

  const outlines = summary.status === "ready" ? summary.data.outlines : undefined;
  const objectsMissing = outlines?.objects_missing ?? 0;
  const framesMissing = outlines?.frames_missing ?? 0;
  const last = job?.status === "succeeded" ? outlineSentences(job.result) : [];
  const ended = job && !active && (job.status === "failed" || job.status === "cancelled");

  if (objectsMissing === 0 && !active && !ended && last.length === 0 && step.ask.phase !== "error") return null;

  const boxed = objectsMissing > 0 || active;
  return (
    <Box
      component="section"
      aria-label="Outlines"
      sx={{
        display: "grid",
        gap: 1.25,
        mb: 2,
        p: boxed ? { xs: 2, sm: 3 } : 0,
        borderRadius: "16px",
        bgcolor: boxed ? "background.paper" : "transparent",
        border: boxed ? "1px solid" : "none",
        borderColor: "divider",
      }}
    >
      {objectsMissing > 0 && (
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 2, rowGap: 1 }}>
          <Box sx={{ flex: "1 1 260px", minWidth: 0 }}>
            <Typography>
              {formatCount(objectsMissing)} {objectsMissing === 1 ? "box" : "boxes"}
              {framesMissing > 0 ? ` on ${plural(framesMissing, "frame", "frames")}` : ""}{" "}
              {objectsMissing === 1 ? "has" : "have"} no outline yet.{" "}
              {objectsMissing === 1 ? "This is a box a person drew." : "These are boxes a person drew."}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              SAM draws the shape inside each box; it does not choose or change a class. A box left without an
              outline is exported as a rectangle.
            </Typography>
          </Box>
          <Button
            variant="contained"
            startIcon={step.busy ? <CircularProgress size={18} color="inherit" aria-hidden /> : <GestureOutlinedIcon />}
            disabled={active || step.busy}
            onClick={() => void step.start(null)}
          >
            {step.busy ? "Starting…" : "Draw outlines with SAM"}
          </Button>
        </Box>
      )}

      {step.ask.phase === "error" && (
        <Alert severity="error" role="alert" onClose={step.dismiss} sx={{ overflowWrap: "anywhere" }}>
          The outlines were not started: {step.ask.message}
        </Alert>
      )}

      <Box aria-live="polite" sx={{ display: "grid", gap: 1 }}>
        {job && active && <JobProgress job={job} name="Drawing outlines" unit="frames" pollError={step.pollError} />}
        {job && ended && <JobEnded job={job} name="Drawing the outlines" />}
        {last.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            Last outline run: {last.join(" ")}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
