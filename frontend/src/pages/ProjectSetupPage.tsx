import { useCallback, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, Card, CardContent, Chip, Stack, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { api, type Job, type ModelRecord, type Project } from "../api";
import { formatCount, formatDate, framesInProject, framesWithLabels, humanise } from "../format";
import { announceJobFinished, useLoad, type Load } from "../hooks";
import AddVideoCard from "../components/AddVideoCard";
import AssetList, { isActive } from "../components/AssetList";
import AutoLabelCard from "../components/AutoLabelCard";
import ClassMapCard from "../components/ClassMapCard";
import FramesSection from "../components/FramesSection";
import { licenceText } from "../components/ModelCard";
import { ErrorRow, LoadingRow } from "../components/States";
import { MetricCard, PageHeader, StatusBadge } from "../components/ui";

const POLL_MS = 2000; // docs/api.md: re-read a job every 2 seconds while queued or running

export default function ProjectSetupPage({ pid }: { pid: string }) {
  const [project, reloadProject] = useLoad(() => api.getProject(pid), [pid]);
  const [models, reloadModels] = useLoad(() => api.listModels(), []);
  const [assets, reloadAssets] = useLoad(() => api.listAssets(pid), [pid]);

  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [pollErrors, setPollErrors] = useState<Record<string, string>>({});
  const [framesKey, setFramesKey] = useState(0);
  const requested = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());

  const putJob = useCallback((job: Job) => {
    requested.current.add(job.id);
    setJobs((prev) => ({ ...prev, [job.id]: job }));
  }, []);

  const refreshAll = useCallback(() => {
    reloadAssets();
    reloadProject();
    setFramesKey((k) => k + 1);
  }, [reloadAssets, reloadProject]);

  // Read, once, the job behind every asset that names one.
  useEffect(() => {
    if (assets.status !== "ready") return;
    for (const asset of assets.data) {
      const jid = asset.job_id;
      if (!jid || requested.current.has(jid)) continue;
      requested.current.add(jid);
      api.getJob(pid, jid).then(putJob, () => {
        requested.current.delete(jid); // tried again the next time the assets are re-read
      });
    }
  }, [assets, pid, putJob]);

  // Poll every queued or running job; stop when it succeeds, fails or is cancelled.
  const activeIds = Object.values(jobs)
    .filter(isActive)
    .map((j) => j.id)
    .sort()
    .join("\n");

  useEffect(() => {
    if (!activeIds) return;
    const ids = activeIds.split("\n");
    let stopped = false;
    const timer = window.setInterval(() => {
      for (const jid of ids) {
        if (inFlight.current.has(jid)) continue;
        inFlight.current.add(jid);
        api
          .getJob(pid, jid)
          .then(
            (job) => {
              if (stopped) return;
              setPollErrors((prev) => {
                if (!(jid in prev)) return prev;
                const next = { ...prev };
                delete next[jid];
                return next;
              });
              putJob(job);
              if (!isActive(job)) {
                announceJobFinished();
                refreshAll();
              }
            },
            (err: unknown) => {
              if (stopped) return;
              const message = err instanceof Error ? err.message : "no answer";
              setPollErrors((prev) => ({ ...prev, [jid]: message }));
            },
          )
          .finally(() => inFlight.current.delete(jid));
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pid, activeIds, putJob, refreshAll]);

  const onJobStarted = useCallback(
    (job: Job) => {
      putJob(job);
      reloadAssets();
      reloadProject();
      if (!isActive(job)) setFramesKey((k) => k + 1);
    },
    [putJob, reloadAssets, reloadProject],
  );

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
    <Stack spacing={3}>
      <ProjectHeader project={p} />

      {/* Before the upload, not after it: the first labelled frame locks the mapping, and labelling starts by itself. */}
      <ClassMapCard project={p} models={models} onRetryModels={reloadModels} onSaved={reloadProject} />

      <Box sx={{ display: "grid", gap: { xs: 2, md: 3 }, gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 7fr) minmax(0, 5fr)" }, alignItems: "start" }}>
        <AddVideoCard pid={pid} onJobStarted={onJobStarted} onAssetsChanged={reloadAssets} />
        <Stack spacing={{ xs: 2, md: 3 }} sx={{ minWidth: 0 }}>
          <ProjectDetails project={p} models={models} />
          <AutoLabelCard project={p} refreshKey={framesKey} onFinished={reloadProject} />
          <Box sx={{ display: "grid", gap: { xs: 2, md: 3 }, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <MetricCard label="Frames kept" value={formatCount(framesInProject(p.counts))} hint="from the videos below" />
            <MetricCard label="Frames with labels" value={formatCount(framesWithLabels(p.counts))} hint="from the model, so far" />
          </Box>
        </Stack>
      </Box>

      <Box component="section" aria-labelledby="videos-title">
        <Typography id="videos-title" variant="h5" component="h3" sx={{ mb: 1.5 }}>
          Videos
        </Typography>
        <AssetList assets={assets} jobs={jobs} pollErrors={pollErrors} onRetry={reloadAssets} />
      </Box>

      <FramesSection
        pid={pid}
        total={p.counts ? framesInProject(p.counts) : null}
        assets={assets.status === "ready" ? assets.data : []}
        refreshKey={framesKey}
      />
    </Stack>
  );
}

function ModelLine({ role, recipeId, models }: { role: string; recipeId: string; models: Load<ModelRecord[]> }) {
  const model = models.status === "ready" ? (models.data.find((m) => m.id === recipeId) ?? null) : null;

  let licence: string;
  if (models.status === "loading") licence = "loading the licence…";
  else if (models.status === "error") licence = "licence could not be loaded";
  else if (!model) licence = "licence unknown, this model is not in the catalogue";
  else licence = `licence ${licenceText(model)}`;

  return (
    <Box>
      <Typography sx={{ overflowWrap: "anywhere" }}>
        <Box component="span" sx={{ color: "text.secondary" }}>
          {role}:{" "}
        </Box>
        <Box component="span" sx={{ fontWeight: 500 }}>
          {model ? model.name : recipeId}
        </Box>{" "}
        · {licence}
      </Typography>
      {model?.licence_notice ? (
        <Alert severity="warning" sx={{ mt: 1, overflowWrap: "anywhere" }}>
          {model.licence_notice}
        </Alert>
      ) : null}
    </Box>
  );
}

function ProjectHeader({ project }: { project: Project }) {
  return (
    <PageHeader
      eyebrow="Project setup"
      title={project.name}
      subtitle="Check the class mapping, then add footage of the belt. Frames are sampled from each video and labelled by the model by itself; you check them on the next screen."
      back={{ to: "/projects", label: "All projects" }}
      actions={
        <Button variant="contained" component={RouterLink} to={`/projects/${encodeURIComponent(project.id)}/qa`} endIcon={<ArrowForwardIcon />}>
          Next: Annotation QA
        </Button>
      }
    >
      <Stack direction="row" useFlexGap spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1, mt: 0.5 }}>
        <StatusBadge tone="accent">State: {humanise(project.state)}</StatusBadge>
        <Box component="ul" aria-label="Classes" sx={{ listStyle: "none", p: 0, m: 0, display: "flex", flexWrap: "wrap", gap: 1 }}>
          {project.classes.map((c) => (
            <li key={c}>
              <Chip variant="outlined" size="small" label={c} sx={{ maxWidth: "100%" }} />
            </li>
          ))}
        </Box>
      </Stack>
    </PageHeader>
  );
}

function ProjectDetails({ project, models }: { project: Project; models: Load<ModelRecord[]> }) {
  return (
    <Card component="section" aria-labelledby="project-details-title">
      <CardContent sx={{ display: "grid", gap: 1.5, p: { xs: 2, sm: 3 } }}>
        <Typography id="project-details-title" variant="h5" component="h3">
          Model
        </Typography>
        {project.prelabel_recipe === project.recipe ? (
          // One model does both jobs, so it is named once.
          <ModelLine role="Pre-labels and trains" recipeId={project.recipe} models={models} />
        ) : (
          <>
            <ModelLine role="Pre-labels with" recipeId={project.prelabel_recipe} models={models} />
            <ModelLine role="Trains" recipeId={project.recipe} models={models} />
          </>
        )}
        <Typography variant="body2" color="text.secondary">
          Created <time dateTime={project.created_at}>{formatDate(project.created_at)}</time>
        </Typography>
      </CardContent>
    </Card>
  );
}
