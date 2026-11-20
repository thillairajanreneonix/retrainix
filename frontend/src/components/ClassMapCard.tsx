import { useState, type FormEvent } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { api, errorMessage, type ModelRecord, type Project } from "../api";
import { formatCount, plural } from "../format";
import type { Load } from "../hooks";
import { licenceText } from "./ModelCard";
import { ErrorRow, LoadingRow } from "./States";
import { StepTitle } from "./Step";
import { rx } from "../theme";

const IGNORED = ""; // select value for "this model class is dropped"

/** The model classes that currently land on a project class. */
function mappedClasses(model: ModelRecord, project: Project): string[] {
  return model.classes.filter((c) => project.classes.includes(project.class_map?.[c] ?? ""));
}

/**
 * Which model pre-labels, and how its own class names become the project's classes.
 * Read-only once frames are labelled (the API answers 409 to a change after that).
 */
export default function ClassMapCard({
  project,
  models,
  onRetryModels,
  onSaved,
  step,
}: {
  project: Project;
  models: Load<ModelRecord[]>;
  onRetryModels: () => void;
  onSaved: () => void;
  /** Its number on Annotation QA; left out on Project setup, where it is not one of a row of steps. */
  step?: number;
}) {
  const [open, setOpen] = useState(false);
  const locked = (project.counts?.predicted ?? 0) > 0;
  const model = models.status === "ready" ? (models.data.find((m) => m.id === project.prelabel_recipe) ?? null) : null;

  let body;
  if (models.status === "loading") {
    body = <LoadingRow label="Loading the model catalogue…" />;
  } else if (models.status === "error") {
    body = <ErrorRow what="The model catalogue could not be loaded" message={models.message} onRetry={onRetryModels} />;
  } else if (!model) {
    body = (
      <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
        This project pre-labels with “{project.prelabel_recipe}”, which is not in the model catalogue, so its
        classes cannot be shown.
      </Alert>
    );
  } else {
    const total = model.classes.length;
    const mapped = mappedClasses(model, project);
    const perProjectClass = project.classes.map(
      (pc) => [pc, model.classes.filter((mc) => project.class_map?.[mc] === pc).length] as const,
    );

    body = (
      <>
        <Typography sx={{ overflowWrap: "anywhere" }}>
          <Box component="span" sx={{ color: "text.secondary" }}>
            Pre-labelling model:{" "}
          </Box>
          <Box component="span" sx={{ fontWeight: 500 }}>
            {model.name}
          </Box>{" "}
          · licence {licenceText(model)}
        </Typography>

        {total === 0 ? (
          <Alert severity="warning">
            The catalogue lists no class names for this model, so there is nothing to map.
          </Alert>
        ) : (
          <>
            <Typography>
              {mapped.length === total
                ? `All ${formatCount(total)} model classes are mapped to your classes.`
                : `${formatCount(mapped.length)} of ${plural(total, "model class", "model classes")} ${
                    mapped.length === 1 ? "is" : "are"
                  } mapped to your classes; the rest are ignored.`}
            </Typography>

            {mapped.length === 0 && (
              <Alert severity="warning">
                No model class is mapped, so labelling would keep no objects. Review the mapping before you add a
                video.
              </Alert>
            )}

            <Box component="ul" aria-label="Model classes mapped to each of your classes" sx={{ listStyle: "none", p: 0, m: 0, display: "flex", flexWrap: "wrap", gap: 1 }}>
              {perProjectClass.map(([pc, n]) => (
                <li key={pc}>
                  <Chip
                    variant="outlined"
                    color={n === 0 ? "warning" : "default"}
                    label={`${pc}: ${plural(n, "model class", "model classes")}`}
                    sx={{ maxWidth: "100%" }}
                  />
                </li>
              ))}
            </Box>

            {project.class_map_source === "name_match" && !locked && (
              <Alert severity="info">
                This mapping was filled in automatically by matching class names. Check it before you add the first
                video: frames are labelled as soon as they are ready, and the mapping cannot be changed after that.
              </Alert>
            )}
          </>
        )}

        {locked && (
          <Typography id="class-map-locked" color="text.secondary">
            Frames are already labelled with this mapping, so it can no longer be changed.
          </Typography>
        )}

        {total > 0 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5 }}>
            <Button variant="outlined" disabled={locked} aria-describedby={locked ? "class-map-locked" : undefined} onClick={() => setOpen(true)}>
              Review mapping
            </Button>
            {locked && <Button onClick={() => setOpen(true)}>View mapping</Button>}
          </Box>
        )}

        {open && (
          <ClassMapDialog
            project={project}
            model={model}
            readOnly={locked}
            onClose={() => setOpen(false)}
            onSaved={() => {
              setOpen(false);
              onSaved();
            }}
          />
        )}
      </>
    );
  }

  return (
    <Card component="section" aria-labelledby="class-map-title">
      <CardContent sx={{ display: "grid", gap: 1.5, p: { xs: 2, sm: 3 } }}>
        <Box>
          {step !== undefined ? (
            <StepTitle n={step} id="class-map-title">
              Class mapping
            </StepTitle>
          ) : (
            <Typography id="class-map-title" variant="h5" component="h3">
              Class mapping
            </Typography>
          )}
          <Typography color="text.secondary">
            The model has its own class names. Each one either becomes one of your classes or is ignored.
          </Typography>
        </Box>
        {body}
      </CardContent>
    </Card>
  );
}

