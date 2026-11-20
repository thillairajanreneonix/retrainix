import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Switch,
  ToggleButton,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import AddBoxOutlinedIcon from "@mui/icons-material/AddBoxOutlined";
import CheckIcon from "@mui/icons-material/Check";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import {
  api,
  errorMessage,
  type Image,
  type LabelSource,
  type MasterLabel,
  type Project,
  type ReviewBody,
  type Verdict,
} from "../api";
import { formatCount, formatTimestamp, plural } from "../format";
import { useLoad } from "../hooks";
import { ErrorRow, LoadingRow } from "./States";

const DETAIL_WIDTH = 1280;
const MIN_BOX = 4; // image pixels, each side

// One colour per project class, by its index in project.classes, cycling after eight.
// Okabe-Ito colour-blind-safe hues, with a light grey in place of black (the belt is black).
const CLASS_COLOURS = ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#DDDDDD"];
const UNKNOWN_COLOUR = "#FFFFFF"; // a class that is not in project.classes

function colourFor(classes: string[], name: string): string {
  const i = classes.indexOf(name);
  return i >= 0 ? CLASS_COLOURS[i % CLASS_COLOURS.length] : UNKNOWN_COLOUR;
}

type Box4 = [number, number, number, number];

/** One object as the reviewer currently has it. `id: null` = drawn here, not saved yet. */
type Draft = {
  key: string;
  id: string | null;
  class: string;
  bbox: Box4;
  polygon: [number, number][] | null;
  score: number | null;
  source: LabelSource;
  classSource?: "gemini";
  classBefore?: string;
};

function draftsFrom(label: MasterLabel): Draft[] {
  return label.objects.map((o, i) => ({
    key: o.id ? `saved:${o.id}` : `saved#${i}`,
    id: o.id ?? null,
    class: o.class,
    bbox: o.bbox_xyxy,
    polygon: o.polygon_xy && o.polygon_xy.length >= 3 ? o.polygon_xy : null,
    score: typeof o.score === "number" ? o.score : null,
    source: o.source,
    classSource: o.class_source,
    classBefore: o.model_class_before,
  }));
}

/** Existing boxes cannot be moved here, so a change is a new class, a deletion or a new box. */
function differs(drafts: Draft[], label: MasterLabel): boolean {
  if (drafts.length !== label.objects.length) return true;
  return drafts.some((d, i) => d.id === null || d.id !== label.objects[i].id || d.class !== label.objects[i].class);
}

function Swatch({ colour }: { colour: string }) {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        display: "inline-block",
        flexShrink: 0,
        width: 16,
        height: 16,
        borderRadius: "4px",
        bgcolor: colour,
        border: "1px solid rgba(0,0,0,0.7)",
      }}
    />
  );
}

const selectSx = {
  font: "inherit",
  minHeight: 44,
  minWidth: 0,
  px: 1,
  borderRadius: "12px",
  border: "1px solid rgba(0,0,0,0.3)",
  bgcolor: "background.paper",
  color: "text.primary",
  "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 1 },
} as const;

function Shape({
  draft,
  colour,
  selected,
  onSelect,
}: {
  draft: Draft;
  colour: string;
  selected: boolean;
  onSelect?: () => void;
}) {
  const common = { vectorEffect: "non-scaling-stroke" as const, strokeLinejoin: "round" as const };
  const halo = {
    ...common,
    fill: "none",
    stroke: "#000000",
    strokeOpacity: 0.65,
    strokeWidth: selected ? 8 : 4,
    pointerEvents: "none" as const,
  };
  const line = {
    ...common,
    fill: colour,
    fillOpacity: selected ? 0.38 : 0.2,
    stroke: colour,
    strokeWidth: selected ? 5 : 2,
    strokeDasharray: draft.id === null ? "8 5" : undefined, // dashed = drawn here, not saved yet
  };
  const [x1, y1, x2, y2] = draft.bbox;
  const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  const points = draft.polygon?.map(([x, y]) => `${x},${y}`).join(" ");

  return (
    <g onClick={onSelect} style={{ cursor: onSelect ? "pointer" : undefined }}>
      {points ? <polygon points={points} {...halo} /> : <rect {...box} {...halo} />}
      {points ? <polygon points={points} {...line} /> : <rect {...box} {...line} />}
    </g>
  );
}

