import { useCallback, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, FormControlLabel, Switch, Typography } from "@mui/material";
import VideocamOutlinedIcon from "@mui/icons-material/VideocamOutlined";
import VideocamOffOutlinedIcon from "@mui/icons-material/VideocamOffOutlined";
import { api, ApiError, errorMessage, type PredictResult, type Project } from "../api";
import { cameraProblemFrom, cameraUnavailable, type CameraProblem, type ChosenCamera } from "../camera";
import { formatCount, inClassOrder, plural } from "../format";
import { rx } from "../theme";
import { colourFor } from "./FrameReviewDialog";
import { EmptyState } from "./States";
import { StatusBadge } from "./ui";

// One still frame goes to the model; when its answer is back there is a pause, then the next.
// So a frame goes every few seconds: this pause plus the time the answer took.
const GAP_MS = 3000;
// While there is nothing to send (the picture has not started, or the tab is hidden), look again this often.
const NOT_READY_MS = 1000;
// An answer that has not come by now is given up on, so a hung call cannot stop the loop for good.
const ANSWER_TIMEOUT_MS = 45_000;
// Labelling uses compute for as long as it runs, so it stops by itself and says so.
const AUTO_PAUSE_MS = 5 * 60 * 1000;
// Outlines older than this are taken off the picture: the belt has moved on.
const STALE_MS = 15_000;
// A failed call that looks temporary (no connection, a 5xx) is tried again this many times.
const MAX_SOFT_FAILURES = 2;
const MAX_FRAME_WIDTH = 1280;
// Kept under the API's 2 MB limit for one picture (agents.yaml annotator_model.live_max_image_mb).
const MAX_FRAME_BYTES = 1_900_000;
const LABELLING_KEY = "retrainix.liveLabelling";

type View =
  | { phase: "off" }
  | { phase: "opening" }
  | { phase: "live"; delivered: string; label: string }
  | { phase: "error"; problem: CameraProblem };

type Labelled = PredictResult & { at: number };
type LabelNote = { tone: "info" | "error"; text: string };

function readLabellingChoice(): boolean {
  try {
    return window.localStorage.getItem(LABELLING_KEY) !== "0"; // on unless it was switched off here before
  } catch {
    return true;
  }
}

function rememberLabellingChoice(on: boolean): void {
  try {
    window.localStorage.setItem(LABELLING_KEY, on ? "1" : "0");
  } catch {
    /* without storage the choice lasts for this page only */
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The frame could not be encoded."))), "image/jpeg", quality),
  );
}

/** The current picture of a playing <video> as a JPEG, no wider than MAX_FRAME_WIDTH, proportions kept. */
async function grabFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<Blob> {
  const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot copy a frame from the camera.");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const jpeg = await toJpeg(canvas, 0.85);
  // A very detailed picture can come out large; a second, stronger compression keeps it under the limit.
  return jpeg.size <= MAX_FRAME_BYTES ? jpeg : toJpeg(canvas, 0.6);
}

/**
 * The camera chosen on the Project setup screen, shown live, with the project's model labelling
 * a still frame of it every few seconds. Nothing is recorded and no frame is stored: a frame is
 * sent to the model, labelled, and dropped. The outlines therefore belong to the frame that was
 * sent, not to the moving picture, and they are taken off again when they get old. The camera is
 * released when the person turns it off, when another camera is chosen, and when the page is left.
 */
