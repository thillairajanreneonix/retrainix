import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, ButtonBase, Chip, CircularProgress, Tab, Tabs, Typography } from "@mui/material";
import LabelOutlinedIcon from "@mui/icons-material/LabelOutlined";
import { api, errorMessage, type GoldStatus, type Image, type LabelStatus, type Project, type QaSummary } from "../api";
import { formatCount, formatTimestamp, plural } from "../format";
import type { Load } from "../hooks";
import FrameReviewDialog from "./FrameReviewDialog";
import OutlinesNote from "./OutlinesNote";
import { EmptyState, ErrorRow, LoadingRow } from "./States";
import { StepTitle } from "./Step";
import { rx } from "../theme";

const PAGE_SIZE = 60;
const THUMB_WIDTH = 320;

type ChipColour = "default" | "warning" | "success" | "info" | "error" | "secondary";

const FILTERS: { status: LabelStatus; label: string; colour: ChipColour; empty: string }[] = [
  {
    status: "human_review",
    label: "Needs a person",
    colour: "warning",
    empty: "No frames need a person right now. Frames that the Gemini check could not pass appear here.",
  },
  {
    status: "predicted",
    label: "Waiting for check",
    colour: "default",
    empty: "No frames are waiting. Frames the model has labelled appear here until Gemini or a person has checked them.",
  },
  { status: "passed", label: "Passed", colour: "success", empty: "No frames have passed the Gemini check yet." },
  {
    status: "human_done",
    label: "Checked by a person",
    colour: "info",
    empty: "No frames have been checked by a person yet. Open a frame and accept it or save your corrections.",
  },
  { status: "rejected", label: "Rejected", colour: "error", empty: "No frames have been rejected." },
  {
    status: "gold",
    label: "Gold",
    colour: "secondary",
    empty: "There are no gold frames yet. They appear here once the gold set is frozen in step 3.",
  },
];

function chipFor(image: Image): { label: string; colour: ChipColour } {
  if (image.label_status === "gold" || image.role !== "unlabelled") {
    if (image.role === "gold_holdout") return { label: "Gold · hold-out", colour: "secondary" };
    if (image.role === "gold_exemplar") return { label: "Gold · exemplar", colour: "secondary" };
    return { label: "Gold", colour: "secondary" };
  }
  const f = FILTERS.find((x) => x.status === image.label_status);
  return f ? { label: f.label, colour: f.colour } : { label: image.label_status, colour: "default" };
}

type Frames =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; images: Image[]; nextCursor: string | null; more: "idle" | "loading" | { error: string } };

function Tile({ pid, image, onOpen }: { pid: string; image: Image; onOpen: () => void }) {
  const at = image.timestamp_s !== null && image.timestamp_s !== undefined ? formatTimestamp(image.timestamp_s) : null;
  const objects = plural(image.object_count, "object", "objects");
  const ratio = image.width > 0 && image.height > 0 ? `${image.width} / ${image.height}` : "16 / 10";
  const chip = chipFor(image);
  const boxOnly = image.missing_outlines ?? 0;

  return (
    <ButtonBase
      onClick={onOpen}
      aria-label={`Open ${at ? `frame at ${at}` : `frame ${image.id}`}, ${objects}${boxOnly > 0 ? `, ${boxOnly} box only` : ""}, ${chip.label}`}
      sx={{
        display: "block",
        width: "100%",
        textAlign: "left",
        borderRadius: "12px",
        "&:focus-visible": { outline: "3px solid", outlineColor: "primary.dark", outlineOffset: 2 },
      }}
    >
      <Box
        component="img"
        loading="lazy"
        decoding="async"
        src={api.imageFileUrl(pid, image.id, THUMB_WIDTH)}
        alt=""
        sx={{ display: "block", width: "100%", aspectRatio: ratio, objectFit: "cover", borderRadius: "12px", bgcolor: rx.neutralSoft }}
      />
      <Typography component="span" variant="body2" sx={{ display: "block", mt: 0.5, fontWeight: 500 }}>
        {objects}
        <Box component="span" sx={{ color: "text.secondary", fontWeight: 400 }}>
          {" · "}
          {at ?? "time not recorded"}
        </Box>
      </Typography>
      {boxOnly > 0 && (
        <Typography component="span" variant="body2" color="text.secondary" sx={{ display: "block" }}>
          {formatCount(boxOnly)} box only
        </Typography>
      )}
      <Chip
        component="span"
        size="small"
        color={chip.colour}
        variant={chip.colour === "default" ? "outlined" : "filled"}
        label={chip.label}
        sx={{ mt: 0.5, maxWidth: "100%" }}
      />
    </ButtonBase>
  );
}

