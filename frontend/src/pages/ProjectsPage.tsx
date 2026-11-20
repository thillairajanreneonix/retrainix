import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import { api, errorMessage, type ModelRecord, type Project } from "../api";
import { formatDate, humanise, plural } from "../format";
import { useLoad } from "../hooks";
import ModelCard, { licenceText } from "../components/ModelCard";
import { EmptyState, ErrorRow, LoadingRow } from "../components/States";

export default function ProjectsPage() {
  const [projects, reloadProjects] = useLoad(() => api.listProjects(), []);
  const [formOpen, setFormOpen] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  const noProjects = projects.status === "ready" && projects.data.length === 0;
  const showForm = formOpen || noProjects;

  const openForm = () => {
    setFormOpen(true);
    // Wait for the form to render, then bring it into view and focus its first field.
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      formRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
  };

  return (
    <Stack spacing={3}>
      <Stack direction="row" useFlexGap spacing={2} sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", rowGap: 1 }}>
        <Box>
          <Typography variant="h4" component="h2">
            Projects
          </Typography>
          <Typography color="text.secondary">
            One project is one belt: its classes, its footage and the model retrained on it.
          </Typography>
        </Box>
        {!showForm && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={openForm}>
            New project
          </Button>
        )}
      </Stack>

      <section aria-label="Your projects">
        {projects.status === "loading" && <LoadingRow label="Loading projects…" />}
        {projects.status === "error" && (
          <ErrorRow what="The project list could not be loaded" message={projects.message} onRetry={reloadProjects} />
        )}
        {noProjects && (
          <EmptyState icon={<FolderOpenOutlinedIcon fontSize="large" />} title="No projects yet">
            Projects you create appear here with their classes, state and frame count. Fill in the form below to
            create the first one.
          </EmptyState>
        )}
        {projects.status === "ready" && projects.data.length > 0 && (
          <Box
            component="ul"
            sx={{
              listStyle: "none",
              p: 0,
              m: 0,
              display: "grid",
              gap: 2,
              gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "repeat(auto-fill, minmax(300px, 1fr))" },
            }}
          >
            {projects.data.map((p) => (
              <li key={p.id}>
                <ProjectCard project={p} />
              </li>
            ))}
          </Box>
        )}
      </section>

      {showForm && (
        <div ref={formRef}>
          <NewProjectForm onCancel={noProjects ? undefined : () => setFormOpen(false)} />
        </div>
      )}
    </Stack>
  );
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardActionArea
        component={RouterLink}
        to={`/projects/${encodeURIComponent(project.id)}`}
        sx={{ height: "100%", display: "block" }}
      >
        <CardContent sx={{ display: "grid", gap: 1.5 }}>
          <Stack direction="row" useFlexGap spacing={1} sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
            <Typography variant="h6" component="h3" sx={{ overflowWrap: "anywhere", minWidth: 0 }}>
              {project.name}
            </Typography>
            <Chip size="small" label={humanise(project.state)} sx={{ flexShrink: 0 }} />
          </Stack>
          <Box component="ul" aria-label="Classes" sx={{ listStyle: "none", p: 0, m: 0, display: "flex", flexWrap: "wrap", gap: 0.75 }}>
            {project.classes.map((c) => (
              <li key={c}>
                <Chip size="small" variant="outlined" label={c} sx={{ maxWidth: "100%" }} />
              </li>
            ))}
          </Box>
          <Typography variant="body2" color="text.secondary">
            {plural(project.counts.frames, "frame", "frames")} · created{" "}
            <time dateTime={project.created_at}>{formatDate(project.created_at)}</time>
          </Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

/** Lower-cases, trims and de-duplicates class names typed as free text (comma or Enter separated). */
function addClasses(existing: string[], raw: string): string[] {
  const next = [...existing];
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase().replace(/\s+/g, " ");
    if (name && !next.includes(name)) next.push(name);
  }
  return next;
}

