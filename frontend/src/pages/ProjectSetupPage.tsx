import { useCallback, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, Card, CardContent, Chip, Link, Stack, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { api, type Job, type ModelRecord, type Project } from "../api";
import { formatDate, humanise } from "../format";
import { announceJobFinished, useLoad, type Load } from "../hooks";
import AddVideoCard from "../components/AddVideoCard";
import AssetList, { isActive } from "../components/AssetList";
import FramesSection from "../components/FramesSection";
import { licenceText } from "../components/ModelCard";
import { ErrorRow, LoadingRow } from "../components/States";

const POLL_MS = 2000; // docs/api.md: re-read a job every 2 seconds while queued or running

export default function ProjectSetupPage({ pid }: { pid: string }) {
  const [project, reloadProject] = useLoad(() => api.getProject(pid), [pid]);
  const [models] = useLoad(() => api.listModels(), []);
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
          <Button component={RouterLink} to="/" startIcon={<ArrowBackIcon />}>
            All projects
          </Button>
        </Box>
      </Stack>
    );
  }

  const p = project.data;

  return (
    <Stack spacing={3}>
      <ProjectHeader project={p} models={models} />
      <AddVideoCard pid={pid} onJobStarted={onJobStarted} onAssetsChanged={reloadAssets} />

      <Box component="section" aria-labelledby="videos-title">
        <Typography id="videos-title" variant="h5" component="h3" sx={{ mb: 1.5 }}>
          Videos
        </Typography>
        <AssetList assets={assets} jobs={jobs} pollErrors={pollErrors} onRetry={reloadAssets} />
      </Box>

      <FramesSection
        pid={pid}
        total={p.counts?.frames ?? null}
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

function ProjectHeader({ project, models }: { project: Project; models: Load<ModelRecord[]> }) {
  return (
    <Box component="header" sx={{ display: "grid", gap: 1.5 }}>
      <Link
        component={RouterLink}
        to="/"
        underline="hover"
        sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, minHeight: 44, justifySelf: "start" }}
      >
        <ArrowBackIcon fontSize="small" aria-hidden />
        All projects
      </Link>

      <Stack direction="row" useFlexGap spacing={1.5} sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}>
        <Typography variant="h4" component="h2" sx={{ overflowWrap: "anywhere", minWidth: 0 }}>
          {project.name}
        </Typography>
        <Chip label={`State: ${humanise(project.state)}`} />
      </Stack>

      <Box component="ul" aria-label="Classes" sx={{ listStyle: "none", p: 0, m: 0, display: "flex", flexWrap: "wrap", gap: 1 }}>
        {project.classes.map((c) => (
          <li key={c}>
            <Chip variant="outlined" label={c} sx={{ maxWidth: "100%" }} />
          </li>
        ))}
      </Box>

      <Card>
        <CardContent sx={{ display: "grid", gap: 1.5 }}>
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
    </Box>
  );
}