/**
 * Step 6: every labelled frame, filtered by where it stands, 60 at a time. A tile opens the
 * review dialog. `refreshKey` changes when a job finishes; a review updates the tile in place
 * and the list is re-read from the API when the dialog closes, so prev / next stay stable.
 */
export default function FramesBrowser({
  project,
  summary,
  gold,
  refreshKey,
  onReviewed,
  onJobChanged,
}: {
  project: Project;
  summary: Load<QaSummary>;
  gold: Load<GoldStatus>;
  refreshKey: number;
  onReviewed: () => void;
  onJobChanged: () => void; // a job started here (outlines) began or finished
}) {
  const pid = project.id;
  const s = summary.status === "ready" ? summary.data : null;

  const countFor = (status: LabelStatus): number | null => {
    const c = project.counts;
    switch (status) {
      case "human_review":
        return s?.images?.human_review ?? c?.human_review ?? null;
      case "predicted":
        return s?.images?.waiting_for_qa ?? null; // counts.predicted is cumulative, so it is not this number
      case "passed":
        return s?.images?.passed ?? c?.passed ?? null;
      case "human_done":
        return s?.images?.human_done ?? c?.human_done ?? null;
      case "rejected":
        return s?.images?.rejected ?? c?.rejected ?? null;
      case "gold":
        return gold.status === "ready"
          ? gold.data.gold_exemplar + gold.data.gold_holdout
          : c
            ? c.gold_exemplar + c.gold_holdout
            : null;
      default:
        return null;
    }
  };

  // The filter starts on "Needs a person" when it has frames, otherwise "Waiting for check".
  // It is decided once, when the summary has answered (or failed), and then belongs to the user.
  const [chosen, setChosen] = useState<LabelStatus | null>(null);
  const reviewQueue = countFor("human_review");
  useEffect(() => {
    if (chosen !== null || summary.status === "loading") return;
    setChosen((reviewQueue ?? 0) > 0 ? "human_review" : "predicted");
  }, [chosen, summary.status, reviewQueue]);

  const [frames, setFrames] = useState<Frames>({ status: "loading" });
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [localKey, setLocalKey] = useState(0);
  const reviewedSinceLoad = useRef(false);
  const generation = useRef(0);
  const loadedFor = useRef<LabelStatus | null>(null);

  const load = useCallback(
    (status: LabelStatus, showSpinner: boolean) => {
      const mine = ++generation.current;
      if (showSpinner) setFrames({ status: "loading" });
      api.listImages(pid, { status, limit: PAGE_SIZE }).then(
        (page) => {
          if (generation.current !== mine) return;
          loadedFor.current = status;
          reviewedSinceLoad.current = false;
          setFrames({ status: "ready", images: page.images, nextCursor: page.next_cursor ?? null, more: "idle" });
        },
        (err: unknown) => {
          if (generation.current !== mine) return;
          setFrames((prev) =>
            prev.status === "ready" && !showSpinner ? prev : { status: "error", message: errorMessage(err) },
          );
        },
      );
    },
    [pid],
  );

  useEffect(() => {
    if (chosen === null) return;
    load(chosen, loadedFor.current !== chosen); // spinner only when the filter changed
    return () => {
      generation.current += 1;
    };
  }, [chosen, load, refreshKey, localKey]);

  const loadMore = () => {
    if (frames.status !== "ready" || !frames.nextCursor || frames.more === "loading" || chosen === null) return;
    const mine = generation.current;
    const cursor = frames.nextCursor;
    setFrames({ ...frames, more: "loading" });
    api.listImages(pid, { status: chosen, limit: PAGE_SIZE, cursor }).then(
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

  const images = frames.status === "ready" ? frames.images : [];
  const dialogIndex = openIndex !== null && openIndex < images.length ? openIndex : null;
  const filter = FILTERS.find((f) => f.status === chosen) ?? null;

  const handleReviewed = (image: Image) => {
    reviewedSinceLoad.current = true;
    setFrames((prev) =>
      prev.status === "ready" ? { ...prev, images: prev.images.map((i) => (i.id === image.id ? image : i)) } : prev,
    );
    onReviewed();
  };
  const closeDialog = () => {
    setOpenIndex(null);
    if (reviewedSinceLoad.current) setLocalKey((k) => k + 1); // reviewed frames now leave this filter
  };

  return (
    <Box component="section" aria-labelledby="frames-browser-title">
      <StepTitle n={6} id="frames-browser-title">
        Frames
      </StepTitle>
      <Typography color="text.secondary" sx={{ mb: 1 }}>
        Open a frame to see its labels drawn over the image, and to accept, correct or reject it.
      </Typography>

      <OutlinesNote pid={pid} summary={summary} onChanged={onJobChanged} />

      {chosen === null ? (
        <LoadingRow label="Loading the frame counts…" />
      ) : (
        <>
          <Tabs
            value={chosen}
            onChange={(_, value: LabelStatus) => setChosen(value)}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            aria-label="Filter frames by status"
            sx={{ borderBottom: "1px solid", borderColor: "divider", mb: 2 }}
          >
            {FILTERS.map((f) => {
              const n = countFor(f.status);
              return (
                <Tab
                  key={f.status}
                  value={f.status}
                  id={`frames-tab-${f.status}`}
                  aria-controls="frames-panel"
                  label={n !== null ? `${f.label} (${formatCount(n)})` : f.label}
                  sx={{ textTransform: "none", minHeight: 48, fontSize: 15 }}
                />
              );
            })}
          </Tabs>

          <Box role="tabpanel" id="frames-panel" aria-labelledby={`frames-tab-${chosen}`}>
            {frames.status === "loading" && <LoadingRow label="Loading frames…" />}
            {frames.status === "error" && (
              <ErrorRow what="The frames could not be loaded" message={frames.message} onRetry={() => load(chosen, true)} />
            )}
            {frames.status === "ready" && images.length === 0 && filter && (
              <EmptyState icon={<LabelOutlinedIcon fontSize="large" />} title={`${filter.label}: no frames`}>
                {filter.empty}
              </EmptyState>
            )}
            {frames.status === "ready" && images.length > 0 && (
              <>
                <Typography variant="body2" color="text.secondary" aria-live="polite" sx={{ mb: 1 }}>
                  Showing {plural(images.length, "frame", "frames")}
                  {frames.nextCursor ? "; more can be loaded below" : ""}.
                </Typography>
                <Box
                  component="ul"
                  sx={{
                    listStyle: "none",
                    p: 0,
                    m: 0,
                    display: "grid",
                    gap: 1.5,
                    gridTemplateColumns: {
                      xs: "repeat(2, minmax(0, 1fr))",
                      sm: "repeat(auto-fill, minmax(160px, 1fr))",
                    },
                  }}
                >
                  {images.map((img, i) => (
                    <Box component="li" key={img.id} sx={{ minWidth: 0 }}>
                      <Tile pid={pid} image={img} onOpen={() => setOpenIndex(i)} />
                    </Box>
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
        </>
      )}

      {dialogIndex !== null && (
        <FrameReviewDialog
          project={project}
          images={images}
          index={dialogIndex}
          onIndexChange={setOpenIndex}
          onClose={closeDialog}
          onReviewed={handleReviewed}
        />
      )}
    </Box>
  );
}
