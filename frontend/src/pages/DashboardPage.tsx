import { useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink, Navigate, useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Card,
  CardContent,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import ErrorOutlineOutlinedIcon from "@mui/icons-material/ErrorOutlineOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import VideocamOutlinedIcon from "@mui/icons-material/VideocamOutlined";
import { api, type GoldStatus, type Image, type ModelVersion, type Project, type QaSummary } from "../api";
import { CAMERA_CHANGED_EVENT, readChosenCamera, type ChosenCamera } from "../camera";
import { formatCount, formatShare, formatTimestamp, framesInProject, framesWithLabels, inClassOrder, plural, readNumber } from "../format";
import { useLoad, type Load } from "../hooks";
import { rx } from "../theme";
import { colourFor } from "../components/FrameReviewDialog";
import LiveCameraView from "../components/LiveCameraView";
import { EmptyState, ErrorRow, LoadingRow } from "../components/States";
import { PageHeader, StatusBadge } from "../components/ui";

const FRAMES_TO_CHOOSE_FROM = 24;

/** "/" - opens the dashboard of the newest project, or says how to create the first one. */
export function DashboardHome() {
  const [projects, reload] = useLoad(() => api.listProjects(), []);
  if (projects.status === "loading") return <LoadingRow label="Loading projects…" />;
  if (projects.status === "error") {
    return <ErrorRow what="The project list could not be loaded" message={projects.message} onRetry={reload} />;
  }
  if (projects.data.length === 0) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Dashboard" subtitle="One project is one belt: its classes, its footage and the model retrained on it." />
        <EmptyState
          icon={<FolderOpenOutlinedIcon fontSize="large" />}
          title="No projects yet"
          action={
            <Button variant="contained" component={RouterLink} to="/projects" startIcon={<AddIcon />}>
              Create the first project
            </Button>
          }
        >
          The dashboard shows a project's latest labelled frame, its material counts and where its retraining loop
          stands. Create a project and add a video of the belt to begin.
        </EmptyState>
      </Stack>
    );
  }
  const newest = [...projects.data].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return <Navigate replace to={`/projects/${encodeURIComponent(newest.id)}/dashboard`} />;
}

function SectionTitle({ id, children, aside }: { id: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, minHeight: 44 }}>
      <Typography id={id} component="h3" sx={{ flex: "1 1 auto", fontSize: "0.75rem", fontWeight: 700, letterSpacing: "1.2px", color: "text.secondary" }}>
        {children}
      </Typography>
      {aside}
    </Box>
  );
}

