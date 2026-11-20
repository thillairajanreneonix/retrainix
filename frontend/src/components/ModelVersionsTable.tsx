import { useState } from "react";
import { Alert, Box, Button, Card, Chip, CircularProgress, Typography, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { api, errorMessage, type ModelVersion, type WeightsFormat } from "../api";
import { formatCount, formatDate, formatShare, humanise, inClassOrder, readNumber } from "../format";
import { METRICS } from "./TrendChart";

const TRIGGER_WORDS: Record<string, string> = {
  seed: "starting weights",
  user: "started by you",
  schedule: "scheduled",
};
const STATUS_WORDS: Record<string, string> = {
  training: "Training",
  evaluating: "Scoring on the hold-out",
  ready: "Ready",
  failed: "Failed",
};

const share = (v: ModelVersion, key: string) => {
  const n = readNumber(v.metrics, key);
  return n !== null ? formatShare(n) : "—";
};
const num = (n: number | null | undefined, digits = 0) =>
  typeof n === "number" && Number.isFinite(n) ? (digits ? n.toFixed(digits) : formatCount(n)) : "—";

function Chips({ v, active }: { v: ModelVersion; active: boolean }) {
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
      {active && <Chip size="small" color="primary" label="Active" />}
      {v.promoted === true && <Chip size="small" color="success" variant="outlined" label="Promoted" />}
      {v.promoted === false && <Chip size="small" color="warning" variant="outlined" label="Not promoted" />}
    </Box>
  );
}

