import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Typography } from "@mui/material";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import StopIcon from "@mui/icons-material/Stop";
import VideocamOutlinedIcon from "@mui/icons-material/VideocamOutlined";
import { formatBytes, formatTimestamp } from "../format";
import { srOnly } from "./Step";

const MAX_RECORDING_MS = 10 * 60 * 1000;
const BITS_PER_SECOND = 6_000_000;
const SIZE_HEADROOM = 0.95; // stop at 95% of the upload limit
// Tried in this order; the first one this browser's recorder supports is used.
const MIME_CANDIDATES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];

type Problem = { title: string; detail: string };

type Recording = {
  file: File; // named camera-<YYYYMMDD-HHMMSS>.webm|.mp4, typed without any ;codecs= suffix
  url: string; // object URL for playing it back before deciding
  durationMs: number;
  note: string | null; // why it stopped, when it was not the Stop button
};

type Cam =
  | { phase: "closed" }
  | { phase: "opening" }
  | { phase: "preview" }
  | { phase: "recording" }
  | { phase: "recorded"; recording: Recording }
  | { phase: "error"; problem: Problem };

function unavailable(): Problem | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return {
      title: "This page cannot use a camera",
      detail:
        "The browser gives a page the camera only when it was opened over https or on localhost, and only in a current browser. Open the app that way and try again.",
    };
  }
  if (typeof MediaRecorder === "undefined") {
    return {
      title: "This browser cannot record video",
      detail: "It has no built-in recorder. Use a current version of Chrome, Edge or Firefox, or add a video file instead.",
    };
  }
  return null;
}

function problemFrom(err: unknown): Problem {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      title: "The camera was not allowed",
      detail:
        "The browser or the system refused camera access for this site. Allow the camera for this site (the camera or lock icon in the address bar), then try again.",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      title: "No camera was found",
      detail: "This computer reports no camera, or the one chosen is no longer attached. Plug the camera in, then try again.",
    };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      title: "The camera could not be started",
      detail:
        "It is attached but would not deliver video. Another program, such as a camera viewer, may be holding it. Close that program, then try again.",
    };
  }
  return {
    title: "The camera could not be started",
    detail: err instanceof Error && err.message ? err.message : "The browser gave no reason.",
  };
}