/** The camera chosen on Project setup, kept in step when it is changed (here or in another tab). */
function useChosenCamera(): ChosenCamera | null {
  const [camera, setCamera] = useState<ChosenCamera | null>(readChosenCamera);
  useEffect(() => {
    const refresh = () => setCamera(readChosenCamera());
    window.addEventListener(CAMERA_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CAMERA_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return camera;
}

type BeltMode = "camera" | "frame";

/**
 * The belt, two ways: live from the camera chosen on Project setup, or a stored frame of this
 * project with the labels its latest label file holds drawn over it. Live is shown first; with
 * no camera chosen yet, that view asks for one.
 */
function FramePanel({ project, images }: { project: Project; images: Load<Image[]> }) {
  const camera = useChosenCamera();
  // Camera first: with no camera chosen yet, the card opens on choosing one.
  const [mode, setMode] = useState<BeltMode>("camera");
  const [showLabels, setShowLabels] = useState(true);
  // The frame with the most labelled objects among the first few: a full belt says more than an empty one.
  const frame =
    images.status === "ready" && images.data.length > 0
      ? [...images.data].sort((a, b) => (b.object_count ?? 0) - (a.object_count ?? 0))[0]
      : null;
  const frameId = frame?.id ?? null;
  const [detail] = useLoad(() => (frameId ? api.getImageDetail(project.id, frameId) : Promise.resolve(null)), [project.id, frameId]);
  const label = detail.status === "ready" && detail.data ? detail.data.label : null;
  const setupLink = `/projects/${encodeURIComponent(project.id)}`;

  return (
    <Card component="section" aria-labelledby="dash-frame-title" sx={{ overflow: "hidden" }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 2, rowGap: 1, px: { xs: 2, sm: 3 }, py: 1.5 }}>
        <Typography id="dash-frame-title" variant="h5" component="h3" sx={{ flex: "1 1 160px" }}>
          Belt view
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={mode}
          onChange={(_, next: BeltMode | null) => next && setMode(next)}
          aria-label="What the belt view shows"
        >
          <ToggleButton value="camera" sx={{ px: 1.75 }}>
            Live camera
          </ToggleButton>
          <ToggleButton value="frame" sx={{ px: 1.75 }}>
            Labelled frame
          </ToggleButton>
        </ToggleButtonGroup>
        {mode === "frame" && frame && (
          <Typography variant="body2" color="text.secondary">
            {frame.timestamp_s !== null ? `Frame at ${formatTimestamp(frame.timestamp_s)} · ` : ""}
            {frame.width} × {frame.height} · {plural(frame.object_count ?? 0, "object", "objects")}
          </Typography>
        )}
      </Box>

      {mode === "camera" && <LiveCameraView project={project} camera={camera} setupLink={setupLink} />}

      {mode === "frame" && images.status === "loading" && (
        <Box sx={{ px: { xs: 2, sm: 3 }, pb: 2 }}>
          <LoadingRow label="Loading frames…" />
        </Box>
      )}
      {mode === "frame" && images.status === "error" && (
        <Box sx={{ px: { xs: 2, sm: 3 }, pb: 2 }}>
          <ErrorRow what="The frames could not be loaded" message={images.message} />
        </Box>
      )}
      {mode === "frame" && images.status === "ready" && !frame && (
        <Box sx={{ px: { xs: 2, sm: 3 }, pb: 3 }}>
          <EmptyState
            icon={<VideocamOutlinedIcon fontSize="large" />}
            title="No frames yet"
            action={
              <Button variant="contained" component={RouterLink} to={setupLink}>
                Add a video
              </Button>
            }
          >
            Record a clip from a camera or load a video on the Project setup screen. Its frames then appear here
            with the model's labels.
          </EmptyState>
        </Box>
      )}

      {mode === "frame" && frame && (
        <>
          {/* The image keeps its own proportions: the box takes the frame's aspect ratio, nothing is cropped. */}
          <Box sx={{ position: "relative", bgcolor: rx.annotationSurface, lineHeight: 0, aspectRatio: `${frame.width} / ${frame.height}` }}>
            <Box
              component="img"
              src={api.imageFileUrl(project.id, frame.id, 1280)}
              alt={`Belt frame${frame.timestamp_s !== null ? ` at ${formatTimestamp(frame.timestamp_s)}` : ""}, seen from the camera above it`}
              sx={{ display: "block", width: "100%", height: "100%" }}
            />
            {showLabels && label && (
              <svg
                viewBox={`0 0 ${label.width} ${label.height}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`${plural(label.objects.length, "labelled object", "labelled objects")} outlined on the frame`}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
              >
                {label.objects.map((o) => {
                  const colour = colourFor(project.classes, o.class);
                  if (o.polygon_xy && o.polygon_xy.length >= 3) {
                    return (
                      <polygon
                        key={o.id}
                        points={o.polygon_xy.map(([x, y]) => `${x},${y}`).join(" ")}
                        fill={colour}
                        fillOpacity={0.2}
                        stroke={colour}
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  }
                  const [x0, y0, x1, y1] = o.bbox_xyxy;
                  return (
                    <rect
                      key={o.id}
                      x={x0}
                      y={y0}
                      width={x1 - x0}
                      height={y1 - y0}
                      fill="none"
                      stroke={colour}
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              </svg>
            )}
          </Box>

          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5, px: { xs: 2, sm: 3 }, py: 2 }}>
            <Button variant="contained" component={RouterLink} to={setupLink} startIcon={<VideocamOutlinedIcon />}>
              Record or load a video
            </Button>
            <Button variant="outlined" component={RouterLink} to={`${setupLink}/qa`}>
              Review frames
            </Button>
            <Box sx={{ flex: "1 1 8px" }} />
            <FormControlLabel
              control={<Switch checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />}
              label="Show labels"
              sx={{ mr: 0, minHeight: 44 }}
            />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ px: { xs: 2, sm: 3 }, pb: 2 }}>
            A stored frame, not a live picture: the camera records a clip in the browser and the model labels its
            frames after upload.
            {label
              ? `${label.label_model ? ` Labelled by ${label.label_model.recipe} v${label.label_model.version}.` : ""} A dashed box has no outline.`
              : detail.status === "ready"
                ? " This frame has no labels yet."
                : ""}
          </Typography>
        </>
      )}
    </Card>
  );
}

type LoopCell = { n: number; name: string; value: string; note: string; done: boolean };

function loopCells(p: Project, gold: Load<GoldStatus>, summary: Load<QaSummary>, versions: Load<ModelVersion[]>): LoopCell[] {
  const g = gold.status === "ready" ? gold.data : null;
  const s = summary.status === "ready" ? summary.data : null;
  const list = versions.status === "ready" ? versions.data : null;
  const trained = list ? list.filter((v) => v.trigger !== "seed") : null;
  const holdout = p.holdout ?? s?.holdout ?? null;
  const frames = framesInProject(p.counts);
  const labelled = framesWithLabels(p.counts);
  const pending = (load: Load<unknown>) => (load.status === "error" ? "could not be loaded" : "loading…");

  return [
    { n: 1, name: "Capture", value: formatCount(frames), note: frames === 1 ? "frame kept from video" : "frames kept from video", done: frames > 0 },
    { n: 2, name: "Label", value: formatCount(labelled), note: "frames that have labels", done: frames > 0 && labelled >= frames },
    {
      n: 3,
      name: "Gemini check",
      value: s ? (s.last_qa ? formatCount(s.last_qa.passed) : "Not run") : "—",
      note: s ? (s.last_qa ? `passed, ${formatCount(s.last_qa.human_review)} sent to a person` : "no frame checked by Gemini yet") : pending(summary),
      done: Boolean(s?.last_qa),
    },
    {
      n: 4,
      name: "Review",
      value: g ? (g.frozen ? "Gold set" : `${formatCount(g.reviewed_images)} of ${formatCount(g.required_images)}`) : "—",
      note: g ? (g.frozen ? `${formatCount(g.gold_exemplar)} examples, ${formatCount(g.gold_holdout)} held back` : "frames checked by a person") : pending(gold),
      done: Boolean(g?.frozen),
    },
    {
      n: 5,
      name: "Train",
      value: trained ? (trained.length > 0 ? plural(trained.length, "version", "versions") : "No run") : "—",
      note: trained ? (trained.length > 0 ? "trained from the checked frames" : "needs the gold set and checked frames") : pending(versions),
      done: Boolean(trained && trained.length > 0),
    },
    {
      n: 6,
      name: "Score",
      value: holdout ? `mAP50 ${formatShare(holdout.map50)}` : "Not scored",
      note: holdout ? `active model, on ${plural(holdout.n_images, "held-back frame", "held-back frames")}` : "scored on the held-back gold frames",
      done: Boolean(holdout),
    },
  ];
}

function LoopStrip({ project, cells }: { project: Project; cells: LoopCell[] }) {
  return (
    <Card component="section" aria-labelledby="dash-loop-title">
      <CardContent sx={{ display: "grid", gap: 1, p: { xs: 2, sm: 3 } }}>
        <SectionTitle
          id="dash-loop-title"
          aside={
            <Button component={RouterLink} to={`/projects/${encodeURIComponent(project.id)}/qa`} endIcon={<ArrowForwardIcon />}>
              Open Annotation QA
            </Button>
          }
        >
          RETRAINING LOOP
        </SectionTitle>
        <Box component="ol" sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          {cells.map((c) => (
            <Box
              component="li"
              key={c.n}
              sx={{ display: "grid", alignContent: "start", gap: 0.25, p: 1.5, borderRadius: "12px", border: "1px solid", borderColor: "divider", bgcolor: rx.surfaceSubtle }}
            >
              <Typography component="span" sx={{ fontSize: "0.75rem", fontWeight: 700, color: c.done ? rx.accentInk : "text.secondary" }}>
                {c.n} · {c.name}
                <Box component="span" sx={{ fontWeight: 500 }}>{c.done ? " · done" : ""}</Box>
              </Typography>
              <Typography component="span" sx={{ fontSize: "1.25rem", fontWeight: 700, lineHeight: 1.3, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>
                {c.value}
              </Typography>
              <Typography component="span" variant="body2" color="text.secondary">
                {c.note}
              </Typography>
            </Box>
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}

/** Objects per class as the model labelled them in its last pre-label run. Counts, not accuracy. */
function MaterialCount({ project }: { project: Project }) {
  const [jobs, reload] = useLoad(() => api.listJobs(project.id, { type: "prelabel", status: "succeeded" }), [project.id]);
  const last = jobs.status === "ready" ? (jobs.data.find((j) => !j.dry_run && j.result && readNumber(j.result, "objects") !== null) ?? null) : null;
  const result = last?.result ?? null;
  const perClass = (result && typeof result.per_class === "object" && result.per_class ? result.per_class : {}) as Record<string, unknown>;
  const total = result ? readNumber(result, "objects") : null;
  const images = result ? readNumber(result, "images") : null;
  const unmapped = result ? readNumber(result, "unmapped_objects") : null;
  const classes = inClassOrder([...new Set([...project.classes, ...Object.keys(perClass)])], project.classes);

  return (
    <Box component="section" aria-labelledby="dash-count-title" sx={{ display: "grid", gap: 1.25, minWidth: 0 }}>
      <SectionTitle id="dash-count-title">MATERIAL COUNT</SectionTitle>
      {jobs.status === "loading" && <LoadingRow label="Loading the counts…" />}
      {jobs.status === "error" && <ErrorRow what="The counts could not be loaded" message={jobs.message} onRetry={reload} />}
      {jobs.status === "ready" && !result && (
        <Card>
          <CardContent sx={{ p: 2 }}>
            <Typography color="text.secondary">
              No stored frame has been labelled yet. The counts appear once a video's frames have been labelled.
            </Typography>
          </CardContent>
        </Card>
      )}
      {result && total !== null && (
        <>
          {classes.map((c) => {
            const n = typeof perClass[c] === "number" ? (perClass[c] as number) : 0;
            const share = total > 0 ? (n / total) * 100 : 0;
            const colour = colourFor(project.classes, c);
            return (
              <Card key={c}>
                <Box sx={{ display: "grid", gap: 0.75, px: 2, py: 1.25 }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
                    <Box aria-hidden sx={{ width: 12, height: 12, borderRadius: "3px", bgcolor: colour, flexShrink: 0 }} />
                    <Typography sx={{ flex: "1 1 auto", fontWeight: 600, minWidth: 0, overflowWrap: "anywhere", textTransform: "capitalize" }}>{c}</Typography>
                    <Typography sx={{ fontSize: "1.125rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatCount(n)}</Typography>
                    <Typography color="text.secondary" sx={{ width: 56, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {share.toFixed(1)}%
                    </Typography>
                  </Box>
                  <Box aria-hidden sx={{ height: 4, borderRadius: 999, bgcolor: rx.border }}>
                    <Box sx={{ width: `${Math.min(100, share)}%`, height: 4, borderRadius: 999, bgcolor: colour }} />
                  </Box>
                </Box>
              </Card>
            );
          })}

          <Card>
            <Box sx={{ display: "grid", justifyItems: "center", gap: 0.25, px: 2, py: 1.5 }}>
              <Typography sx={{ fontSize: "0.75rem", letterSpacing: "0.8px", color: "text.secondary" }}>TOTAL OBJECTS</Typography>
              <Typography sx={{ fontSize: "2.5rem", fontWeight: 700, lineHeight: 1.1, color: rx.accentInk, fontVariantNumeric: "tabular-nums" }}>
                {formatCount(total)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {images !== null ? `across ${plural(images, "frame", "frames")}, as the model labelled them` : "as the model labelled them"}
              </Typography>
            </Box>
          </Card>

          {unmapped !== null && unmapped > 0 && (
            <Card>
              <Box sx={{ display: "grid", gap: 0.25, px: 2, py: 1.25 }}>
                <Typography variant="body2" color="text.secondary">
                  Not matched to a class
                </Typography>
                <Typography sx={{ fontSize: "1.25rem", fontWeight: 700, color: rx.warning, fontVariantNumeric: "tabular-nums" }}>
                  {formatCount(unmapped)}{" "}
                  <Box component="span" sx={{ fontSize: "0.75rem", fontWeight: 400, color: "text.secondary" }}>
                    {unmapped === 1 ? "object" : "objects"}
                  </Box>
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Found by the model, but its class has no match in this project.
                </Typography>
              </Box>
            </Card>
          )}
          <Typography variant="body2" color="text.secondary">
            Counts from the model's last pre-label run. They say how much it found, not how correct it is.
          </Typography>
        </>
      )}
    </Box>
  );
}

/** The API's estimate of hand-annotation time saved. Always shown as an estimate, with its basis. */
function SavingCard({ summary }: { summary: Load<QaSummary> }) {
  const s = summary.status === "ready" ? (summary.data.annotation_saving ?? null) : null;
  const usable = s && typeof s.minutes === "number" && typeof s.machine_outlines === "number" && typeof s.assumed_seconds_per_outline === "number";
  return (
    <Card component="section" aria-labelledby="dash-saving-title">
      <CardContent sx={{ display: "grid", gap: 0.75, p: 2 }}>
        <SectionTitle id="dash-saving-title">HUMAN ANNOTATION SAVED (ESTIMATE)</SectionTitle>
        {summary.status === "loading" && <Typography color="text.secondary">loading…</Typography>}
        {summary.status === "error" && <Typography color="text.secondary">could not be loaded</Typography>}
        {summary.status === "ready" && !usable && <Typography color="text.secondary">The API gave no estimate.</Typography>}
        {usable && (
          <>
            <Typography sx={{ fontSize: "2.125rem", fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" }}>
              {s.minutes >= 100 ? formatCount(Math.round(s.minutes)) : s.minutes.toFixed(1)}{" "}
              <Box component="span" sx={{ fontSize: "0.875rem", fontWeight: 400, color: "text.secondary" }}>
                minutes, estimated
              </Box>
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
              {plural(s.machine_outlines, "outline", "outlines")} drawn by the model × {formatCount(s.assumed_seconds_per_outline)} s assumed
              per hand-drawn outline. An assumption, not a measurement; review time is not subtracted.
            </Typography>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** What is true right now: which weights label, whether Gemini answers, and the retrain schedule. */
function StatusCard({ project, versions }: { project: Project; versions: Load<ModelVersion[]> }) {
  const [gemini] = useLoad(() => api.geminiStatus(), []);
  const list = versions.status === "ready" ? versions.data : [];
  const active = project.active_model_version ?? (list.some((v) => v.version === 0) ? 0 : null);
  const row = (label: string, value: ReactNode) => (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 2, rowGap: 0.5 }}>
      <Typography color="text.secondary">{label}</Typography>
      <Box sx={{ fontWeight: 600, textAlign: "right", minWidth: 0 }}>{value}</Box>
    </Box>
  );
  return (
    <Card component="section" aria-labelledby="dash-status-title">
      <CardContent sx={{ display: "grid", gap: 1.25, p: 2 }}>
        <SectionTitle id="dash-status-title">SYSTEM STATUS</SectionTitle>
        {row("Model labelling now", active === null ? "starting weights, not scored yet" : active === 0 ? "starting weights (v0)" : `version ${active}`)}
        {row(
          "Gemini check",
          gemini.status === "loading" ? (
            <StatusBadge>asking…</StatusBadge>
          ) : gemini.status === "ready" && gemini.data.ok ? (
            <StatusBadge tone="success" icon={<CheckCircleOutlinedIcon aria-hidden />}>
              answering
            </StatusBadge>
          ) : (
            <StatusBadge tone={gemini.status === "error" ? "warning" : "error"} icon={<ErrorOutlineOutlinedIcon aria-hidden />}>
              {gemini.status === "error" ? "unknown" : "not answering"}
            </StatusBadge>
          ),
        )}
        {row("Retrain schedule", project.retrain_interval_hours ? `every ${plural(project.retrain_interval_hours, "hour", "hours")}` : "off")}
        <Button component={RouterLink} to={`/projects/${encodeURIComponent(project.id)}/train`} endIcon={<ArrowForwardIcon />} sx={{ justifySelf: "start" }}>
          Open Train &amp; export
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The front page for one project, laid out like the Reneonix camera dashboard: the belt on the
 * left, the material count on the right, and under the belt where the retraining loop stands.
 * Every figure comes from the API. The belt card can also show the chosen camera live, with the
 * model labelling a still frame of it every few seconds (LiveCameraView).
 */
export default function DashboardPage({ pid }: { pid: string }) {
  const navigate = useNavigate();
  const [project, reloadProject] = useLoad(() => api.getProject(pid), [pid]);
  const [projects] = useLoad(() => api.listProjects(), []);
  const [images] = useLoad(async () => (await api.listImages(pid, { limit: FRAMES_TO_CHOOSE_FROM })).images, [pid]);
  const [gold] = useLoad(() => api.getGold(pid), [pid]);
  const [summary] = useLoad(() => api.getQaSummary(pid), [pid]);
  const [versions] = useLoad(() => api.listModelVersions(pid), [pid]);

  if (project.status === "loading") return <LoadingRow label="Loading the project…" />;
  if (project.status === "error") {
    return (
      <Stack spacing={2}>
        <ErrorRow what="This project could not be loaded" message={project.message} onRetry={reloadProject} />
        <Box>
          <Button component={RouterLink} to="/projects">
            All projects
          </Button>
        </Box>
      </Stack>
    );
  }
  const p = project.data;
  const others = projects.status === "ready" ? projects.data : [p];

  return (
    <Stack spacing={{ xs: 2, md: 3 }}>
      <PageHeader
        eyebrow="Dashboard"
        title={p.name}
        subtitle="The belt as the model sees it, what it counted, and where the retraining loop stands."
        actions={
          <TextField
            select
            label="Project"
            size="small"
            value={p.id}
            onChange={(e) => navigate(`/projects/${encodeURIComponent(e.target.value)}/dashboard`)}
            sx={{ minWidth: 220 }}
          >
            {others.map((o) => (
              <MenuItem key={o.id} value={o.id}>
                {o.name}
              </MenuItem>
            ))}
          </TextField>
        }
      />

      <Box
        sx={{
          display: "grid",
          gap: { xs: 2, md: 3 },
          gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 1fr) 340px" },
          alignItems: "start",
        }}
      >
        <Stack spacing={{ xs: 2, md: 3 }} sx={{ minWidth: 0 }}>
          <FramePanel project={p} images={images} />
          <LoopStrip project={p} cells={loopCells(p, gold, summary, versions)} />
        </Stack>
        <Stack spacing={{ xs: 2, md: 3 }} sx={{ minWidth: 0 }}>
          <MaterialCount project={p} />
          <SavingCard summary={summary} />
          <StatusCard project={p} versions={versions} />
        </Stack>
      </Box>
    </Stack>
  );
}
