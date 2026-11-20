import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Alert, Box, Button, Card, CardContent, Divider, LinearProgress, Stack, Typography } from "@mui/material";
import VideoFileOutlinedIcon from "@mui/icons-material/VideoFileOutlined";
import { ApiError, api, errorMessage, uploadFile, type Job, type UploadHandle } from "../api";
import { formatBytes } from "../format";
import { useLoad } from "../hooks";
import CameraRecorder from "./CameraRecorder";

type Upload =
  | { phase: "idle" }
  | { phase: "requesting"; filename: string }
  | { phase: "uploading"; filename: string; sent: number; total: number }
  | { phase: "completing"; filename: string }
  | { phase: "done"; filename: string }
  | { phase: "cancelled"; filename: string }
  | { phase: "error"; filename: string; message: string };

// Browsers leave File.type empty for containers they do not know; fall back on the extension.
const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

function videoContentType(file: File): string | null {
  if (file.type.startsWith("video/")) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_TYPES[ext] ?? null;
}

/**
 * The one place footage is added: a video file, or a recording made here from a camera. Both
 * go the same way: ask the API for an upload slot, PUT the bytes straight to storage (real
 * progress from the browser's upload events), then tell the API it is complete, which starts
 * frame extraction and returns that job.
 */
export default function AddVideoCard({
  pid,
  onJobStarted,
  onAssetsChanged,
}: {
  pid: string;
  onJobStarted: (job: Job) => void;
  onAssetsChanged: () => void;
}) {
  const [upload, setUpload] = useState<Upload>({ phase: "idle" });
  const [config] = useLoad(() => api.config(), []);
  const inputRef = useRef<HTMLInputElement>(null);
  const handleRef = useRef<UploadHandle | null>(null);

  // Leaving the page stops an upload that is still in flight.
  useEffect(() => () => handleRef.current?.abort(), []);

  const busy = upload.phase === "requesting" || upload.phase === "uploading" || upload.phase === "completing";

  const maxUploadMb = config.status === "ready" ? config.data.limits?.max_upload_mb : undefined;
  const maxUploadBytes = typeof maxUploadMb === "number" && maxUploadMb > 0 ? maxUploadMb * 1024 * 1024 : null;

  /** Resolves true when the file is uploaded and its extraction job has started. */
  const start = async (file: File, source: "file" | "camera"): Promise<boolean> => {
    const filename = file.name;
    // Only the bare media type is sent ("video/webm", never "video/webm;codecs=vp9"): the upload
    // link is bound to the exact Content-Type, and the same value must go on the PUT.
    const contentType = videoContentType(file)?.split(";")[0].trim() ?? null;
    if (!contentType) {
      setUpload({ phase: "error", filename, message: "This file is not a video. Choose an MP4 or another video file." });
      return false;
    }
    if (file.size === 0) {
      setUpload({ phase: "error", filename, message: "This file is empty." });
      return false;
    }

    setUpload({ phase: "requesting", filename });
    try {
      const ticket = await api.createUpload(pid, {
        kind: "video",
        filename,
        content_type: contentType,
        size_bytes: file.size,
        ...(source === "camera" ? { source } : {}),
      });

      setUpload({ phase: "uploading", filename, sent: 0, total: file.size });
      const handle = uploadFile(ticket, file, (sent, total) =>
        setUpload({ phase: "uploading", filename, sent, total }),
      );
      handleRef.current = handle;
      await handle.done;
      handleRef.current = null;

      setUpload({ phase: "completing", filename });
      const job = await api.completeAsset(pid, ticket.asset_id);
      onJobStarted(job);
      setUpload({ phase: "done", filename });
      return true;
    } catch (err) {
      handleRef.current = null;
      if (err instanceof ApiError && err.code === "aborted") {
        setUpload({ phase: "cancelled", filename });
      } else {
        setUpload({ phase: "error", filename, message: errorMessage(err) });
      }
      onAssetsChanged();
      return false;
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // so picking the same file again fires a change
    if (file) void start(file, "file");
  };

  const percent =
    upload.phase === "uploading" && upload.total > 0 ? Math.min(100, (upload.sent / upload.total) * 100) : 0;

  return (
    <Card component="section" aria-labelledby="add-video-title">
      <CardContent sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2, p: { xs: 2, sm: 3 } }}>
        <Box>
          <Typography id="add-video-title" variant="h5" component="h3">
            Add video
          </Typography>
          <Typography color="text.secondary">
            The video goes straight from this browser to storage. Frames are then sampled from it, and
            near-duplicate and blurry frames are dropped.
          </Typography>
        </Box>

        <Box component="section" aria-labelledby="add-file-title" sx={{ display: "grid", gap: 1 }}>
          <Typography id="add-file-title" variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
            From a file
          </Typography>
          <input
            ref={inputRef}
            id="video-file-input"
            type="file"
            accept="video/mp4,video/*"
            hidden
            onChange={onPick}
          />
          <Stack direction="row" useFlexGap spacing={1.5} sx={{ flexWrap: "wrap", rowGap: 1.5, alignItems: "center" }}>
            <Button
              variant="contained"
              startIcon={<VideoFileOutlinedIcon />}
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              Choose a video
            </Button>
          </Stack>
        </Box>

        <Divider />

        <Box component="section" aria-labelledby="add-camera-title" sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 1, minWidth: 0 }}>
          <Typography id="add-camera-title" variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
            From a camera
          </Typography>
          <Typography color="text.secondary">
            The recording is made in this browser, from a camera attached to this computer. It is sent to the cloud
            only after you stop and choose to upload it; this is not a live stream.
          </Typography>
          <CameraRecorder disabled={busy} maxUploadBytes={maxUploadBytes} onUpload={(file) => start(file, "camera")} />
        </Box>

        <Box aria-live="polite" sx={{ display: "grid", gap: 1 }}>
          {upload.phase === "requesting" && (
            <Box>
              <Typography sx={{ overflowWrap: "anywhere" }}>Preparing to upload {upload.filename}…</Typography>
              <LinearProgress aria-label="Preparing the upload" sx={{ mt: 1, height: 8, borderRadius: "4px" }} />
            </Box>
          )}
          {upload.phase === "uploading" && (
            <Box>
              <Typography sx={{ overflowWrap: "anywhere" }}>Uploading {upload.filename}</Typography>
              <LinearProgress
                variant="determinate"
                value={percent}
                aria-label={`Uploading ${upload.filename}`}
                sx={{ mt: 1, height: 8, borderRadius: "4px" }}
              />
              <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 1.5 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {formatBytes(upload.sent)} of {formatBytes(upload.total)} · {Math.floor(percent)}%
                </Typography>
                <Button onClick={() => handleRef.current?.abort()}>Cancel upload</Button>
              </Box>
            </Box>
          )}
          {upload.phase === "completing" && (
            <Box>
              <Typography sx={{ overflowWrap: "anywhere" }}>
                {upload.filename} is uploaded. Starting frame extraction…
              </Typography>
              <LinearProgress aria-label="Starting frame extraction" sx={{ mt: 1, height: 8, borderRadius: "4px" }} />
            </Box>
          )}
          {upload.phase === "done" && (
            <Alert severity="success" sx={{ overflowWrap: "anywhere" }}>
              {upload.filename} is uploaded. Frame extraction progress is shown under Videos below.
            </Alert>
          )}
          {upload.phase === "cancelled" && (
            <Alert severity="info" sx={{ overflowWrap: "anywhere" }}>
              The upload of {upload.filename} was cancelled. Nothing was extracted from it.
            </Alert>
          )}
          {upload.phase === "error" && (
            <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
              {upload.filename} was not added: {upload.message}
            </Alert>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}