function ClassMapDialog({
  project,
  model,
  readOnly,
  onClose,
  onSaved,
}: {
  project: Project;
  model: ModelRecord;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"));

  // Draft: model class -> project class, or IGNORED.
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      model.classes.map((mc) => {
        const target = project.class_map?.[mc] ?? IGNORED;
        return [mc, project.classes.includes(target) ? target : IGNORED];
      }),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mappedCount = model.classes.filter((mc) => draft[mc] !== IGNORED).length;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    setSaving(true);
    setError(null);
    const classMap: Record<string, string> = {};
    for (const mc of model.classes) {
      if (draft[mc] !== IGNORED) classMap[mc] = draft[mc];
    }
    try {
      await api.putClassMap(project.id, classMap);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={saving ? undefined : onClose}
      fullScreen={phone}
      fullWidth
      maxWidth="sm"
      scroll="paper"
      aria-labelledby="class-map-dialog-title"
    >
      <Box component="form" onSubmit={save} sx={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
        <DialogTitle id="class-map-dialog-title">
          {readOnly ? "Class mapping" : "Review class mapping"}
          <Typography color="text.secondary" variant="body2" aria-live="polite">
            {model.name}: {formatCount(mappedCount)} of {plural(model.classes.length, "class", "classes")} mapped
          </Typography>
        </DialogTitle>

        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
          {readOnly && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Frames are already labelled with this mapping, so it can no longer be changed.
            </Alert>
          )}
          <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 1 }}>
            {model.classes.map((mc, i) => {
              const id = `class-map-select-${i}`;
              return (
                <Box
                  component="li"
                  key={mc}
                  sx={{
                    display: "grid",
                    gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "minmax(0, 1fr) 200px" },
                    alignItems: "center",
                    columnGap: 2,
                    rowGap: 0.5,
                  }}
                >
                  <Typography component="label" htmlFor={id} sx={{ overflowWrap: "anywhere" }}>
                    {mc}
                  </Typography>
                  <Box
                    component="select"
                    id={id}
                    value={draft[mc]}
                    disabled={readOnly || saving}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      setDraft((prev) => ({ ...prev, [mc]: e.target.value }))
                    }
                    sx={{
                      font: "inherit",
                      minHeight: 44,
                      width: "100%",
                      px: 1.5,
                      borderRadius: "12px",
                      border: "1px solid",
                      borderColor: draft[mc] === IGNORED ? rx.borderStrong : rx.accentInk,
                      bgcolor: "background.paper",
                      color: draft[mc] === IGNORED ? "text.secondary" : "text.primary",
                      "&:focus-visible": { outline: "2px solid", outlineColor: "primary.dark", outlineOffset: 1 },
                    }}
                  >
                    <option value={IGNORED}>Ignored</option>
                    {project.classes.map((pc) => (
                      <option key={pc} value={pc}>
                        {pc}
                      </option>
                    ))}
                  </Box>
                </Box>
              );
            })}
          </Box>
        </DialogContent>

        {error && (
          <Alert severity="error" role="alert" sx={{ mx: { xs: 2, sm: 3 }, mt: 2, overflowWrap: "anywhere" }}>
            The mapping was not saved: {error}
          </Alert>
        )}

        <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
          <Button onClick={onClose} disabled={saving}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              type="submit"
              variant="contained"
              disabled={saving}
              startIcon={saving ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
            >
              {saving ? "Saving…" : "Save mapping"}
            </Button>
          )}
        </DialogActions>
      </Box>
    </Dialog>
  );
}
