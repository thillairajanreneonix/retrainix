import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";
import { Box, Button, Stack } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { api, type GoldStatus, type Project, type QaSummary } from "../api";
import { formatCount } from "../format";
import { useLoad, type Load } from "../hooks";
import ClassMapCard from "../components/ClassMapCard";
import FramesBrowser from "../components/FramesBrowser";
import GeminiCheckCard from "../components/GeminiCheckCard";
import GoldCard from "../components/GoldCard";
import HoldoutCard from "../components/HoldoutCard";
import PrelabelCard from "../components/PrelabelCard";
import { ErrorRow, LoadingRow } from "../components/States";
import { PageHeader, WorkflowStepper, type WorkflowStep } from "../components/ui";

/**
 * Where each of the six steps stands, from what the API already returned for the cards below.
 * A step is "done" only when the API says so; while a figure is still loading its note says so.
 */
function stepsOf(p: Project, gold: Load<GoldStatus>, summary: Load<QaSummary>): WorkflowStep[] {
  const g = gold.status === "ready" ? gold.data : null;
  const s = summary.status === "ready" ? summary.data : null;
  const mapped = Object.keys(p.class_map ?? {}).length;
  const frames = p.counts?.frames ?? 0;
  const predicted = p.counts?.predicted ?? 0;
  const holdout = p.holdout ?? s?.holdout ?? null;

  const rows: { label: string; href: string; done: boolean; note: string }[] = [
    {
      label: "Class mapping",
      href: "#class-map-title",
      done: mapped > 0,
      note: mapped > 0 ? `${formatCount(mapped)} model classes mapped` : "no model class mapped yet",
    },
    {
      label: "Pre-label",
      href: "#prelabel-title",
      done: frames > 0 && predicted >= frames,
      note: frames === 0 ? "no frames yet" : `${formatCount(Math.min(predicted, frames))} of ${formatCount(frames)} frames labelled`,
    },
    {
      label: "Gold set",
      href: "#gold-title",
      done: Boolean(g?.frozen),
      note: !g
        ? gold.status === "error" ? "could not be loaded" : "loading…"
        : g.frozen
          ? `${formatCount(g.gold_exemplar)} examples, ${formatCount(g.gold_holdout)} held back`
          : `${formatCount(g.reviewed_images)} of ${formatCount(g.required_images)} frames checked`,
    },
    {
      label: "Hold-out check",
      href: "#holdout-title",
      done: Boolean(holdout),
      note: holdout ? (holdout.passed ? "run, passed" : "run, below the bar") : "not run yet",
    },
    {
      label: "Gemini check",
      href: "#gemini-title",
      done: Boolean(s?.last_qa),
      note: !s
        ? summary.status === "error" ? "could not be loaded" : "loading…"
        : s.last_qa
          ? `${formatCount(s.last_qa.passed)} passed, ${formatCount(s.last_qa.human_review)} to a person`
          : "not run yet",
    },
    {
      label: "Frames and review",
      href: "#frames-browser-title",
      done: false,
      note: s ? `${formatCount(s.images.human_review)} waiting for a person` : "open a frame to check it",
    },
  ];
  const firstOpen = rows.findIndex((r) => !r.done);
  return rows.map((r, i) => ({
    n: i + 1,
    label: r.label,
    href: r.href,
    note: r.note,
    state: r.done ? "done" : i === firstOpen ? "current" : "waiting",
  }));
}

/**
 * Annotation QA as a guided sequence (docs/api.md, "Review, gold set and the teacher loop"):
 * 1 class mapping, 2 pre-label, 3 gold set, 4 hold-out check, 5 Gemini check, 6 frames and
 * review. The API fixes the order; each card says what it is waiting for.
 */
export default function QaPage({ pid }: { pid: string }) {
  const [project, reloadProject] = useLoad(() => api.getProject(pid), [pid]);
  const [models, reloadModels] = useLoad(() => api.listModels(), []);
  const [gold, reloadGold] = useLoad(() => api.getGold(pid), [pid]);
  const [summary, reloadSummary] = useLoad(() => api.getQaSummary(pid), [pid]);
  const [framesKey, setFramesKey] = useState(0);

  // A review was saved: the counts moved, but the grid keeps its own list until the dialog closes.
  const reloadCounts = useCallback(() => {
    reloadProject();
    reloadGold();
    reloadSummary();
  }, [reloadProject, reloadGold, reloadSummary]);

  // A job started or finished, or the gold set was frozen: counts and the grid may all have changed.
  const onChanged = useCallback(() => {
    reloadCounts();
    setFramesKey((k) => k + 1);
  }, [reloadCounts]);

  // A link from another screen can name a step (#class-map-title). The cards exist only once
  // the project has loaded, so the jump is made then.
  const { hash } = useLocation();
  const loaded = project.status === "ready";
  useEffect(() => {
    if (!loaded || !hash) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "start" });
  }, [loaded, hash]);

  if (project.status === "loading") return <LoadingRow label="Loading the project…" />;
  if (project.status === "error") {
    return (
      <Stack spacing={2}>
        <ErrorRow what="This project could not be loaded" message={project.message} onRetry={reloadProject} />
        <Box>
          <Button component={RouterLink} to="/projects" startIcon={<ArrowBackIcon />}>
            All projects
          </Button>
        </Box>
      </Stack>
    );
  }

  const p = project.data;

  return (
    <Stack spacing={{ xs: 2, md: 3 }}>
      <PageHeader
        eyebrow="Annotation QA"
        title={p.name}
        subtitle="The model labels each frame; you check the result here. The six steps run in this order, and each one says what it is waiting for."
        back={{ to: `/projects/${encodeURIComponent(pid)}`, label: "Project setup" }}
      />

      <WorkflowStepper label="The six steps" steps={stepsOf(p, gold, summary)} />

      <Box
        sx={{
          display: "grid",
          gap: { xs: 2, md: 3 },
          gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" },
          alignItems: "start",
          "& > *": { minWidth: 0 },
        }}
      >
        <ClassMapCard step={1} project={p} models={models} onRetryModels={reloadModels} onSaved={reloadProject} />
        <PrelabelCard project={p} onChanged={onChanged} />
        <GoldCard project={p} gold={gold} onRetry={reloadGold} onFrozen={onChanged} />
        <HoldoutCard project={p} gold={gold} summary={summary} onChanged={onChanged} />
        <Box sx={{ gridColumn: "1 / -1" }}>
          <GeminiCheckCard project={p} summary={summary} onRetrySummary={reloadSummary} onChanged={onChanged} />
        </Box>
      </Box>

      <FramesBrowser project={p} summary={summary} gold={gold} refreshKey={framesKey} onReviewed={reloadCounts} onJobChanged={onChanged} />

      <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          variant="contained"
          component={RouterLink}
          to={`/projects/${encodeURIComponent(pid)}/train`}
          endIcon={<ArrowForwardIcon />}
        >
          Next: Train &amp; export
        </Button>
      </Box>
    </Stack>
  );
}