function pickMimeType(): string | null {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

function timestampName(at: Date, extension: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `camera-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.${extension}`;
}

/**
 * Records from a camera attached to this computer, in this browser, and hands the finished
 * recording to `onUpload`. Nothing is streamed: the upload starts only when the person asks.
 * No audio is ever requested. The camera is released when recording stops, when the panel is
 * closed, and when the page is left.
 */
export default function CameraRecorder({
  disabled,
  maxUploadBytes,
  onUpload,
}: {
  disabled: boolean; // an upload is in flight
  maxUploadBytes: number | null; // the project's upload limit, when known
  onUpload: (file: File) => Promise<boolean>; // resolves true when the recording has been uploaded
}) {
  const [cam, setCam] = useState<Cam>({ phase: "closed" });
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [delivered, setDelivered] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [announce, setAnnounce] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const startedRef = useRef<{ at: Date; clock: number } | null>(null);
  const stopNoteRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const recordingUrlRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const openTokenRef = useRef(0);

  const sizeCap = maxUploadBytes !== null ? Math.floor(maxUploadBytes * SIZE_HEADROOM) : null;

  /** Stops every track and detaches the preview, so the camera light goes off. */
  const releaseCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const forgetRecording = useCallback(() => {
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    recordingUrlRef.current = null;
  }, []);

  /** Ends the recorder; its onstop builds the file. `note` says why, when it was not the Stop button. */
  const stopRecording = useCallback((note: string | null) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    stopNoteRef.current = note;
    recorder.stop();
  }, []);

  const open = useCallback(
    async (wantedDeviceId?: string) => {
      const missing = unavailable();
      if (missing) {
        setCam({ phase: "error", problem: missing });
        return;
      }
      const token = ++openTokenRef.current;
      releaseCamera();
      setCam({ phase: "opening" });
      setDelivered(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 800 },
            frameRate: { ideal: 30 },
            ...(wantedDeviceId ? { deviceId: { exact: wantedDeviceId } } : {}),
          },
          audio: false,
        });
        if (!aliveRef.current || token !== openTokenRef.current) {
          stream.getTracks().forEach((t) => t.stop()); // the panel closed while the browser was asking
          return;
        }
        const track = stream.getVideoTracks()[0];
        if (!track) {
          stream.getTracks().forEach((t) => t.stop());
          setCam({ phase: "error", problem: problemFrom(new DOMException("no video track", "NotFoundError")) });
          return;
        }
        streamRef.current = stream;

        // What the camera actually delivers - never the values that were asked for.
        const s = track.getSettings();
        const size = s.width && s.height ? `${s.width} × ${s.height}` : "size not reported";
        const rate =
          typeof s.frameRate === "number"
            ? `${Number.isInteger(s.frameRate) ? s.frameRate : s.frameRate.toFixed(1)} fps`
            : "frame rate not reported";
        setDelivered(`${size} at ${rate}`);

        track.addEventListener("ended", () => {
          if (streamRef.current !== stream) return; // an old stream we already replaced
          if (recorderRef.current && recorderRef.current.state !== "inactive") {
            stopRecording("The camera stopped sending video, so the recording ended early. What was recorded is kept.");
          } else {
            releaseCamera();
            setCam({
              phase: "error",
              problem: {
                title: "The camera stopped",
                detail: "It was unplugged, or another program took it over. Check the camera, then try again.",
              },
            });
          }
        });

        // Labels are only filled in once permission has been given, so list the cameras now.
        let inputs: { id: string; label: string }[] = [];
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          inputs = all
            .filter((d) => d.kind === "videoinput")
            .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
        } catch {
          inputs = [];
        }
        if (!aliveRef.current || token !== openTokenRef.current) return;
        // The camera in use: the one that was asked for, else the one the track says it came from.
        const has = (id: string | undefined): id is string => !!id && inputs.some((d) => d.id === id);
        if (inputs.length === 0) inputs = [{ id: s.deviceId ?? wantedDeviceId ?? "", label: track.label || "Camera 1" }];
        setDevices(inputs);
        setDeviceId(has(wantedDeviceId) ? wantedDeviceId : has(s.deviceId) ? s.deviceId : inputs[0].id);

        setCam({ phase: "preview" });
        setAnnounce(`Camera on: ${size} at ${rate}.`);
      } catch (err) {
        if (!aliveRef.current || token !== openTokenRef.current) return;
        releaseCamera();
        setCam({ phase: "error", problem: problemFrom(err) });
      }
    },
    [releaseCamera, stopRecording],
  );

  // Attach the stream once the <video> exists (it is rendered only in preview / recording).
  useEffect(() => {
    if ((cam.phase === "preview" || cam.phase === "recording") && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) videoRef.current.srcObject = streamRef.current;
    }
  }, [cam.phase]);

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = pickMimeType();
    if (!mimeType) {
      releaseCamera();
      setCam({
        phase: "error",
        problem: {
          title: "This browser cannot record video",
          detail: "Its recorder supports neither WebM nor MP4. Use a current version of Chrome, Edge or Firefox, or add a video file instead.",
        },
      });
      return;
    }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITS_PER_SECOND });
    } catch (err) {
      releaseCamera();
      setCam({ phase: "error", problem: problemFrom(err) });
      return;
    }
    const baseType = mimeType.split(";")[0]; // "video/webm" or "video/mp4": no ;codecs= suffix
    chunksRef.current = [];
    bytesRef.current = 0;
    stopNoteRef.current = null;
    startedRef.current = { at: new Date(), clock: performance.now() };
    setElapsedMs(0);
    setBytes(0);

    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      chunksRef.current.push(e.data);
      bytesRef.current += e.data.size;
      setBytes(bytesRef.current);
      // Stop before the next second of video could take the recording past the upload limit.
      if (sizeCap !== null && recorder.state === "recording" && bytesRef.current + e.data.size > sizeCap) {
        stopRecording("Recording stopped because it reached the project's upload size limit.");
      }
    };
    recorder.onerror = () => stopRecording("The recorder reported an error, so the recording ended early. What was recorded is kept.");
    recorder.onstop = () => {
      clearTimer();
      const started = startedRef.current;
      const durationMs = started ? performance.now() - started.clock : 0;
      recorderRef.current = null;
      releaseCamera(); // the camera is not needed while the person decides what to do with the clip
      if (!aliveRef.current) return;
      const size = bytesRef.current;
      if (size === 0) {
        chunksRef.current = [];
        setCam({
          phase: "error",
          problem: { title: "Nothing was recorded", detail: "The recorder produced no video. Try again." },
        });
        return;
      }
      const file = new File(chunksRef.current, timestampName(started?.at ?? new Date(), baseType === "video/mp4" ? "mp4" : "webm"), {
        type: baseType,
      });
      chunksRef.current = [];
      forgetRecording();
      const url = URL.createObjectURL(file);
      recordingUrlRef.current = url;
      setElapsedMs(durationMs);
      setCam({ phase: "recorded", recording: { file, url, durationMs, note: stopNoteRef.current } });
      setAnnounce(`Recording stopped: ${formatTimestamp(Math.floor(durationMs / 1000))}, ${formatBytes(size)}.`);
    };

    recorderRef.current = recorder;
    recorder.start(1000);
    timerRef.current = window.setInterval(() => {
      const started = startedRef.current;
      if (!started) return;
      const ms = performance.now() - started.clock;
      setElapsedMs(ms);
      if (ms >= MAX_RECORDING_MS) stopRecording("Recording stopped by itself at the 10-minute limit.");
    }, 250);
    setCam({ phase: "recording" });
    setAnnounce("Recording started.");
  };

  const close = () => {
    openTokenRef.current += 1; // a permission prompt still open must not turn the camera on later
    releaseCamera();
    setCam({ phase: "closed" });
    setDelivered(null);
    setAnnounce("Camera off.");
  };

  const discard = () => {
    forgetRecording();
    setCam({ phase: "closed" });
    setAnnounce("Recording discarded.");
  };

  const upload = async (recording: Recording) => {
    const ok = await onUpload(recording.file);
    if (!aliveRef.current || !ok) return; // on failure the recording stays here, ready to try again
    forgetRecording();
    setCam({ phase: "closed" });
    setAnnounce("");
  };

  // Leaving the page: stop recording without keeping it, release the camera, free the clip.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
      recordingUrlRef.current = null;
    };
  }, []);

  const live = cam.phase === "preview" || cam.phase === "recording";
  const elapsed = formatTimestamp(Math.floor(elapsedMs / 1000));

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 1.5, minWidth: 0 }}>
      <Box role="status" aria-live="polite" sx={srOnly}>
        {announce}
      </Box>

      {cam.phase === "closed" && (
        <Box>
          <Button variant="outlined" startIcon={<VideocamOutlinedIcon />} disabled={disabled} onClick={() => void open()}>
            Record from camera
          </Button>
        </Box>
      )}

      {cam.phase === "opening" && (
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
          <Typography role="status">Starting the camera… If the browser asks, allow it to use the camera.</Typography>
          <Button onClick={close}>Cancel</Button>
        </Box>
      )}

      {cam.phase === "error" && (
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
          <Box sx={{ fontWeight: 500 }}>{cam.problem.title}</Box>
          {cam.problem.detail}
          <Box sx={{ mt: 0.5 }}>
            <Button color="inherit" size="small" onClick={close} sx={{ px: 1, ml: -1 }}>
              Close
            </Button>
          </Box>
        </Alert>
      )}

      {live && (
        <>
          <Box
            sx={{
              position: "relative",
              width: "100%",
              maxWidth: 640,
              bgcolor: "#16181a",
              borderRadius: "12px",
              overflow: "hidden",
              lineHeight: 0,
              outline: cam.phase === "recording" ? "3px solid #b3261e" : "none",
            }}
          >
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              aria-label={cam.phase === "recording" ? "Live camera preview, recording" : "Live camera preview"}
              style={{ display: "block", width: "100%", height: "auto", minHeight: 120 }}
            />
            {cam.phase === "recording" && (
              <Box
                sx={{
                  position: "absolute",
                  top: 8,
                  left: 8,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 0.5,
                  bgcolor: "#b3261e",
                  color: "#ffffff",
                  borderRadius: "8px",
                  px: 1,
                  py: 0.25,
                  lineHeight: 1.6,
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                <FiberManualRecordIcon sx={{ fontSize: 14 }} aria-hidden />
                REC {elapsed}
              </Box>
            )}
          </Box>

          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 2, rowGap: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, flex: "1 1 220px" }}>
              <Box component="label" htmlFor="camera-select" sx={{ color: "text.secondary", flexShrink: 0 }}>
                Camera
              </Box>
              <Box
                component="select"
                id="camera-select"
                value={deviceId}
                disabled={cam.phase === "recording" || devices.length <= 1}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                  setDeviceId(e.target.value);
                  void open(e.target.value);
                }}
                sx={{
                  font: "inherit",
                  minHeight: 44,
                  minWidth: 0,
                  flex: 1,
                  px: 1,
                  borderRadius: "12px",
                  border: "1px solid rgba(0,0,0,0.3)",
                  bgcolor: "background.paper",
                  color: "text.primary",
                  "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 1 },
                }}
              >
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </Box>
            </Box>
            {delivered && (
              <Typography sx={{ overflowWrap: "anywhere" }}>
                <Box component="span" sx={{ color: "text.secondary" }}>
                  The camera is delivering{" "}
                </Box>
                {delivered}
              </Typography>
            )}
          </Box>

          {cam.phase === "preview" ? (
            <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
              <Button variant="contained" startIcon={<FiberManualRecordIcon />} onClick={startRecording}>
                Start recording
              </Button>
              <Button onClick={close}>Close camera</Button>
              <Typography variant="body2" color="text.secondary">
                Stops by itself after 10 minutes
                {sizeCap !== null ? `, or at ${formatBytes(sizeCap)} (just under the project's upload limit)` : ""}. No
                sound is recorded.
              </Typography>
            </Box>
          ) : (
            <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
              <Button variant="contained" color="error" startIcon={<StopIcon />} onClick={() => stopRecording(null)}>
                Stop
              </Button>
              <Typography sx={{ fontVariantNumeric: "tabular-nums" }}>
                <Box component="span" sx={{ fontWeight: 700 }}>
                  Recording
                </Box>{" "}
                {elapsed} · {formatBytes(bytes)} so far
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Stops by itself after 10 minutes.
              </Typography>
            </Box>
          )}
        </>
      )}

      {cam.phase === "recorded" && (
        <>
          <Box sx={{ width: "100%", maxWidth: 640, bgcolor: "#16181a", borderRadius: "12px", overflow: "hidden", lineHeight: 0 }}>
            <video
              src={cam.recording.url}
              controls
              muted
              playsInline
              aria-label="Your recording, not uploaded yet"
              style={{ display: "block", width: "100%", height: "auto", minHeight: 120 }}
            />
          </Box>
          <Typography sx={{ overflowWrap: "anywhere" }}>
            Recorded {formatTimestamp(Math.floor(cam.recording.durationMs / 1000))} · {formatBytes(cam.recording.file.size)} ·{" "}
            {cam.recording.file.name}. It is still only in this browser, and the camera is off.
          </Typography>
          {cam.recording.note && <Alert severity="info">{cam.recording.note}</Alert>}
          {maxUploadBytes !== null && cam.recording.file.size > maxUploadBytes && (
            <Alert severity="warning">
              This recording is larger than the project's upload limit of {formatBytes(maxUploadBytes)}, so the upload
              will be refused.
            </Alert>
          )}
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5 }}>
            <Button variant="contained" disabled={disabled} onClick={() => void upload(cam.recording)}>
              Upload this recording
            </Button>
            <Button variant="outlined" color="error" disabled={disabled} onClick={discard}>
              Discard
            </Button>
          </Box>
        </>
      )}
    </Box>
  );
}
