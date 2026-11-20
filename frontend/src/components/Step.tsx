import type { ReactNode } from "react";
import { Alert, Box, LinearProgress, Typography } from "@mui/material";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import type { Job } from "../api";
import { formatCount } from "../format";

/** Card heading for one numbered step of the Annotation QA sequence. */
export function StepTitle({ n, id, children }: { n: number; id: string; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 0.5 }}>
      <Box
        aria-hidden
        sx={{
          width: 32,
          height: 32,
          flexShrink: 0,
          borderRadius: "50%",
          bgcolor: "primary.main",
          color: "primary.contrastText",
          display: "grid",
          placeItems: "center",
          fontWeight: 700,
        }}
      >
        {n}
      </Box>
      <Typography id={id} variant="h5" component="h3">
        <Box component="span" sx={srOnly}>
          Step {n}:{" "}
        </Box>
        {children}
      </Typography>
    </Box>
  );
}

/** What a step is waiting for before it can run. */
export function WaitingNote({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <Box id={id} sx={{ display: "flex", alignItems: "flex-start", gap: 1, color: "text.secondary" }}>
      <HourglassEmptyIcon fontSize="small" aria-hidden sx={{ mt: "2px" }} />
      <Typography>{children}</Typography>
    </Box>
  );
}

/** Progress of a queued or running job: determinate once it is running and reports a total. */
export function JobProgress({
  job,
  name,
  unit,
  pollError,
}: {
  job: Job;
  name: string;
  unit: string;
  pollError: string | null;
}) {
  const total = job.progress?.total ?? 0;
  const done = job.progress?.done ?? 0;
  return (
    <Box role="group" aria-label={`${name} progress`}>
      <Typography variant="body2">
        {job.status === "queued"
          ? `${name}: waiting to start`
          : total > 0
            ? `${name}: ${formatCount(done)} of ${formatCount(total)} ${unit}`
            : `${name}…`}
      </Typography>
      <LinearProgress
        variant={job.status === "running" && total > 0 ? "determinate" : "indeterminate"}
        value={total > 0 ? Math.min(100, (done / total) * 100) : undefined}
        aria-label={`${name} progress`}
        sx={{ mt: 0.75, height: 8, borderRadius: "4px" }}
      />
      {pollError && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          The last progress check failed ({pollError}). Trying again every 2 seconds.
        </Typography>
      )}
    </Box>
  );
}

/** The failed / cancelled line for a job that ended without a result. */
export function JobEnded({ job, name }: { job: Job; name: string }) {
  if (job.status === "failed") {
    return (
      <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
        {name} failed: {job.error ?? "the job gave no reason."}
      </Alert>
    );
  }
  if (job.status === "cancelled") return <Alert severity="info">The last run was cancelled.</Alert>;
  return null;
}

export const srOnly = {
  // px strings on purpose: in sx a bare `width: 1` means 100%.
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;
