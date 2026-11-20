import { useEffect, useState, type FormEvent } from "react";
import { Alert, Box, Button, Card, CardContent, CircularProgress, TextField, Typography } from "@mui/material";
import { api, errorMessage, type Project, type PublicConfig } from "../api";
import { formatDate, humanise, plural } from "../format";
import type { Load } from "../hooks";

/** Retraining on a timer: the current setting, a way to change it, and why the last check did or did not run. */
export default function ScheduleCard({
  project,
  config,
  onSaved,
}: {
  project: Project;
  config: Load<PublicConfig>;
  onSaved: () => void;
}) {
  const current = project.retrain_interval_hours;
  const [hours, setHours] = useState(current !== null && current !== undefined ? String(current) : "");
  const [saving, setSaving] = useState<"save" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Follow the project when it changes underneath (another tab, or our own save).
  useEffect(() => {
    setHours(current !== null && current !== undefined ? String(current) : "");
  }, [current]);

  const schedule = config.status === "ready" ? config.data.schedule : null;
  const parsed = Number(hours);
  const valid = hours.trim() !== "" && Number.isFinite(parsed) && parsed > 0;

  const put = async (value: number | null) => {
    setSaving(value === null ? "off" : "save");
    setError(null);
    setSaved(null);
    try {
      await api.putSchedule(project.id, value);
      setSaved(value === null ? "The schedule is off." : `Saved: every ${plural(value, "hour", "hours")}.`);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) void put(parsed);
  };

  const tick = project.last_tick ?? null;

  return (
    <Card component="section" aria-labelledby="schedule-title">
      <CardContent sx={{ display: "grid", gap: 2, p: { xs: 2, sm: 3 } }}>
        <Box>
          <Typography id="schedule-title" variant="h5" component="h3">
            Retrain on a schedule
          </Typography>
          <Typography sx={{ fontWeight: 500 }}>
            {current === null || current === undefined
              ? "Off — versions are trained only when you start one"
              : `Every ${plural(current, "hour", "hours")}`}
          </Typography>
        </Box>

        <Typography color="text.secondary">
          {schedule
            ? `A scheduled run starts only when the interval has passed and at least ${plural(
                schedule.min_new_approved_images,
                "more frame has",
                "more frames have",
              )} passed the check or been checked by a person since the last dataset. Otherwise it is skipped. The schedule is looked at every ${plural(
                schedule.tick_minutes,
                "minute",
                "minutes",
              )}, and a scheduled version is promoted by the same rule as any other.`
            : config.status === "error"
              ? `A scheduled run starts only when the interval has passed and enough new frames have been checked since the last dataset. The exact numbers could not be loaded (${config.message}).`
              : "Loading the schedule rules…"}
        </Typography>

        <Box component="form" noValidate onSubmit={onSubmit} sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 1.5 }}>
          <TextField
            label="Hours between runs"
            type="number"
            value={hours}
            onChange={(e) => {
              setHours(e.target.value);
              setSaved(null);
            }}
            slotProps={{ htmlInput: { min: schedule?.min_interval_hours ?? 0, step: "any", inputMode: "decimal" } }}
            helperText={schedule ? `The shortest interval is ${plural(schedule.min_interval_hours, "hour", "hours")}.` : " "}
            sx={{ width: 220, maxWidth: "100%" }}
          />
          <Button
            type="submit"
            variant="contained"
            disabled={!valid || saving !== null || parsed === current}
            startIcon={saving === "save" ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
            sx={{ mt: "6px" }}
          >
            Save
          </Button>
          {current !== null && current !== undefined && (
            <Button
              variant="outlined"
              disabled={saving !== null}
              startIcon={saving === "off" ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
              onClick={() => void put(null)}
              sx={{ mt: "6px" }}
            >
              Turn off
            </Button>
          )}
        </Box>

        <Box aria-live="polite">
          {saved && <Alert severity="success">{saved}</Alert>}
          {error && (
            <Alert severity="error" role="alert" onClose={() => setError(null)} sx={{ overflowWrap: "anywhere" }}>
              The schedule was not changed: {error}
            </Alert>
          )}
        </Box>

        <Box>
          <Typography sx={{ overflowWrap: "anywhere" }}>
            <Box component="span" sx={{ color: "text.secondary" }}>
              Last retrain:{" "}
            </Box>
            {project.last_retrain_at ? (
              <time dateTime={project.last_retrain_at}>{formatDate(project.last_retrain_at)}</time>
            ) : (
              "never"
            )}
          </Typography>
          {tick && (
            <Typography sx={{ overflowWrap: "anywhere" }}>
              <Box component="span" sx={{ color: "text.secondary" }}>
                Last check{" "}
              </Box>
              {tick.at ? <time dateTime={tick.at}>{formatDate(tick.at)}</time> : "at an unrecorded time"}
              {tick.decision ? ` (${humanise(tick.decision).toLowerCase()})` : ""}
              {tick.reason ? `: ${tick.reason}` : ""}
            </Typography>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}