/** The latest Gemini verdict for this frame, when there is one. */
function VerdictBlock({ verdict, drafts }: { verdict: Verdict; drafts: Draft[] }) {
  const fixes = verdict.hints?.class_fixes ?? [];
  const byId = new Map(drafts.filter((d) => d.id).map((d) => [d.id as string, d]));
  return (
    <Box component="section" aria-labelledby="frame-verdict-title" sx={{ display: "grid", gap: 0.75, minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
        <Typography id="frame-verdict-title" variant="subtitle2" component="h3">
          Gemini's verdict
        </Typography>
        <Chip
          size="small"
          color={verdict.verdict === "pass" ? "success" : "error"}
          label={verdict.verdict === "pass" ? "Pass" : "Fail"}
        />
        <Typography variant="body2" color="text.secondary">
          round {verdict.round}
        </Typography>
      </Box>
      {verdict.reason && (
        <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
          {verdict.reason}
        </Typography>
      )}
      <Typography variant="body2">Missed objects: {formatCount(verdict.missed_objects ?? 0)}</Typography>
      {fixes.length > 0 && (
        <Box>
          <Typography variant="body2" color="text.secondary">
            Class fixes it proposed
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {fixes.map((f, i) => {
              const d = byId.get(f.object_id);
              const before = d ? (d.classBefore ?? (d.class !== f.class ? d.class : null)) : null;
              return (
                <Typography component="li" variant="body2" key={`${f.object_id}-${i}`} sx={{ overflowWrap: "anywhere" }}>
                  {f.object_id}: {before ? `${before} → ` : "→ "}
                  {f.class}
                  {f.confidence ? ` (${f.confidence})` : ""}
                </Typography>
              );
            })}
          </Box>
        </Box>
      )}
      {(verdict.bad_masks?.length ?? 0) > 0 && (
        <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
          Outlines it flagged: {verdict.bad_masks.join(", ")}
        </Typography>
      )}
    </Box>
  );
}

type Action = "accept" | "fix" | "reject";

/**
 * Large view of one frame for review: the image with its label drawn over it, and the tools to
 * accept it, correct it (change a class, delete an object, draw a missing box) or reject it.
 * Gold frames are read-only. Prev / next walk the frames loaded in the grid.
 */
export default function FrameReviewDialog({
  project,
  images,
  index,
  onIndexChange,
  onClose,
  onReviewed,
}: {
  project: Project;
  images: Image[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onReviewed: (image: Image) => void;
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("md"));
  const pid = project.id;
  const image = images[index];
  const classes = project.classes;

  const [detail, reloadDetail] = useLoad(() => api.getImageDetail(pid, image.id), [pid, image.id]);
  // The answer on screen can lag one render behind the frame; only use it when it is this frame's.
  const current = detail.status === "ready" && detail.data.image.id === image.id ? detail.data : null;
  const label = current?.label ?? null;

  const [draftState, setDraftState] = useState<{ imageId: string; objects: Draft[] } | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [addMode, setAddMode] = useState(false);
  const [addClass, setAddClass] = useState(classes[0] ?? "");
  const [drawing, setDrawing] = useState<Box4 | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  const [brokenImage, setBrokenImage] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const newCount = useRef(0);

  // A fresh label (another frame, or this one re-read after a save) replaces the working copy.
  useEffect(() => {
    if (!current) return;
    setDraftState(current.label ? { imageId: current.image.id, objects: draftsFrom(current.label) } : null);
    setSelectedKey(null);
    setDrawing(null);
    setAddMode(false);
    setActionError(null);
  }, [current]);

  const drafts = draftState && draftState.imageId === image.id ? draftState.objects : null;
  const status = current?.image.label_status ?? image.label_status;
  const role = current?.image.role ?? image.role;
  const isGold = status === "gold" || role === "gold_exemplar" || role === "gold_holdout";
  const editable = !!label && !!drafts && !isGold;
  const dirty = !!label && !!drafts && !isGold && differs(drafts, label);

  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;

  const setDrafts = (next: Draft[]) => {
    setDraftState({ imageId: image.id, objects: next });
    setFlash(null);
  };

  /** Runs `then` now, or after the reviewer agrees to throw away unsaved corrections. */
  const guard = (then: () => void) => {
    if (dirty) setPendingDiscard(() => then);
    else then();
  };
  const go = (delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= images.length) return;
    guard(() => {
      setFlash(null);
      onIndexChange(target);
    });
  };
  const close = () => guard(onClose);

  const select = (key: string, scroll: boolean) => {
    setSelectedKey(key);
    if (scroll) rowRefs.current.get(key)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const remove = (key: string) => {
    if (!drafts) return;
    setDrafts(drafts.filter((d) => d.key !== key));
    if (selectedKey === key) setSelectedKey(null);
  };
  const toggleAdd = () => {
    setAddMode((on) => !on);
    setShowOverlay(true);
    setDrawing(null);
  };

  const act = async (action: Action) => {
    if (!editable || !drafts || busy) return;
    const body: ReviewBody =
      action === "fix"
        ? { action, objects: drafts.map((d) => ({ id: d.id, class: d.class, bbox_xyxy: d.bbox })) }
        : { action, objects: [] };
    setBusy(action);
    setActionError(null);
    setFlash(null);
    try {
      const res = await api.reviewImage(pid, image.id, body);
      onReviewed(res.image);
      const done =
        action === "accept" ? "Frame accepted." : action === "fix" ? "Corrections saved." : "Frame rejected.";
      if (hasNext) {
        setFlash(`${done} Showing the next frame.`);
        onIndexChange(index + 1);
      } else {
        setFlash(`${done} This was the last frame loaded.`);
        reloadDetail();
      }
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // ---- drawing a new box: pointer position -> image pixels through the SVG's own transform ----
  const toImage = (e: ReactPointerEvent): [number, number] | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm || !label) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [Math.min(Math.max(p.x, 0), label.width), Math.min(Math.max(p.y, 0), label.height)];
  };
  const onDrawStart = (e: ReactPointerEvent<SVGRectElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const p = toImage(e);
    if (!p) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrawing([p[0], p[1], p[0], p[1]]);
  };
  const onDrawMove = (e: ReactPointerEvent<SVGRectElement>) => {
    if (!drawing) return;
    const p = toImage(e);
    if (p) setDrawing([drawing[0], drawing[1], p[0], p[1]]);
  };
  const onDrawEnd = (e: ReactPointerEvent<SVGRectElement>) => {
    if (!drawing || !drafts) return;
    const p = toImage(e) ?? [drawing[2], drawing[3]];
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const box: Box4 = [
      round1(Math.min(drawing[0], p[0])),
      round1(Math.min(drawing[1], p[1])),
      round1(Math.max(drawing[0], p[0])),
      round1(Math.max(drawing[1], p[1])),
    ];
    setDrawing(null);
    if (box[2] - box[0] < MIN_BOX || box[3] - box[1] < MIN_BOX || !addClass) return;
    const key = `new:${++newCount.current}`;
    setDrafts([...drafts, { key, id: null, class: addClass, bbox: box, polygon: null, score: null, source: "human" }]);
    setSelectedKey(key);
  };

  // ---- keyboard shortcuts (always the latest handler, registered once) ----
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (busy || confirmReject || pendingDiscard) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    if (key === "ArrowRight" || key === "n") go(1);
    else if (key === "ArrowLeft" || key === "p") go(-1);
    else if (key === "a" && editable && !dirty) void act("accept");
    else if (key === "s" && editable && dirty) void act("fix");
    else if (key === "b" && editable) toggleAdd();
    else if (key === "Delete" && editable && selectedKey) remove(selectedKey);
    else handled = false;
    if (handled) e.preventDefault();
  };
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const at =
    image.timestamp_s !== null && image.timestamp_s !== undefined ? formatTimestamp(image.timestamp_s) : null;
  const title = at ? `Frame at ${at}` : `Frame ${image.id}`;
  const width = image.width || label?.width || 16;
  const height = image.height || label?.height || 10;

  const shown = drafts ?? [];
  const counts = new Map<string, number>();
  for (const d of shown) counts.set(d.class, (counts.get(d.class) ?? 0) + 1);
  const legend = [...classes, ...[...counts.keys()].filter((c) => !classes.includes(c)).sort()];

  const geminiVerdict = current ? ([...current.verdicts].reverse().find((v) => v.stage === "gemini") ?? null) : null;
  const objectName = (d: Draft, i: number) => d.id ?? `new box ${i + 1}`;

  return (
    <Dialog open onClose={close} fullScreen={phone} fullWidth maxWidth="xl" aria-labelledby="frame-detail-title">
      <DialogTitle
        component="div"
        id="frame-detail-header" // not the dialog's label id: the label is the <h2> inside
        sx={{ display: "flex", alignItems: "center", gap: 1, py: 1, pl: { xs: 2, sm: 3 }, pr: 1 }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id="frame-detail-title" variant="h6" component="h2" sx={{ overflowWrap: "anywhere" }}>
            {title}
          </Typography>
          <Typography variant="body2" color="text.secondary" aria-live="polite">
            {formatCount(index + 1)} of {formatCount(images.length)} loaded
          </Typography>
        </Box>
        <IconButton size="large" aria-label="Close" onClick={close}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Box
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1fr) 380px" },
            alignItems: "start",
          }}
        >
          <Box sx={{ minWidth: 0, position: { md: "sticky" }, top: 0 }}>
            <Box
              sx={{
                position: "relative",
                width: "100%",
                // On a wide screen, never taller than the dialog: cap the width by the frame's own shape.
                maxWidth: { md: `calc((100vh - 230px) * ${width / height})` },
                mx: "auto",
                aspectRatio: `${width} / ${height}`,
                bgcolor: "#16181a",
                borderRadius: "12px",
                overflow: "hidden",
                lineHeight: 0,
              }}
            >
              {brokenImage === image.id ? (
                <Box sx={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", p: 2, lineHeight: 1.5 }}>
                  <Alert severity="error">The image could not be loaded.</Alert>
                </Box>
              ) : (
                <img
                  key={image.id}
                  src={api.imageFileUrl(pid, image.id, DETAIL_WIDTH)}
                  alt={`${title}${drafts ? `, ${plural(drafts.length, "labelled object", "labelled objects")}` : ""}`}
                  onError={() => setBrokenImage(image.id)}
                  draggable={false}
                  style={{ display: "block", width: "100%", height: "100%", userSelect: "none" }}
                />
              )}
              {label && drafts && brokenImage !== image.id && (
                <svg
                  ref={svgRef}
                  viewBox={`0 0 ${label.width} ${label.height}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`${plural(drafts.length, "labelled object", "labelled objects")} drawn over the frame; they are listed beside it`}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    touchAction: addMode ? "none" : "auto",
                    cursor: addMode ? "crosshair" : "default",
                  }}
                >
                  {showOverlay &&
                    // the selected object is drawn last so it sits on top
                    [...drafts]
                      .sort((a, b) => Number(a.key === selectedKey) - Number(b.key === selectedKey))
                      .map((d) => (
                        <Shape
                          key={d.key}
                          draft={d}
                          colour={colourFor(classes, d.class)}
                          selected={d.key === selectedKey}
                          onSelect={addMode ? undefined : () => select(d.key, true)}
                        />
                      ))}
                  {addMode && (
                    <rect
                      x={0}
                      y={0}
                      width={label.width}
                      height={label.height}
                      fill="transparent"
                      onPointerDown={onDrawStart}
                      onPointerMove={onDrawMove}
                      onPointerUp={onDrawEnd}
                      onPointerCancel={() => setDrawing(null)}
                    />
                  )}
                  {drawing && (
                    <g pointerEvents="none">
                      {[
                        { stroke: "#000000", strokeWidth: 4, strokeOpacity: 0.65 },
                        { stroke: colourFor(classes, addClass), strokeWidth: 2, strokeDasharray: "8 5" },
                      ].map((style, i) => (
                        <rect
                          key={i}
                          x={Math.min(drawing[0], drawing[2])}
                          y={Math.min(drawing[1], drawing[3])}
                          width={Math.abs(drawing[2] - drawing[0])}
                          height={Math.abs(drawing[3] - drawing[1])}
                          fill="none"
                          vectorEffect="non-scaling-stroke"
                          {...style}
                        />
                      ))}
                    </g>
                  )}
                </svg>
              )}
            </Box>
            {addMode && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, textAlign: "center" }}>
                Drag on the image to draw a box around a missed object.
              </Typography>
            )}
          </Box>

          <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2, minWidth: 0 }}>
            {/* Review actions for this frame. */}
            <Box data-region="review" sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 1.5 }}>
              <Box aria-live="polite">
                {flash && <Alert severity="success">{flash}</Alert>}
              </Box>
              {actionError && (
                <Alert severity="error" role="alert" onClose={() => setActionError(null)} sx={{ overflowWrap: "anywhere" }}>
                  The review was not saved: {actionError}
                </Alert>
              )}

              {detail.status === "loading" || (detail.status === "ready" && !current) ? (
                <LoadingRow label="Loading the label…" />
              ) : detail.status === "error" ? (
                <ErrorRow what="The label could not be loaded" message={detail.message} onRetry={reloadDetail} />
              ) : !label ? (
                <Alert severity="info">This frame has no label yet, so there is nothing to review.</Alert>
              ) : isGold ? (
                <Alert severity="info">
                  Gold frames cannot be changed.
                  {role === "gold_holdout" ? " This one is part of the hold-out." : ""}
                  {role === "gold_exemplar" ? " This one is an exemplar." : ""}
                </Alert>
              ) : (
                <>
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                    <Button
                      variant="contained"
                      startIcon={busy === "accept" ? <CircularProgress size={18} color="inherit" aria-hidden /> : <CheckIcon />}
                      disabled={busy !== null || dirty}
                      onClick={() => void act("accept")}
                      sx={{ px: 2 }}
                    >
                      Accept as is
                    </Button>
                    <Button
                      variant="contained"
                      color="secondary"
                      startIcon={busy === "fix" ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
                      disabled={busy !== null || !dirty}
                      onClick={() => void act("fix")}
                      sx={{ px: 2 }}
                    >
                      Save corrections
                    </Button>
                    <Button
                      variant="outlined"
                      color="error"
                      disabled={busy !== null}
                      onClick={() => setConfirmReject(true)}
                      sx={{ px: 2 }}
                    >
                      Reject frame
                    </Button>
                  </Box>
                  {dirty && (
                    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 1 }}>
                      <Typography variant="body2" color="text.secondary">
                        You have unsaved corrections.
                      </Typography>
                      <Button
                        size="small"
                        disabled={busy !== null}
                        onClick={() => {
                          setDrafts(draftsFrom(label));
                          setSelectedKey(null);
                        }}
                        sx={{ px: 1.5 }}
                      >
                        Undo all of them
                      </Button>
                    </Box>
                  )}

                  <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }}>
                    <ToggleButton
                      value="add"
                      selected={addMode}
                      onChange={toggleAdd}
                      disabled={busy !== null || classes.length === 0}
                      color="primary"
                      sx={{ minHeight: 44, borderRadius: 999, px: 2, textTransform: "none", gap: 0.75, color: "text.primary" }}
                    >
                      <AddBoxOutlinedIcon fontSize="small" />
                      Add a box
                    </ToggleButton>
                    <Box component="label" htmlFor="add-box-class" sx={{ color: "text.secondary", fontSize: 14 }}>
                      as
                    </Box>
                    <Box
                      component="select"
                      id="add-box-class"
                      aria-label="Class for new boxes"
                      value={addClass}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAddClass(e.target.value)}
                      sx={{ ...selectSx, flex: "1 1 120px" }}
                    >
                      {classes.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Box>
                  </Box>

                  <Typography variant="body2" color="text.secondary">
                    Keys: A accept · S save corrections · B add a box · Delete removes the selected object · N or →
                    next · P or ← previous
                  </Typography>
                </>
              )}
            </Box>

            {label && drafts && (
              <>
                <FormControlLabel
                  control={
                    <Switch checked={showOverlay} disabled={addMode} onChange={(e) => setShowOverlay(e.target.checked)} />
                  }
                  label="Show labels on the image"
                  sx={{ minHeight: 44, m: 0 }}
                />

                {geminiVerdict && <VerdictBlock verdict={geminiVerdict} drafts={drafts} />}

                <Box component="section" aria-labelledby="frame-legend-title">
                  <Typography id="frame-legend-title" variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>
                    Classes in this frame
                  </Typography>
                  <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "flex", flexWrap: "wrap", columnGap: 2, rowGap: 0.5 }}>
                    {legend.map((name) => {
                      const n = counts.get(name) ?? 0;
                      return (
                        <Box
                          component="li"
                          key={name}
                          sx={{ display: "flex", alignItems: "center", gap: 0.75, color: n === 0 ? "text.secondary" : "text.primary" }}
                        >
                          <Swatch colour={colourFor(classes, name)} />
                          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                            {name} {formatCount(n)}
                            {!classes.includes(name) && " (not a class of this project)"}
                          </Typography>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>

                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                  {label.label_model
                    ? `Labelled by ${label.label_model.recipe} v${label.label_model.version}, profile ${label.label_model.profile}`
                    : "No labelling model is recorded for this label."}
                  {` · round ${label.round}`}
                  {label.review ? ` · last review by a person: ${label.review.action}` : ""}
                </Typography>

                <Box component="section" aria-labelledby="frame-objects-title" sx={{ minWidth: 0 }}>
                  <Typography id="frame-objects-title" variant="subtitle2" component="h3" sx={{ mb: 0.75 }}>
                    {plural(drafts.length, "object", "objects")}
                  </Typography>
                  {drafts.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No objects are labelled in this frame.
                    </Typography>
                  ) : (
                    <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 0.75 }}>
                      {drafts.map((d, i) => {
                        const selected = d.key === selectedKey;
                        const name = objectName(d, i);
                        const options = classes.includes(d.class) ? classes : [...classes, d.class];
                        return (
                          <Box
                            component="li"
                            key={d.key}
                            ref={(el: HTMLElement | null) => {
                              if (el) rowRefs.current.set(d.key, el);
                              else rowRefs.current.delete(d.key);
                            }}
                            onClick={() => select(d.key, false)}
                            sx={{
                              border: "2px solid",
                              borderColor: selected ? "primary.main" : "divider",
                              bgcolor: selected ? "#eef5e8" : "background.paper",
                              borderRadius: "12px",
                              px: 0.75,
                              py: 0.5,
                              minWidth: 0,
                            }}
                          >
                            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
                              <ButtonBase
                                aria-pressed={selected}
                                aria-label={`Highlight object ${name} on the image`}
                                onClick={() => select(d.key, false)}
                                sx={{
                                  minHeight: 44,
                                  minWidth: 44,
                                  px: 0.75,
                                  gap: 0.75,
                                  borderRadius: "8px",
                                  flexShrink: 0,
                                  font: "inherit",
                                  fontSize: 14,
                                  "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
                                }}
                              >
                                <Swatch colour={colourFor(classes, d.class)} />
                                {d.id ?? "new"}
                              </ButtonBase>
                              {editable ? (
                                <Box
                                  component="select"
                                  aria-label={`Class of object ${name}`}
                                  value={d.class}
                                  disabled={busy !== null}
                                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                                    setDrafts(drafts.map((x) => (x.key === d.key ? { ...x, class: e.target.value } : x)))
                                  }
                                  sx={{ ...selectSx, flex: 1 }}
                                >
                                  {options.map((c) => (
                                    <option key={c} value={c}>
                                      {c}
                                    </option>
                                  ))}
                                </Box>
                              ) : (
                                <Typography sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{d.class}</Typography>
                              )}
                              {editable && (
                                <IconButton
                                  aria-label={`Delete object ${name}`}
                                  disabled={busy !== null}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    remove(d.key);
                                  }}
                                  sx={{ width: 44, height: 44, flexShrink: 0 }}
                                >
                                  <DeleteOutlineIcon />
                                </IconButton>
                              )}
                            </Box>
                            <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75, pl: 0.75, pb: 0.25 }}>
                              <Typography variant="body2" color="text.secondary">
                                score {d.score !== null ? d.score.toFixed(2) : "—"}
                              </Typography>
                              {d.id === null && <Chip size="small" color="primary" label="new" />}
                              {d.id !== null && d.source === "human" && <Chip size="small" variant="outlined" label="person" />}
                              {d.source === "gold" && <Chip size="small" variant="outlined" label="gold" />}
                              {d.polygon === null && <Chip size="small" variant="outlined" label="box only" />}
                              {d.classSource === "gemini" && (
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  color="info"
                                  label={d.classBefore ? `Gemini: was ${d.classBefore}` : "Gemini"}
                                  sx={{ maxWidth: "100%" }}
                                />
                              )}
                            </Box>
                          </Box>
                        );
                      })}
                    </Box>
                  )}
                </Box>
              </>
            )}
          </Box>
        </Box>
      </DialogContent>

      <DialogActions sx={{ justifyContent: "space-between", px: { xs: 1.5, sm: 2 }, py: 1.5 }}>
        <Button startIcon={<ChevronLeftIcon />} disabled={!hasPrev || busy !== null} onClick={() => go(-1)}>
          Previous
        </Button>
        <Button endIcon={<ChevronRightIcon />} disabled={!hasNext || busy !== null} onClick={() => go(1)}>
          Next
        </Button>
      </DialogActions>

      {confirmReject && (
        <Dialog
          open
          onClose={() => setConfirmReject(false)}
          fullWidth
          maxWidth="xs"
          aria-labelledby="reject-title"
          aria-describedby="reject-text"
        >
          <DialogTitle id="reject-title">Reject this frame?</DialogTitle>
          <DialogContent>
            <Typography id="reject-text">
              The frame is left out of training and no new label is written.
              {dirty ? " Your unsaved corrections to it are discarded." : ""} It can be reviewed again later.
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setConfirmReject(false)}>Cancel</Button>
            <Button
              variant="contained"
              color="error"
              onClick={() => {
                setConfirmReject(false);
                void act("reject");
              }}
            >
              Reject frame
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {pendingDiscard && (
        <Dialog
          open
          onClose={() => setPendingDiscard(null)}
          fullWidth
          maxWidth="xs"
          aria-labelledby="discard-title"
          aria-describedby="discard-text"
        >
          <DialogTitle id="discard-title">Discard your corrections?</DialogTitle>
          <DialogContent>
            <Typography id="discard-text">
              You changed this frame's objects and have not saved. Leaving now throws those changes away.
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setPendingDiscard(null)}>Keep editing</Button>
            <Button
              variant="contained"
              color="error"
              onClick={() => {
                const then = pendingDiscard;
                setPendingDiscard(null);
                then();
              }}
            >
              Discard
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Dialog>
  );
}
