import { useCallback, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Box, Button, Stack, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { api } from "../api";
import { useLoad } from "../hooks";
import ClassMapCard from "../components/ClassMapCard";
import FramesBrowser from "../components/FramesBrowser";
import GeminiCheckCard from "../components/GeminiCheckCard";
import GoldCard from "../components/GoldCard";
import HoldoutCard from "../components/HoldoutCard";
import PrelabelCard from "../components/PrelabelCard";
import { ErrorRow, LoadingRow } from "../components/States";

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
      <Box component="header">
        <Typography variant="overline" color="text.secondary">
          Annotation QA
        </Typography>
        <Typography variant="h4" component="h2" sx={{ overflowWrap: "anywhere" }}>
          {p.name}
        </Typography>
        <Typography color="text.secondary">
          The model labels each frame; you check the result here. The six steps run in this order.
        </Typography>
      </Box>

      <ClassMapCard project={p} models={models} onRetryModels={reloadModels} onSaved={reloadProject} />
      <PrelabelCard project={p} onChanged={onChanged} />
      <GoldCard project={p} gold={gold} onRetry={reloadGold} onFrozen={onChanged} />
      <HoldoutCard project={p} gold={gold} summary={summary} onChanged={onChanged} />
      <GeminiCheckCard project={p} summary={summary} onRetrySummary={reloadSummary} onChanged={onChanged} />
      <FramesBrowser project={p} summary={summary} gold={gold} refreshKey={framesKey} onReviewed={reloadCounts} />

      <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          variant="outlined"
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