export default function LiveCameraView({ project, camera, setupLink }: { project: Project; camera: ChosenCamera | null; setupLink: string }) {
  const [view, setView] = useState<View>({ phase: "off" });
  const [aspect, setAspect] = useState<number | null>(null); // width / height of the camera's picture
  const [labelling, setLabelling] = useState(readLabellingChoice);
  const [labelled, setLabelled] = useState<Labelled | null>(null);
  const [labelNote, setLabelNote] = useState<LabelNote | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tokenRef = useRef(0);
  const pid = project.id;
  const cameraId = camera?.id ?? null;
  const cameraLabel = camera?.label ?? "Camera";

  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const open = useCallback(async () => {
    if (!cameraId) return;
    const missing = cameraUnavailable();
    if (missing) {
      setView({ phase: "error", problem: missing });
      return;
    }
    const token = ++tokenRef.current;
    release();
    setLabelled(null);
    setView({ phase: "opening" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 800 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      if (token !== tokenRef.current) {
        stream.getTracks().forEach((t) => t.stop()); // turned off, or another camera chosen, while the browser was asking
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        setView({ phase: "error", problem: cameraProblemFrom(new DOMException("no video track", "NotFoundError")) });
        return;
      }
      streamRef.current = stream;
      // What the camera actually delivers - never the values that were asked for.
      const s = track.getSettings();
      const size = s.width && s.height ? `${s.width} × ${s.height}` : "size not reported";
      const rate =
        typeof s.frameRate === "number" ? `${Number.isInteger(s.frameRate) ? s.frameRate : s.frameRate.toFixed(1)} fps` : "frame rate not reported";
      setAspect(s.width && s.height ? s.width / s.height : null);
      track.addEventListener("ended", () => {
        if (streamRef.current !== stream) return;
        release();
        setLabelled(null);
        setView({
          phase: "error",
          problem: { title: "The camera stopped", detail: "It was unplugged, or another program took it over. Check the camera, then try again." },
        });
      });
      // The name the person saw when choosing it; the track's own label only if none was kept.
      setView({ phase: "live", delivered: `${size} at ${rate}`, label: cameraLabel || track.label || "Camera" });
    } catch (err) {
      if (token !== tokenRef.current) return;
      release();
      setView({ phase: "error", problem: cameraProblemFrom(err) });
    }
  }, [cameraId, cameraLabel, release]);

  const turnOff = useCallback(() => {
    tokenRef.current += 1; // a permission prompt still open must not turn the camera on later
    release();
    setLabelled(null);
    setView({ phase: "off" });
  }, [release]);

  // Start with the chosen camera, and again whenever a different one is chosen. Leaving the
  // page, or switching back to the stored frame, releases it.
  useEffect(() => {
    if (cameraId) void open();
    return () => {
      tokenRef.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [cameraId, open]);

  // Attach the stream once the <video> exists (it is rendered only while live).
  const live = view.phase === "live";
  useEffect(() => {
    if (live && videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [live]);

  // While the camera is live and labelling is on: one frame to the model, wait for the answer,
  // pause, the next. One request at a time, none while the tab is hidden, and it stops by itself
  // after a few minutes. A busy model (429) or a passing fault is tried again on the next turn.
  useEffect(() => {
    if (!live || !labelling) return;
    let stopped = false;
    let timer: number | undefined;
    let inFlight: AbortController | null = null;
    let softFailures = 0;
    const startedAt = Date.now();
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - startedAt > AUTO_PAUSE_MS) {
        rememberLabellingChoice(false); // the pause holds on the next visit too, until it is switched on again
        setLabelling(false);
        setLabelled(null);
        setLabelNote({ tone: "info", text: "Labelling paused by itself after 5 minutes, to save compute. Switch it on again to continue." });
        return;
      }
      const video = videoRef.current;
      if (document.visibilityState !== "visible" || !video || video.videoWidth === 0) {
        // Nothing to send yet: the picture has not started, or the tab is hidden.
        timer = window.setTimeout(() => void tick(), NOT_READY_MS);
        return;
      }
      const call = new AbortController();
      inFlight = call;
      const giveUp = window.setTimeout(() => call.abort(), ANSWER_TIMEOUT_MS);
      try {
        if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
        const jpeg = await grabFrame(video, canvasRef.current);
        if (stopped) return; // switched off, or the view left, while the frame was being copied: send nothing
        const sentAt = Date.now();
        const result = await api.predictFrame(pid, jpeg, call.signal);
        if (stopped) return;
        softFailures = 0;
        setLabelled({ ...result, at: sentAt });
        setLabelNote(null);
      } catch (err) {
        if (stopped) return;
        const status = err instanceof ApiError ? err.status : -1;
        const busy = status === 429; // the model is still labelling an earlier frame: not a fault
        const passing = status === 0 || status >= 500 || status === -1;
        if (!busy && !(passing && softFailures < MAX_SOFT_FAILURES)) {
          setLabelling(false);
          setLabelled(null);
          setLabelNote({ tone: "error", text: `Labelling stopped: ${errorMessage(err)}` });
          return;
        }
        if (!busy) softFailures += 1;
      } finally {
        window.clearTimeout(giveUp);
        if (inFlight === call) inFlight = null;
      }
      timer = window.setTimeout(() => void tick(), GAP_MS);
    };
    timer = window.setTimeout(() => void tick(), 600);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      inFlight?.abort(); // an answer still on its way is no longer wanted
    };
  }, [live, labelling, pid]);

  // A clock, only while outlines can be on the picture, so they can be taken off when they get old.
  useEffect(() => {
    if (!live || !labelling) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, labelling]);

  if (!camera) {
    return (
      <Box sx={{ px: { xs: 2, sm: 3 }, pb: 3 }}>
        <EmptyState
          icon={<VideocamOutlinedIcon fontSize="large" />}
          title="No camera chosen yet"
          action={
            <Button variant="contained" component={RouterLink} to={setupLink}>
              Choose a camera
            </Button>
          }
        >
          On the Project setup screen, press Record from camera and pick the camera. The same camera is then shown
          live here, and the model labels what it sees.
        </EmptyState>
      </Box>
    );
  }

  const ageMs = labelled ? Math.max(0, now - labelled.at) : 0;
  // If the camera has changed the shape of its picture since, the outlines no longer fit it.
  const fits = !labelled || !aspect || Math.abs(labelled.width / labelled.height / aspect - 1) < 0.02;
  const shown = live && labelling && labelled && ageMs <= STALE_MS && fits ? labelled : null;
  const waiting = live && labelling && !shown && !labelNote;
  const perClass: Record<string, number> = {};
  for (const o of shown?.objects ?? []) perClass[o.class] = (perClass[o.class] ?? 0) + 1;
  const classesSeen = inClassOrder(Object.keys(perClass), project.classes);

  return (
    <>
      {view.phase === "live" && (
        // The box takes the camera's own proportions, so the picture is never cropped or stretched
        // and the outlines, drawn over the same box, sit where the model saw them.
        <Box sx={{ position: "relative", bgcolor: rx.annotationSurface, lineHeight: 0, ...(aspect ? { aspectRatio: String(aspect) } : {}) }}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            aria-label={`Live picture from ${view.label}`}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight);
            }}
            onResize={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight);
            }}
            style={{ display: "block", width: "100%", height: aspect ? "100%" : "auto" }}
          />
          {shown && (
            <svg
              viewBox={`0 0 ${shown.width} ${shown.height}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${plural(shown.objects.length, "object", "objects")} outlined by the model on the last frame it was sent`}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
            >
              {shown.objects.map((o, i) => {
                const colour = colourFor(project.classes, o.class);
                const key = o.id ?? String(i);
                if (o.polygon_xy && o.polygon_xy.length >= 3) {
                  return (
                    <polygon
                      key={key}
                      points={o.polygon_xy.map(([x, y]) => `${x},${y}`).join(" ")}
                      fill={colour}
                      fillOpacity={0.2}
                      stroke={colour}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                }
                if (!Array.isArray(o.bbox_xyxy) || o.bbox_xyxy.length !== 4) return null; // nothing to draw it with
                const [x0, y0, x1, y1] = o.bbox_xyxy;
                return (
                  <rect key={key} x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="none" stroke={colour} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                );
              })}
            </svg>
          )}
          <Box sx={{ position: "absolute", top: 12, left: 12, right: 12, display: "flex", flexWrap: "wrap", gap: 1, lineHeight: 1.5 }}>
            <StatusBadge tone="success">Live · not recording</StatusBadge>
            {labelling && (
              <StatusBadge tone="accent">
                {/* The short form on a phone, where two long badges would cover the picture. */}
                <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
                  Model labels a still frame every few seconds
                </Box>
                <Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>
                  Model labelling
                </Box>
              </StatusBadge>
            )}
          </Box>
        </Box>
      )}

      {view.phase === "opening" && (
        <Box sx={{ px: { xs: 2, sm: 3 }, py: 3 }}>
          <Typography role="status">Starting the camera… If the browser asks, allow it to use the camera.</Typography>
        </Box>
      )}

      {view.phase === "off" && (
        <Box sx={{ px: { xs: 2, sm: 3 }, pb: 3 }}>
          <EmptyState
            icon={<VideocamOffOutlinedIcon fontSize="large" />}
            title="The camera is off"
            action={
              <Button variant="contained" startIcon={<VideocamOutlinedIcon />} onClick={() => void open()}>
                Turn the camera on
              </Button>
            }
          >
            {camera.label} is the camera chosen on Project setup. Turn it on to see the belt live.
          </EmptyState>
        </Box>
      )}

      {view.phase === "error" && (
        <Box sx={{ px: { xs: 2, sm: 3 }, pb: 2 }}>
          <Alert
            severity="error"
            role="alert"
            sx={{ overflowWrap: "anywhere" }}
            action={
              <Button color="inherit" size="small" onClick={() => void open()}>
                Try again
              </Button>
            }
          >
            <Box sx={{ fontWeight: 500 }}>{view.problem.title}</Box>
            {view.problem.detail}
          </Alert>
        </Box>
      )}

      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5, px: { xs: 2, sm: 3 }, pt: 2 }}>
        <Button variant="contained" component={RouterLink} to={setupLink} startIcon={<VideocamOutlinedIcon />}>
          Record a clip
        </Button>
        {view.phase === "live" && (
          <Button variant="outlined" onClick={turnOff}>
            Turn the camera off
          </Button>
        )}
        <Box sx={{ flex: "1 1 8px" }} />
        <FormControlLabel
          control={
            <Switch
              checked={labelling}
              onChange={(e) => {
                rememberLabellingChoice(e.target.checked);
                setLabelling(e.target.checked);
                setLabelled(null);
                setLabelNote(null);
              }}
            />
          }
          label="Label with the model"
          sx={{ mr: 0, minHeight: 44 }}
        />
      </Box>

      <Box sx={{ display: "grid", gap: 1, px: { xs: 2, sm: 3 }, pt: 1.5 }}>
        <Typography sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <Box component="span" sx={{ color: "text.secondary" }}>
            Camera{" "}
          </Box>
          {view.phase === "live" ? view.label : camera.label}
          {view.phase === "live" && (
            <>
              <Box component="span" sx={{ color: "text.secondary" }}>
                {" "}
                · delivering{" "}
              </Box>
              {view.delivered}
            </>
          )}
        </Typography>

        {waiting && (
          <Typography color="text.secondary" role="status">
            {labelled
              ? "Waiting for the next labelled frame…"
              : "Sending the first frame to the model… The first answer takes longer, while the model loads."}
          </Typography>
        )}
        {shown && (
          <Typography sx={{ overflowWrap: "anywhere" }}>
            <Box component="span" sx={{ fontWeight: 600 }}>
              {plural(shown.objects.length, "object", "objects")}
            </Box>{" "}
            on the frame sent {Math.round(ageMs / 1000)} s ago
            {classesSeen.length > 0 ? `: ${classesSeen.map((c) => `${c} ${formatCount(perClass[c])}`).join(", ")}` : ""}
            {typeof shown.unmapped_objects === "number" && shown.unmapped_objects > 0
              ? ` · ${formatCount(shown.unmapped_objects)} more not matched to a class`
              : ""}
            <Box component="span" sx={{ color: "text.secondary" }}>
              {" "}
              · labelled{typeof shown.seconds === "number" ? ` in ${shown.seconds.toFixed(1)} s` : ""}
              {shown.label_model ? ` by ${shown.label_model.recipe} v${shown.label_model.version}` : ""}
            </Box>
          </Typography>
        )}
        {labelNote && (
          <Alert severity={labelNote.tone === "error" ? "error" : "info"} role={labelNote.tone === "error" ? "alert" : "status"} sx={{ overflowWrap: "anywhere" }}>
            {labelNote.text}
          </Alert>
        )}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ px: { xs: 2, sm: 3 }, pt: 1.5, pb: 2 }}>
        A live picture from the camera on this computer; nothing is recorded. While "Label with the model" is on, a
        still frame leaves this computer every few seconds: it is sent to the Retrainix service, labelled by the
        model there, and not stored. The outlines belong to that frame, so on a moving belt they trail the picture,
        and they are the model's guesses, not checked labels. To change the camera, pick another one on Project
        setup.
      </Typography>
    </>
  );
}
