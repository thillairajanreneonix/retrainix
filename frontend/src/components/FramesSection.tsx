import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import PhotoLibraryOutlinedIcon from "@mui/icons-material/PhotoLibraryOutlined";
import { api, errorMessage, type Asset, type Image } from "../api";
import { formatCount, formatTimestamp, plural } from "../format";
import { EmptyState, ErrorRow, LoadingRow } from "./States";
import { rx } from "../theme";

const PAGE_SIZE = 60;
const THUMB_WIDTH = 320;

type Frames =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; images: Image[]; nextCursor: string | null; more: "idle" | "loading" | { error: string } };

function Thumbnail({ pid, image, filename }: { pid: string; image: Image; filename: string | null }) {
  const at = image.timestamp_s !== null && image.timestamp_s !== undefined ? formatTimestamp(image.timestamp_s) : null;
  const alt = at
    ? `Frame at ${at}${filename ? ` of ${filename}` : ""}`
    : `Image ${image.id}${filename ? ` from ${filename}` : ""}`;
  const ratio = image.width > 0 && image.height > 0 ? `${image.width} / ${image.height}` : "16 / 10";

  return (
    <Box component="figure" sx={{ m: 0, minWidth: 0 }}>
      <Box
        component="img"
        loading="lazy"
        decoding="async"
        src={api.imageFileUrl(pid, image.id, THUMB_WIDTH)}
        alt={alt}
        sx={{
          display: "block",
          width: "100%",
          aspectRatio: ratio,
          objectFit: "cover",
          borderRadius: "12px",
          bgcolor: rx.neutralSoft,
          color: "text.secondary",
          fontSize: 12,
        }}
      />
      <Typography component="figcaption" variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
        {at ?? "time not recorded"} ·{" "}
        {image.blur_score !== null && image.blur_score !== undefined
          ? `blur score ${image.blur_score.toFixed(1)}`
          : "blur score not recorded"}
      </Typography>
    </Box>
  );
}

/**
 * Thumbnail grid of the project's frames, 60 at a time. `total` is every frame of the project, gold ones included;
 * `refreshKey` changes whenever a job finishes, which re-reads the first page.
 */
export default function FramesSection({
  pid,
  total,
  assets,
  refreshKey,
}: {
  pid: string;
  total: number | null;
  assets: Asset[];
  refreshKey: number;
}) {
  const [frames, setFrames] = useState<Frames>({ status: "loading" });
  const generation = useRef(0);

  const loadFirst = useCallback(
    (showSpinner: boolean) => {
      const mine = ++generation.current;
      if (showSpinner) setFrames({ status: "loading" });
      api.listImages(pid, { limit: PAGE_SIZE }).then(
        (page) => {
          if (generation.current !== mine) return;
          setFrames({ status: "ready", images: page.images, nextCursor: page.next_cursor ?? null, more: "idle" });
        },
        (err: unknown) => {
          if (generation.current !== mine) return;
          // A failed background refresh leaves the frames already on screen alone.
          setFrames((prev) =>
            prev.status === "ready" && !showSpinner ? prev : { status: "error", message: errorMessage(err) },
          );
        },
      );
    },
    [pid],
  );

  const first = useRef(true);
  useEffect(() => {
    loadFirst(first.current);
    first.current = false;
    return () => {
      generation.current += 1;
    };
  }, [loadFirst, refreshKey]);

  const loadMore = () => {
    if (frames.status !== "ready" || !frames.nextCursor || frames.more === "loading") return;
    const mine = generation.current;
    const cursor = frames.nextCursor;
    setFrames({ ...frames, more: "loading" });
    api.listImages(pid, { limit: PAGE_SIZE, cursor }).then(
      (page) => {
        if (generation.current !== mine) return;
        setFrames((prev) => {
          if (prev.status !== "ready") return prev;
          const seen = new Set(prev.images.map((i) => i.id));
          return {
            status: "ready",
            images: [...prev.images, ...page.images.filter((i) => !seen.has(i.id))],
            nextCursor: page.next_cursor ?? null,
            more: "idle",
          };
        });
      },
      (err: unknown) => {
        if (generation.current !== mine) return;
        setFrames((prev) => (prev.status === "ready" ? { ...prev, more: { error: errorMessage(err) } } : prev));
      },
    );
  };

  const filenames = new Map(assets.map((a) => [a.id, a.filename]));

  return (
    <Box component="section" aria-labelledby="frames-title">
      <Stack direction="row" useFlexGap spacing={2} sx={{ alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", mb: 1.5 }}>
        <Typography id="frames-title" variant="h5" component="h3">
          Frames
        </Typography>
        <Typography color="text.secondary" aria-live="polite">
          {total !== null ? plural(total, "frame", "frames") + " in this project" : ""}
          {frames.status === "ready" && frames.images.length > 0
            ? `${total !== null ? " · " : ""}showing ${formatCount(frames.images.length)}`
            : ""}
        </Typography>
      </Stack>

      {frames.status === "loading" && <LoadingRow label="Loading frames…" />}
      {frames.status === "error" && (
        <ErrorRow what="The frames could not be loaded" message={frames.message} onRetry={() => loadFirst(true)} />
      )}
      {frames.status === "ready" && frames.images.length === 0 && (
        <EmptyState icon={<PhotoLibraryOutlinedIcon fontSize="large" />} title="No frames yet">
          Frames sampled from your videos appear here as thumbnails, each with its time in the video and its blur
          score. Add a video above; the frames show up when extraction finishes.
        </EmptyState>
      )}
      {frames.status === "ready" && frames.images.length > 0 && (
        <>
          <Box
            sx={{
              display: "grid",
              gap: 1.5,
              gridTemplateColumns: {
                xs: "repeat(2, minmax(0, 1fr))",
                sm: "repeat(auto-fill, minmax(160px, 1fr))",
              },
            }}
          >
            {frames.images.map((img) => (
              <Thumbnail key={img.id} pid={pid} image={img} filename={filenames.get(img.asset_id) ?? null} />
            ))}
          </Box>

          {typeof frames.more === "object" && (
            <Box sx={{ mt: 2 }}>
              <ErrorRow what="More frames could not be loaded" message={frames.more.error} />
            </Box>
          )}
          {frames.nextCursor && (
            <Box sx={{ mt: 2, textAlign: "center" }}>
              <Button
                variant="outlined"
                onClick={loadMore}
                disabled={frames.more === "loading"}
                startIcon={frames.more === "loading" ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
              >
                {frames.more === "loading" ? "Loading…" : "Load more"}
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
