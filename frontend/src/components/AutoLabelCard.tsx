import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, Card, CardContent, Typography } from "@mui/material";
import { api, isJobActive, type Job, type Project } from "../api";
import { formatCount, inClassOrder, plural, readNumber } from "../format";
import { useJobPolling, useLoad } from "../hooks";
import { ErrorRow } from "./States";
import { JobProgress } from "./Step";

// The labelling job is created a moment after a video's frames are ready, so the list of jobs
// is read again shortly after every upload finishes.
const LOOK_AGAIN_MS = [2500, 7000];

/** "627 objects on 43 frames: plastic 623, metal 4." from a finished pre-label job's own counts. */
function outcomeSentence(result: Record<string, unknown> | null | undefined, classes: string[]): string | null {
  const objects = readNumber(result, "objects");
  const images = readNumber(result, "images");
  if (objects === null || images === null) return null;
  const raw = result && typeof result.per_class === "object" && result.per_class ? (result.per_class as Record<string, unknown>) : {};
  const parts = inClassOrder(Object.keys(raw), classes)
    .filter((c) => typeof raw[c] === "number")
    .map((c) => `${c} ${formatCount(raw[c] as number)}`);
  return `${plural(objects, "object", "objects")} on ${plural(images, "frame", "frames")}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}.`;
}

/**
 * Project setup: what happens to the frames once a video is in. The API labels them with the
 * project's model by itself (a pre-label job with trigger "auto"), so this card says so, shows
 * that run while it works and what it found, and - while nothing is labelled yet - reminds the
 * person that the class mapping is fixed from the first labelled frame.
 * `refreshKey` changes whenever an upload's frames have just become ready.
 */
export default function AutoLabelCard({ project, refreshKey, onFinished }: { project: Project; refreshKey: number; onFinished: () => void }) {
  const pid = project.id;
  const qaLink = `/projects/${encodeURIComponent(pid)}/qa`;
  // The newest real (not dry-run) pre-label job, whoever started it.
  const [latest, reload] = useLoad(async () => (await api.listJobs(pid, { type: "prelabel" })).find((j) => !j.dry_run) ?? null, [pid]);
  const [polled, setPolled] = useState<Job | null>(null);
  const newest = latest.status === "ready" ? latest.data : null;
  const job = polled && newest && polled.id === newest.id ? polled : newest;

  const onUpdate = useCallback(
    (next: Job) => {
      setPolled(next);
      if (!isJobActive(next)) onFinished(); // the project's counts have moved
    },
    [onFinished],
  );
  const pollError = useJobPolling(pid, job, onUpdate);

  useEffect(() => {
    if (refreshKey === 0) return; // nothing has been uploaded on this visit yet
    reload();
    const timers = LOOK_AGAIN_MS.map((ms) => window.setTimeout(reload, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [refreshKey, reload]);

  const active = job !== null && isJobActive(job);
  const nothingLabelledYet = (project.counts?.predicted ?? 0) === 0 && !active;
  const outcome = job?.status === "succeeded" ? outcomeSentence(job.result, project.classes) : null;
  const unmapped = job?.status === "succeeded" ? readNumber(job.result, "unmapped_objects") : null;

  return (
    <Card component="section" aria-labelledby="auto-label-title">
      <CardContent sx={{ display: "grid", gap: 1.5, p: { xs: 2, sm: 3 } }}>
        <Box>
          <Typography id="auto-label-title" variant="h5" component="h3">
            Labelling
          </Typography>
          <Typography color="text.secondary">
            Every video you add or record is labelled by the model as soon as its frames are ready. There is no
            button to press.
          </Typography>
        </Box>

        {nothingLabelledYet && (
          <Alert
            severity="info"
            sx={{ overflowWrap: "anywhere" }}
            action={
              <Button color="inherit" size="small" component="a" href="#class-map-title">
                Check mapping
              </Button>
            }
          >
            Check the class mapping above before the first video. It decides which of the model's classes become yours,
            and it cannot be changed once frames are labelled.
          </Alert>
        )}

        {latest.status === "error" && <ErrorRow what="The labelling runs could not be loaded" message={latest.message} onRetry={reload} />}

        <Box aria-live="polite" sx={{ display: "grid", gap: 1 }}>
          {job && active && <JobProgress job={job} name="Labelling frames" unit="frames" pollError={pollError} />}
          {job?.status === "failed" && (
            <Alert
              severity="error"
              sx={{ overflowWrap: "anywhere" }}
              action={
                <Button color="inherit" size="small" component={RouterLink} to={`${qaLink}#prelabel-title`}>
                  Open step 2
                </Button>
              }
            >
              Labelling failed: {job.error ?? "the job gave no reason."} The frames are kept; start it again on
              Annotation QA, step 2.
            </Alert>
          )}
          {job?.status === "succeeded" && (
            <Typography sx={{ overflowWrap: "anywhere" }}>
              <Box component="span" sx={{ color: "text.secondary" }}>
                Last run{job.trigger === "auto" ? ", started by itself after an upload" : ""}:{" "}
              </Box>
              {outcome ?? "it finished and reported no counts."}
              {unmapped !== null && unmapped > 0
                ? ` ${plural(unmapped, "more detection was", "more detections were")} dropped because ${unmapped === 1 ? "its" : "their"} class is not mapped.`
                : ""}
            </Typography>
          )}
        </Box>

        {job?.status === "succeeded" && (
          <Typography variant="body2" color="text.secondary">
            These are the model's own labels, not checked ones. Check them on{" "}
            <Box component={RouterLink} to={qaLink} sx={{ color: "primary.dark", fontWeight: 500 }}>
              Annotation QA
            </Box>
            .
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
