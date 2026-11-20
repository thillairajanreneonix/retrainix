import { Alert, Box, Button, Card, CardContent, CircularProgress, Typography } from "@mui/material";
import DatasetOutlinedIcon from "@mui/icons-material/DatasetOutlined";
import type { DatasetVersion, Project } from "../api";
import { datasetFormatName, formatCount, formatDate, humanise, inClassOrder, plural, readNumber } from "../format";
import { useStepJob, type Load } from "../hooks";
import { EmptyState, ErrorRow, LoadingRow } from "./States";
import { JobEnded, JobProgress } from "./Step";

// Who made each object's label, in plain words and in a fixed order.
const SOURCE_WORDS: [string, string][] = [
  ["model", "model, unchecked by a person"],
  ["gemini_corrected", "class corrected by Gemini"],
  ["human", "corrected by a person"],
  ["gold", "gold"],
];
const SPLIT_WORDS: [string, string][] = [
  ["train", "train"],
  ["val", "validation"],
  ["test", "test"],
];

function CountRow({ label, items }: { label: string; items: [string, number][] }) {
  if (items.length === 0) return null;
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "flex", flexWrap: "wrap", columnGap: 2.5, rowGap: 0.25 }}>
        {items.map(([name, n]) => (
          <Typography component="li" key={name} sx={{ overflowWrap: "anywhere" }}>
            {name}{" "}
            <Box component="span" sx={{ fontWeight: 500 }}>
              {formatCount(n)}
            </Box>
          </Typography>
        ))}
      </Box>
    </Box>
  );
}

function DatasetRow({ d, classes }: { d: DatasetVersion; classes: string[] }) {
  const splits = SPLIT_WORDS.map(([key, word]) => [word, readNumber(d.splits?.[key], "images")] as const).filter(
    (s): s is readonly [string, number] => s[1] !== null,
  );
  const sources: [string, number][] = [];
  const known = new Set(SOURCE_WORDS.map(([k]) => k));
  for (const [key, words] of SOURCE_WORDS) {
    const n = d.label_sources?.[key];
    if (typeof n === "number") sources.push([words, n]);
  }
  for (const key of Object.keys(d.label_sources ?? {}).sort()) {
    const n = d.label_sources[key];
    if (!known.has(key) && typeof n === "number") sources.push([humanise(key).toLowerCase(), n]);
  }
  const perClass: [string, number][] = inClassOrder(Object.keys(d.objects_per_class ?? {}), classes)
    .map((name) => [name, d.objects_per_class[name]] as [string, number])
    .filter(([, n]) => typeof n === "number");

  return (
    <Box component="li" sx={{ borderTop: "1px solid", borderColor: "divider", pt: 1.5, display: "grid", gap: 1 }}>
      <Typography sx={{ overflowWrap: "anywhere" }}>
        <Box component="span" sx={{ fontWeight: 500 }}>
          Version {d.version}
        </Box>{" "}
        — {plural(d.images, "frame", "frames")}
        {splits.length > 0 ? `: ${splits.map(([word, n]) => `${formatCount(n)} ${word}`).join(", ")}` : ""}
        {d.format ? ` · format ${datasetFormatName(d.format)}` : ""}
        {typeof d.image_size === "number" ? ` · ${d.image_size} px` : ""}
      </Typography>
      <CountRow label="Objects, by who made the label" items={sources} />
      <CountRow label="Objects per class" items={perClass} />
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
        {d.validated
          ? `Passed validation${d.validated_by ? ` (${humanise(d.validated_by).toLowerCase()})` : ""}`
          : "Not validated"}
        {d.created_at ? (
          <>
            {" · exported "}
            <time dateTime={d.created_at}>{formatDate(d.created_at)}</time>
          </>
        ) : null}
      </Typography>
    </Box>
  );
}

/** The exported dataset versions, and a way to export one without training on it. */
export default function DatasetsCard({
  project,
  datasets,
  onRetry,
  onChanged,
}: {
  project: Project;
  datasets: Load<DatasetVersion[]>;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const step = useStepJob(project.id, "compile", onChanged);
  const { job, active } = step;
  const exported = job?.status === "succeeded" ? readNumber(job.result, "version") : null;
  const exportedImages = job?.status === "succeeded" ? readNumber(job.result, "images") : null;

  return (
    <Card component="section" aria-labelledby="datasets-title">
      <CardContent sx={{ display: "grid", gap: 2, p: { xs: 2, sm: 3 } }}>
        <Box>
          <Typography id="datasets-title" variant="h5" component="h3">
            Datasets
          </Typography>
          <Typography color="text.secondary">
            Each training run exports a new, fixed dataset version from the frames that passed the check or were
            checked by a person. The gold hold-out is never part of one. The format is COCO segmentation: train,
            valid and test folders, each with an _annotations.coco.json file beside its images.
          </Typography>
        </Box>

        {datasets.status === "loading" && <LoadingRow label="Loading dataset versions…" />}
        {datasets.status === "error" && (
          <ErrorRow what="The dataset versions could not be loaded" message={datasets.message} onRetry={onRetry} />
        )}
        {datasets.status === "ready" && datasets.data.length === 0 && (
          <EmptyState icon={<DatasetOutlinedIcon fontSize="large" />} title="No dataset has been exported yet">
            Each exported version appears here with its frame counts per split, who made the labels, and the objects
            per class. Train a new version above, or export a dataset on its own below.
          </EmptyState>
        )}
        {datasets.status === "ready" && datasets.data.length > 0 && (
          <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 1.5 }}>
            {[...datasets.data]
              .sort((a, b) => b.version - a.version)
              .map((d) => (
                <DatasetRow key={d.version} d={d} classes={project.classes} />
              ))}
          </Box>
        )}

        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
          <Button
            variant="outlined"
            disabled={active || step.busy}
            startIcon={step.busy ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
            onClick={() => void step.start(null)}
          >
            {step.busy ? "Starting…" : "Export a dataset only"}
          </Button>
          <Typography variant="body2" color="text.secondary">
            For when you want the data without training on it.
          </Typography>
        </Box>

        {step.ask.phase === "error" && (
          <Alert severity="error" role="alert" onClose={step.dismiss} sx={{ overflowWrap: "anywhere" }}>
            The export was not started: {step.ask.message}
          </Alert>
        )}
        <Box aria-live="polite" sx={{ display: "grid", gap: 1.5 }}>
          {job && active && <JobProgress job={job} name="Exporting the dataset" unit="frames" pollError={step.pollError} />}
          {job && !active && <JobEnded job={job} name="The export" />}
          {exported !== null && (
            <Alert severity="success">
              Dataset version {exported} was exported
              {exportedImages !== null ? `: ${plural(exportedImages, "frame", "frames")}` : ""}.
            </Alert>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}
