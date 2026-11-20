import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Typography,
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { api, errorMessage, type GoldStatus, type Project } from "../api";
import { formatCount, inClassOrder, plural } from "../format";
import type { Load } from "../hooks";
import { ErrorRow, LoadingRow } from "./States";
import { StepTitle } from "./Step";

/**
 * Step 3: the human-checked frames that become the fixed exam. Everything shown comes from
 * GET /gold; the freeze cannot be undone, so it is confirmed first.
 */
export default function GoldCard({
  project,
  gold,
  onRetry,
  onFrozen,
}: {
  project: Project;
  gold: Load<GoldStatus>;
  onRetry: () => void;
  onFrozen: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const freeze = async () => {
    setFreezing(true);
    setError(null);
    try {
      await api.freezeGold(project.id);
      setConfirming(false);
      onFrozen();
    } catch (err) {
      setConfirming(false);
      setError(errorMessage(err));
    } finally {
      setFreezing(false);
    }
  };

  let body;
  if (gold.status === "loading") {
    body = <LoadingRow label="Loading the gold set…" />;
  } else if (gold.status === "error") {
    body = <ErrorRow what="The gold set could not be loaded" message={gold.message} onRetry={onRetry} />;
  } else {
    const g = gold.data;
    const intro = (
      <Typography color="text.secondary">
        A person checks {plural(g.required_images, "frame", "frames")}. {formatCount(g.holdout_count)} of them become
        the fixed exam that every model version is scored on, and no job may change them. The other{" "}
        {formatCount(g.exemplar_count)} are shown to Gemini as examples of correct labels.
      </Typography>
    );

    if (g.frozen) {
      body = (
        <>
          {intro}
          <Alert icon={<LockOutlinedIcon fontSize="inherit" />} severity="success" sx={{ overflowWrap: "anywhere" }}>
            Gold set frozen: {plural(g.gold_exemplar, "exemplar", "exemplars")}, {formatCount(g.gold_holdout)}{" "}
            hold-out.
            {g.holdout_note ? ` ${g.holdout_note}` : ""}
          </Alert>
        </>
      );
    } else {
      const names = inClassOrder(
        [...new Set([...project.classes, ...Object.keys(g.objects_per_class ?? {})])],
        project.classes,
      );
      const checked = Math.min(g.reviewed_images, g.required_images);
      body = (
        <>
          {intro}

          <Box>
            <Typography id="gold-progress-label">
              {g.reviewed_images > g.required_images
                ? `${plural(g.reviewed_images, "frame", "frames")} checked by a person (${formatCount(g.required_images)} needed)`
                : `${formatCount(g.reviewed_images)} of ${plural(g.required_images, "frame", "frames")} checked by a person`}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={g.required_images > 0 ? (checked / g.required_images) * 100 : 0}
              aria-labelledby="gold-progress-label"
              sx={{ mt: 0.75, height: 8, borderRadius: "4px" }}
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
              To check a frame, open it under Frames (step 6) and accept it or save your corrections.
            </Typography>
          </Box>

          <Box component="section" aria-labelledby="gold-classes-title">
            <Typography id="gold-classes-title" variant="subtitle2" component="h4" sx={{ mb: 0.5 }}>
              Examples per class in the checked frames (at least {formatCount(g.min_examples_per_class)} each)
            </Typography>
            <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 0.5 }}>
              {names.map((name) => {
                const n = g.objects_per_class?.[name] ?? 0;
                const enough = n >= g.min_examples_per_class;
                return (
                  <Box component="li" key={name} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    {enough ? (
                      <CheckCircleOutlineIcon fontSize="small" color="success" aria-hidden />
                    ) : (
                      <ErrorOutlineIcon fontSize="small" color="warning" aria-hidden />
                    )}
                    <Typography sx={{ overflowWrap: "anywhere", fontWeight: enough ? 400 : 500 }}>
                      {n > g.min_examples_per_class
                        ? `${name} ${plural(n, "example", "examples")}`
                        : `${name} ${formatCount(n)} of ${plural(g.min_examples_per_class, "example", "examples")}`}
                      {enough ? "" : " (below the minimum)"}
                    </Typography>
                  </Box>
                );
              })}
            </Box>
          </Box>

          {g.blocking.length > 0 && (
            <Box component="section" aria-labelledby="gold-blocking-title">
              <Typography id="gold-blocking-title" variant="subtitle2" component="h4" sx={{ mb: 0.5 }}>
                Before the gold set can be frozen
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5, display: "grid", gap: 0.25 }}>
                {g.blocking.map((reason) => (
                  <Typography component="li" key={reason} sx={{ overflowWrap: "anywhere" }}>
                    {reason}
                  </Typography>
                ))}
              </Box>
            </Box>
          )}

          {(g.boxes_without_outline ?? 0) > 0 && (
            <Alert severity="info">
              {plural(g.boxes_without_outline ?? 0, "box", "boxes")} in the checked frames{" "}
              {g.boxes_without_outline === 1 ? "has" : "have"} no outline. Boxes without an outline are exported as
              rectangles.
            </Alert>
          )}

          {error && (
            <Alert severity="error" role="alert" onClose={() => setError(null)} sx={{ overflowWrap: "anywhere" }}>
              The gold set was not frozen: {error}
            </Alert>
          )}

          <Box>
            <Button
              variant="contained"
              startIcon={<LockOutlinedIcon />}
              disabled={!g.ready_to_freeze || freezing}
              aria-describedby={g.ready_to_freeze ? undefined : "gold-blocking-title"}
              onClick={() => setConfirming(true)}
            >
              Freeze gold set
            </Button>
          </Box>

          {confirming && (
            <Dialog
              open
              onClose={freezing ? undefined : () => setConfirming(false)}
              fullWidth
              maxWidth="xs"
              aria-labelledby="gold-freeze-title"
              aria-describedby="gold-freeze-text"
            >
              <DialogTitle id="gold-freeze-title">Freeze the gold set?</DialogTitle>
              <DialogContent>
                <Typography id="gold-freeze-text">
                  This cannot be undone. {formatCount(g.exemplar_count)} checked frames become exemplars and{" "}
                  {formatCount(g.holdout_count)} become the hold-out. After that nobody, and no job, can change
                  them.
                </Typography>
              </DialogContent>
              <DialogActions sx={{ px: 3, pb: 2 }}>
                <Button onClick={() => setConfirming(false)} disabled={freezing}>
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  disabled={freezing}
                  startIcon={freezing ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
                  onClick={() => void freeze()}
                >
                  {freezing ? "Freezing…" : "Freeze gold set"}
                </Button>
              </DialogActions>
            </Dialog>
          )}
        </>
      );
    }
  }

  return (
    <Card component="section" aria-labelledby="gold-title">
      <CardContent sx={{ display: "grid", gap: 2, p: { xs: 2, sm: 3 } }}>
        <StepTitle n={3} id="gold-title">
          Gold set
        </StepTitle>
        {body}
      </CardContent>
    </Card>
  );
}