function NewProjectForm({ onCancel }: { onCancel?: () => void }) {
  const navigate = useNavigate();
  const [models, reloadModels] = useLoad(() => api.listModels(), []);

  const [name, setName] = useState("");
  const [classes, setClasses] = useState<string[]>([]);
  const [classDraft, setClassDraft] = useState("");
  const [prelabelId, setPrelabelId] = useState("");
  const [trainId, setTrainId] = useState("");
  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const all: ModelRecord[] = models.status === "ready" ? models.data : [];
  const prelabelModels = all.filter((m) => m.can_prelabel);
  const trainModels = all.filter((m) => m.can_train);

  // When the catalogue offers exactly one choice, it is the choice.
  useEffect(() => {
    if (models.status !== "ready") return;
    const pre = models.data.filter((m) => m.can_prelabel);
    const train = models.data.filter((m) => m.can_train);
    if (pre.length === 1) setPrelabelId((cur) => cur || pre[0].id);
    if (train.length === 1) setTrainId((cur) => cur || train[0].id);
  }, [models]);

  const prelabelModel = prelabelModels.find((m) => m.id === prelabelId) ?? null;
  const trainModel = trainModels.find((m) => m.id === trainId) ?? null;
  // One model that does both jobs: there is nothing to choose, so it is shown, not offered.
  const onlyModel =
    prelabelModels.length === 1 && trainModels.length === 1 && prelabelModels[0].id === trainModels[0].id
      ? prelabelModels[0]
      : null;

  const pendingClasses = addClasses(classes, classDraft);
  const nameError = tried && !name.trim() ? "Give the project a name." : "";
  const classesError = tried && pendingClasses.length === 0 ? "Add at least one class." : "";
  const prelabelError = tried && !prelabelModel ? "Choose the model that pre-labels the frames." : "";
  const trainError = tried && !trainModel ? "Choose the model to train." : "";

  const commitDraft = () => {
    setClasses(pendingClasses);
    setClassDraft("");
  };

  const onClassKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraft();
    } else if (e.key === "Backspace" && !classDraft && classes.length > 0) {
      setClasses(classes.slice(0, -1));
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    setSubmitError(null);
    commitDraft();
    if (!name.trim() || pendingClasses.length === 0 || !prelabelModel || !trainModel) return;

    setSubmitting(true);
    try {
      const project = await api.createProject({
        name: name.trim(),
        classes: pendingClasses,
        recipe: trainModel.id,
        prelabel_recipe: prelabelModel.id,
        class_map: {},
      });
      navigate(`/projects/${encodeURIComponent(project.id)}`);
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  };

  const modelsBusy = models.status === "loading";
  const selectHelper = (error: string, count: number, none: string) => {
    if (modelsBusy) return "Loading the model catalogue…";
    if (models.status === "ready" && count === 0) return none;
    return error || " ";
  };

  return (
    <Card component="section" aria-labelledby="new-project-title">
      <CardContent component="form" noValidate onSubmit={onSubmit} sx={{ display: "grid", gap: 2.5, p: { xs: 2, sm: 3 } }}>
        <Box>
          <Typography id="new-project-title" variant="h5" component="h3">
            New project
          </Typography>
          <Typography color="text.secondary">
            Classes are fixed once the project is created; their order is the class index in every export.
          </Typography>
        </Box>

        <TextField
          label="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          fullWidth
          autoComplete="off"
          error={Boolean(nameError)}
          helperText={nameError || " "}
        />

        <Box>
          <Stack direction="row" useFlexGap spacing={1} sx={{ alignItems: "flex-start" }}>
            <TextField
              label="Classes"
              value={classDraft}
              onChange={(e) => setClassDraft(e.target.value)}
              onKeyDown={onClassKeyDown}
              fullWidth
              autoComplete="off"
              autoCapitalize="none"
              error={Boolean(classesError)}
              helperText={classesError || "Type a class name and press Enter. Names are lower-cased; duplicates are ignored."}
              sx={{ minWidth: 0 }}
            />
            <Button
              variant="outlined"
              onClick={commitDraft}
              disabled={!classDraft.trim()}
              sx={{ mt: "6px", flexShrink: 0, px: 2 }}
            >
              Add
            </Button>
          </Stack>
          <Box
            component="ul"
            aria-label="Classes added"
            aria-live="polite"
            sx={{ listStyle: "none", p: 0, m: 0, mt: 1, display: "flex", flexWrap: "wrap", gap: 1 }}
          >
            {classes.length === 0 ? (
              <Typography component="li" variant="body2" color="text.secondary">
                No classes added yet.
              </Typography>
            ) : (
              classes.map((c) => (
                <li key={c}>
                  <Chip
                    label={c}
                    onDelete={() => setClasses(classes.filter((x) => x !== c))}
                    aria-label={`${c}, press Delete or Backspace to remove`}
                    sx={{
                      height: 44,
                      borderRadius: "22px",
                      maxWidth: "100%",
                      "& .MuiChip-deleteIcon": { fontSize: 24, p: "10px", m: 0, boxSizing: "content-box" },
                    }}
                  />
                </li>
              ))
            )}
          </Box>
        </Box>

        {models.status === "error" && (
          <ErrorRow what="The model catalogue could not be loaded" message={models.message} onRetry={reloadModels} />
        )}

        {onlyModel ? (
          <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, alignItems: "start" }}>
            <Stack spacing={1} sx={{ minWidth: 0 }}>
              <Typography color="text.secondary">
                There is one model. It pre-labels the frames and is then trained on your data.
              </Typography>
              <ModelCard model={onlyModel} role="Model for this project" />
            </Stack>
          </Box>
        ) : (
          <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, alignItems: "start" }}>
            <Stack spacing={1} sx={{ minWidth: 0 }}>
              {/* A chooser with a single option is not shown; that model's card stands in for it. */}
              {prelabelModels.length !== 1 && (
                <TextField
                  select
                  label="Model to pre-label with"
                  value={prelabelModel ? prelabelId : ""}
                  onChange={(e) => setPrelabelId(e.target.value)}
                  required
                  fullWidth
                  disabled={prelabelModels.length === 0}
                  error={Boolean(prelabelError) && !modelsBusy}
                  helperText={selectHelper(prelabelError, prelabelModels.length, "No model in the catalogue can pre-label yet.")}
                >
                  {prelabelModels.map((m) => (
                    <MenuItem key={m.id} value={m.id} sx={{ minHeight: 44, whiteSpace: "normal" }}>
                      {m.name} · licence {licenceText(m)}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              {prelabelModel && <ModelCard model={prelabelModel} role="Pre-labels the frames" />}
            </Stack>

            <Stack spacing={1} sx={{ minWidth: 0 }}>
              {trainModels.length !== 1 && (
                <TextField
                  select
                  label="Model to train"
                  value={trainModel ? trainId : ""}
                  onChange={(e) => setTrainId(e.target.value)}
                  required
                  fullWidth
                  disabled={trainModels.length === 0}
                  error={Boolean(trainError) && !modelsBusy}
                  helperText={selectHelper(trainError, trainModels.length, "No model in the catalogue can be trained yet.")}
                >
                  {trainModels.map((m) => (
                    <MenuItem key={m.id} value={m.id} sx={{ minHeight: 44, whiteSpace: "normal" }}>
                      {m.name} · licence {licenceText(m)}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              {trainModel && <ModelCard model={trainModel} role="Is trained on your data" />}
            </Stack>
          </Box>
        )}

        {submitError && (
          <Alert severity="error" role="alert">
            The project was not created: {submitError}
          </Alert>
        )}

        <Stack direction="row" useFlexGap spacing={1.5} sx={{ flexWrap: "wrap", rowGap: 1.5, alignItems: "center" }}>
          <Button
            type="submit"
            variant="contained"
            disabled={submitting}
            startIcon={submitting ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
          >
            {submitting ? "Creating…" : "Create project"}
          </Button>
          {onCancel && (
            <Button onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
