import { Alert, Box, Card, Chip, LinearProgress, Stack, Typography } from "@mui/material";
import MovieOutlinedIcon from "@mui/icons-material/MovieOutlined";
import type { Asset, AssetStatus, Job } from "../api";
import { formatBytes, formatCount, formatDate, formatTimestamp, humanise, plural } from "../format";
import type { Load } from "../hooks";
import { EmptyState, ErrorRow, LoadingRow } from "./States";

export function isActive(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

const STATUS_COLOUR: Record<AssetStatus, "default" | "info" | "success" | "error"> = {
  pending: "default",
  uploaded: "default",
  processing: "info",
  ready: "success",
  failed: "error",
};

const KIND_NAMES: Record<string, string> = {
  video: "Video",
  images: "Image archive",
  gold_images: "Gold images",
  gold_labels: "Gold labels",
};

const JOB_NAMES: Record<string, string> = {
  extract_frames: "Extracting frames",
  import_gold: "Importing the gold set",
};

function num(result: Record<string, unknown>, key: string): number | null {
  const v = result[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** "97 frames kept from 120 sampled (15 duplicates, 8 blurry dropped)" from a job's own counts. */
function keptSentence(kept: number, sampled: number, duplicates: number | null, blurry: number | null): string {
  let s = `${plural(kept, "frame", "frames")} kept from ${formatCount(sampled)} sampled`;
  if (duplicates !== null && blurry !== null) {
    s += ` (${plural(duplicates, "duplicate", "duplicates")}, ${formatCount(blurry)} blurry dropped)`;
  }
  return s;
}

function AssetRow({ asset, job, pollError }: { asset: Asset; job: Job | null; pollError: string | null }) {
  const active = job !== null && isActive(job);
  const total = job?.progress?.total ?? 0;
  const done = job?.progress?.done ?? 0;
  const jobName = job ? (JOB_NAMES[job.type] ?? humanise(job.type)) : "";

  let outcome: string | null = null;
  let detail: string | null = null;
  let limitNote: string | null = null;
  if (job && job.status === "succeeded" && job.type === "extract_frames") {
    const kept = num(job.result, "frames_kept");
    const sampled = num(job.result, "frames_extracted");
    if (kept !== null && sampled !== null) {
      outcome = keptSentence(kept, sampled, num(job.result, "dropped_duplicate"), num(job.result, "dropped_blurry"));
    }
    const seconds = num(job.result, "video_seconds");
    const every = num(job.result, "sample_every_seconds");
    if (seconds !== null && every !== null) {
      detail = `Video length ${formatTimestamp(seconds)}, one frame sampled every ${every} s.`;
    }
    if (job.result.stopped_at_max_frames === true) {
      limitNote = "The recording was longer than the frame limit covers; frames were taken from its start only.";
    }
  } else if (!job && asset.kind === "video" && asset.status === "ready") {
    // The job could not be read; the asset carries the same two counts.
    outcome = keptSentence(asset.frames_kept, asset.frames_extracted, null, null);
  }

  return (
    <Card component="li" sx={{ listStyle: "none" }}>
      <Box sx={{ p: 2, display: "grid", gap: 1.25 }}>
        <Stack direction="row" useFlexGap spacing={1.5} sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography component="h4" variant="subtitle1" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
              {asset.filename}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {KIND_NAMES[asset.kind] ?? humanise(asset.kind)} · {formatBytes(asset.size_bytes)} · added{" "}
              <time dateTime={asset.created_at}>{formatDate(asset.created_at)}</time>
            </Typography>
            {asset.source === "camera" && (
              <Chip size="small" variant="outlined" label="recorded from camera" sx={{ mt: 0.5 }} />
            )}
          </Box>
          <Chip
            size="small"
            color={STATUS_COLOUR[asset.status] ?? "default"}
            variant={asset.status === "uploaded" ? "outlined" : "filled"}
            label={humanise(asset.status)}
            sx={{ flexShrink: 0 }}
          />
        </Stack>

        {active && job && (
          <Box role="group" aria-label={`${jobName} for ${asset.filename}`}>
            <Typography variant="body2">
              {job.status === "queued"
                ? `${jobName}: waiting to start`
                : total > 0
                  ? `${jobName}: ${formatCount(done)} of ${formatCount(total)}`
                  : `${jobName}…`}
            </Typography>
            <LinearProgress
              variant={job.status === "running" && total > 0 ? "determinate" : "indeterminate"}
              value={total > 0 ? Math.min(100, (done / total) * 100) : undefined}
              aria-label={`${jobName} for ${asset.filename}`}
              sx={{ mt: 0.75, height: 8, borderRadius: "4px" }}
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
            {jobName} failed: {job.error ?? "the job gave no reason."}
          </Alert>
        )}
        {job?.status === "cancelled" && <Alert severity="info">{jobName} was cancelled.</Alert>}
        {!job && asset.status === "failed" && (
          <Alert severity="error">Processing this file failed. The job that ran it could not be read.</Alert>
        )}

        {!job && !asset.job_id && asset.status === "uploaded" && (
          <Typography variant="body2" color="text.secondary">
            No frame extraction has run for this file. If its upload was interrupted, add the video again.
          </Typography>
        )}

        {outcome && (
          <Box>
            <Typography>{outcome}</Typography>
            {detail && (
              <Typography variant="body2" color="text.secondary">
                {detail}
              </Typography>
            )}
            {limitNote && (
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {limitNote}
              </Typography>
            )}
          </Box>
        )}
      </Box>
    </Card>
  );
}

/** Uploaded files with their processing state. Jobs are looked up by asset.job_id. */
export default function AssetList({
  assets,
  jobs,
  pollErrors,
  onRetry,
}: {
  assets: Load<Asset[]>;
  jobs: Record<string, Job>;
  pollErrors: Record<string, string>;
  onRetry: () => void;
}) {
  if (assets.status === "loading") return <LoadingRow label="Loading uploaded videos…" />;
  if (assets.status === "error") {
    return <ErrorRow what="The uploaded videos could not be loaded" message={assets.message} onRetry={onRetry} />;
  }
  if (assets.data.length === 0) {
    return (
      <EmptyState icon={<MovieOutlinedIcon fontSize="large" />} title="No videos added yet">
        Each video you add appears here with its size, its upload status and the progress of frame extraction.
        Choose a video above to start.
      </EmptyState>
    );
  }

  const jobFor = (asset: Asset): Job | null => {
    if (asset.job_id && jobs[asset.job_id]) return jobs[asset.job_id];
    // A job just returned by /complete, before the asset list has been re-read.
    const mine = Object.values(jobs).filter((j) => j.params?.asset_id === asset.id);
    mine.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return mine[0] ?? null;
  };

  return (
    <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 1.5 }}>
      {assets.data.map((a) => {
        const job = jobFor(a);
        return <AssetRow key={a.id} asset={a} job={job} pollError={job ? (pollErrors[job.id] ?? null) : null} />;
      })}
    </Box>
  );
}
