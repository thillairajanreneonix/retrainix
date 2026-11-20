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
          <Button component={RouterLink} to="/" startIcon={<ArrowBackIcon />}>
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
    <Stack spacing={3}>
      <Box component="header">
        <Typography variant="overline" color="text.secondary">
          Train &amp; export
        </Typography>
        <Typography variant="h4" component="h2" sx={{ overflowWrap: "anywhere" }}>
          {p.name}
        </Typography>
        <Typography color="text.secondary">
          Train a new model version from the checked frames, see how each version scores on the same gold hold-out,
          and download the weights.
        </Typography>
      </Box>

      <Card component="section" aria-labelledby="trend-title">
        <CardContent sx={{ display: "grid", gap: 1.5, p: { xs: 2, sm: 3 } }}>
          <Typography id="trend-title" variant="h5" component="h3">
            Accuracy by model version
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

      {versions.status === "ready" && list.length > 0 && (
        <Box component="section" aria-labelledby="versions-title">
          <Typography id="versions-title" variant="h5" component="h3" sx={{ mb: 1.5 }}>
            Model versions
          </Typography>
          <ModelVersionsTable pid={pid} versions={list} activeVersion={activeVersion} classes={p.classes} />
        </Box>
      )}

      <TrainCard project={p} onChanged={onChanged} />
      <DatasetsCard project={p} datasets={datasets} onRetry={reloadDatasets} onChanged={onChanged} />
      <ScheduleCard project={p} config={config} onSaved={reloadProject} />
    </Stack>
  );
}