function Downloads({ pid, v }: { pid: string; v: ModelVersion }) {
  const [busy, setBusy] = useState<WeightsFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formats: { format: WeightsFormat; label: string }[] = [];
  if (v.weights?.pt) formats.push({ format: "pt", label: "PyTorch (.pt)" });
  if (v.weights?.onnx) formats.push({ format: "onnx", label: "ONNX" });
  if (formats.length === 0) return null;

  const download = async (format: WeightsFormat) => {
    setBusy(format);
    setError(null);
    try {
      const link = await api.getWeightsLink(pid, v.version, format);
      // The link is short-lived, so it is asked for at click time and followed straight away.
      const a = document.createElement("a");
      a.href = link.url;
      if (link.filename) a.download = link.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        {formats.map((f) => (
          <Button
            key={f.format}
            variant="outlined"
            size="small"
            disabled={busy !== null}
            startIcon={
              busy === f.format ? <CircularProgress size={16} color="inherit" aria-hidden /> : <FileDownloadOutlinedIcon />
            }
            aria-label={`Download version ${v.version} weights as ${f.label}`}
            onClick={() => void download(f.format)}
            sx={{ px: 1.75 }}
          >
            {f.label}
          </Button>
        ))}
      </Box>
      {error && (
        <Alert severity="error" role="alert" onClose={() => setError(null)} sx={{ mt: 1, overflowWrap: "anywhere" }}>
          The download did not start: {error}
        </Alert>
      )}
    </Box>
  );
}

function PerClassRecall({ v, classes }: { v: ModelVersion; classes: string[] }) {
  const [open, setOpen] = useState(false);
  const per = (v.metrics?.per_class_recall ?? {}) as Record<string, unknown>;
  const names = inClassOrder(Object.keys(per), classes);
  if (names.length === 0) return null;
  const id = `per-class-${v.version}`;
  return (
    <Box>
      <Button
        size="small"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        endIcon={<ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />}
        sx={{ px: 1.5 }}
      >
        Recall per class
      </Button>
      {open && (
        <Box
          id={id}
          component="table"
          sx={{
            mt: 0.5,
            borderCollapse: "collapse",
            "& th": { textAlign: "left", fontWeight: 500, color: "text.secondary" },
            "& th, & td": { py: 0.5, pr: 3, fontSize: 14 },
            "& tbody tr": { borderTop: "1px solid", borderColor: "divider" },
          }}
        >
          <caption style={{ position: "absolute", left: -9999 }}>Recall per class for version {v.version}</caption>
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">Recall</th>
              <th scope="col">n (objects)</th>
            </tr>
          </thead>
          <tbody>
            {names.map((name) => {
              const recall = readNumber(per[name], "recall");
              const n = readNumber(per[name], "n");
              return (
                <tr key={name}>
                  <td style={{ overflowWrap: "anywhere" }}>{name}</td>
                  <td>{recall !== null ? formatShare(recall) : "—"}</td>
                  <td>{n !== null ? formatCount(n) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </Box>
      )}
    </Box>
  );
}

/** The text under a version: its promotion note, how many frames stand behind it, and its extras. */
function Details({ pid, v, classes }: { pid: string; v: ModelVersion; classes: string[] }) {
  const nImages = readNumber(v.metrics, "n_images");
  const nObjects = readNumber(v.metrics, "n_objects_gold");
  return (
    <Box sx={{ display: "grid", gap: 1 }}>
      {v.promotion_note && <Typography sx={{ overflowWrap: "anywhere" }}>{v.promotion_note}</Typography>}
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
        {nImages !== null
          ? `Scored on the gold hold-out: n = ${formatCount(nImages)} images${nObjects !== null ? `, ${formatCount(nObjects)} objects` : ""}.`
          : "Not scored on the gold hold-out yet."}{" "}
        Created <time dateTime={v.created_at}>{formatDate(v.created_at)}</time>
        {v.parent ? ` · trained from ${v.parent === "seed" ? "the starting weights" : v.parent}` : ""}.
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 1.5 }}>
        <Downloads pid={pid} v={v} />
        <PerClassRecall v={v} classes={classes} />
      </Box>
    </Box>
  );
}

/**
 * Every model version, newest first, with the figures the chart plots. A table on a wide
 * screen; stacked cards at phone width. This is also the chart's text alternative.
 */
export default function ModelVersionsTable({
  pid,
  versions,
  activeVersion,
  classes,
}: {
  pid: string;
  versions: ModelVersion[]; // oldest first, as the API returns them
  activeVersion: number | null;
  classes: string[];
}) {
  const theme = useTheme();
  const stacked = useMediaQuery(theme.breakpoints.down("lg"));
  const rows = [...versions].sort((a, b) => b.version - a.version);

  if (stacked) {
    return (
      <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 1.5 }}>
        {rows.map((v) => (
          <Card component="li" key={v.version} sx={{ listStyle: "none" }}>
            <Box sx={{ p: 2, display: "grid", gap: 1.25 }}>
              <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }}>
                <Typography variant="h6" component="h4">
                  Version {v.version}
                </Typography>
                <Chips v={v} active={v.version === activeVersion} />
              </Box>
              <Box
                component="dl"
                sx={{
                  m: 0,
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  columnGap: 2,
                  rowGap: 0.75,
                  "& dt": { color: "text.secondary", fontSize: 13 },
                  "& dd": { m: 0, overflowWrap: "anywhere" },
                }}
              >
                {[
                  ["How it started", TRIGGER_WORDS[v.trigger] ?? humanise(v.trigger)],
                  ["Status", STATUS_WORDS[v.status] ?? humanise(v.status)],
                  ["Dataset", v.dataset_version !== null && v.dataset_version !== undefined ? `v${v.dataset_version}` : "—"],
                  ...METRICS.map((m) => [m.label, share(v, m.key)]),
                  ["Epochs", num(v.epochs_run)],
                  ["Training minutes", num(v.train_minutes, 1)],
                ].map(([k, val]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{val}</dd>
                  </div>
                ))}
              </Box>
              <Details pid={pid} v={v} classes={classes} />
            </Box>
          </Card>
        ))}
      </Box>
    );
  }

  return (
    <Card sx={{ overflowX: "auto" }}>
      <Box
        component="table"
        sx={{
          width: "100%",
          borderCollapse: "collapse",
          "& th": { textAlign: "left", fontWeight: 500, color: "text.secondary", fontSize: 14, whiteSpace: "nowrap" },
          "& th, & td": { px: 1.5, py: 1.25, verticalAlign: "top" },
          "& tbody tr.main": { borderTop: "1px solid", borderColor: "divider" },
          "& tbody tr.detail td": { pt: 0, pb: 2 },
          "& td.num": { fontVariantNumeric: "tabular-nums" },
        }}
      >
        <caption style={{ position: "absolute", left: -9999 }}>
          Model versions, newest first, with their scores on the gold hold-out
        </caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">How it started</th>
            <th scope="col">Dataset</th>
            <th scope="col">Status</th>
            {METRICS.map((m) => (
              <th scope="col" key={m.key}>
                {m.label}
              </th>
            ))}
            <th scope="col">Epochs</th>
            <th scope="col">Minutes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <VersionRows key={v.version} pid={pid} v={v} active={v.version === activeVersion} classes={classes} />
          ))}
        </tbody>
      </Box>
    </Card>
  );
}

function VersionRows({
  pid,
  v,
  active,
  classes,
}: {
  pid: string;
  v: ModelVersion;
  active: boolean;
  classes: string[];
}) {
  return (
    <>
      <tr className="main">
        <Box component="th" scope="row" sx={{ color: "text.primary !important" }}>
          <Box sx={{ display: "grid", gap: 0.5 }}>
            <Box component="span" sx={{ fontSize: 16 }}>
              v{v.version}
            </Box>
            <Chips v={v} active={active} />
          </Box>
        </Box>
        <td>{TRIGGER_WORDS[v.trigger] ?? humanise(v.trigger)}</td>
        <td>{v.dataset_version !== null && v.dataset_version !== undefined ? `v${v.dataset_version}` : "—"}</td>
        <td>{STATUS_WORDS[v.status] ?? humanise(v.status)}</td>
        {METRICS.map((m) => (
          <td className="num" key={m.key}>
            {share(v, m.key)}
          </td>
        ))}
        <td className="num">{num(v.epochs_run)}</td>
        <td className="num">{num(v.train_minutes, 1)}</td>
      </tr>
      <tr className="detail">
        <td colSpan={6 + METRICS.length}>
          <Details pid={pid} v={v} classes={classes} />
        </td>
      </tr>
    </>
  );
}
