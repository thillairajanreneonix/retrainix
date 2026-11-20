import { useCallback } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Box, Button, Card, CardContent, Stack, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import TimelineOutlinedIcon from "@mui/icons-material/TimelineOutlined";
import { api } from "../api";
import { useLoad } from "../hooks";
import DatasetsCard from "../components/DatasetsCard";
import ModelVersionsTable from "../components/ModelVersionsTable";
import ScheduleCard from "../components/ScheduleCard";
import { EmptyState, ErrorRow, LoadingRow } from "../components/States";
import { PageHeader, StatusBadge } from "../components/ui";
import TrainCard from "../components/TrainCard";
import TrendChart from "../components/TrendChart";

/**
 * Train & export (docs/api.md, "Dataset, training, model versions and the schedule"): the
 * accuracy of every model version on the same gold hold-out, the versions and their weights,
 * starting a training run, the exported datasets, and the retrain schedule.
 */
export default function TrainPage({ pid }: { pid: string }) {
  const [project, reloadProject] = useLoad(() => api.getProject(pid), [pid]);
  const [versions, reloadVersions] = useLoad(() => api.listModelVersions(pid), [pid]);
  const [datasets, reloadDatasets] = useLoad(() => api.listDatasetVersions(pid), [pid]);
  const [config] = useLoad(() => api.config(), []);

  // A job started or finished: the chart, the table, the datasets and the project may all have moved.
  const onChanged = useCallback(() => {
    reloadProject();
    reloadVersions();
    reloadDatasets();
  }, [reloadProject, reloadVersions, reloadDatasets]);

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
  const list = versions.status === "ready" ? [...versions.data].sort((a, b) => a.version - b.version) : [];
  // The active version pre-labels. Before any promotion that is the starting weights, version 0.
  const activeVersion = p.active_model_version ?? (list.some((v) => v.version === 0) ? 0 : null);
  const qaLink = `/projects/${encodeURIComponent(pid)}/qa`;

  return (
    <Stack spacing={{ xs: 2, md: 3 }}>
      <PageHeader
        eyebrow="Train & export"
        title={p.name}
        subtitle="Train a new model version from the checked frames, see how each version scores on the same gold hold-out, and download the weights."
        back={{ to: qaLink, label: "Annotation QA" }}
      >
        <Box sx={{ mt: 0.5 }}>
          {/* The version that labels frames right now. This app tracks no separate "deployed" status. */}
          <StatusBadge tone={activeVersion === null ? "neutral" : "accent"}>
            {activeVersion === null
              ? "No model version has been scored yet"
              : activeVersion === 0
                ? "Labelling now: the starting weights (version 0)"
                : `Labelling now: version ${activeVersion}`}
          </StatusBadge>
        </Box>
      </PageHeader>

      <Box
        sx={{
          display: "grid",
          gap: { xs: 2, md: 3 },
          gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 7fr) minmax(0, 5fr)" },
          alignItems: "start",
          "& > *": { minWidth: 0 },
        }}
      >
      <Card component="section" aria-labelledby="trend-title">
        <CardContent sx={{ display: "grid", gap: 1.5, p: { xs: 2, sm: 3 } }}>
          <Typography id="trend-title" variant="h5" component="h3">
            Score by model version
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Each version is scored on the same gold hold-out frames. Pick the measure to plot; its name is on the
            button.
          </Typography>
          {versions.status === "loading" && <LoadingRow label="Loading model versions…" />}
          {versions.status === "error" && (
            <ErrorRow what="The model versions could not be loaded" message={versions.message} onRetry={reloadVersions} />
          )}
          {versions.status === "ready" && list.length === 0 && (
            <EmptyState
              icon={<TimelineOutlinedIcon fontSize="large" />}
              title="No version has been scored yet"
              action={
                <Button variant="contained" component={RouterLink} to={qaLink}>
                  Go to Annotation QA
                </Button>
              }
            >
              Run the hold-out check on the Annotation QA screen (step 4). Each version then appears here as a
              point, scored on the same gold frames.
            </EmptyState>
          )}
          {versions.status === "ready" && list.length > 0 && <TrendChart versions={list} activeVersion={activeVersion} />}
        </CardContent>
      </Card>

        <TrainCard project={p} onChanged={onChanged} />
      </Box>

      {versions.status === "ready" && list.length > 0 && (
        <Box component="section" aria-labelledby="versions-title">
          <Typography id="versions-title" variant="h5" component="h3" sx={{ mb: 1.5 }}>
            Model versions
          </Typography>
          <ModelVersionsTable pid={pid} versions={list} activeVersion={activeVersion} classes={p.classes} />
        </Box>
      )}

      <Box
        sx={{
          display: "grid",
          gap: { xs: 2, md: 3 },
          gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 7fr) minmax(0, 5fr)" },
          alignItems: "start",
          "& > *": { minWidth: 0 },
        }}
      >
        <DatasetsCard project={p} datasets={datasets} onRetry={reloadDatasets} onChanged={onChanged} />
        <ScheduleCard project={p} config={config} onSaved={reloadProject} />
      </Box>
    </Stack>
  );
}
