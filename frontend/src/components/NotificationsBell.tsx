import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Box, Chip, IconButton, Popover, Typography } from "@mui/material";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";
import { api, errorMessage, type EventType, type ProjectEvent } from "../api";
import { formatDate, formatRelative, humanise } from "../format";
import { JOB_FINISHED_EVENT } from "../hooks";
import { ErrorRow, LoadingRow } from "./States";

const UNREAD_POLL_MS = 30_000;
const SHOWN = 20;

const TYPE_WORDS: Record<EventType, { label: string; colour: "default" | "success" | "warning" | "error" | "info" }> = {
  dataset_ready: { label: "Dataset ready", colour: "info" },
  training_done: { label: "Training done", colour: "success" },
  needs_human_review: { label: "Needs a person", colour: "warning" },
  pipeline_failed: { label: "Failed", colour: "error" },
};

type List =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; events: ProjectEvent[]; wasUnread: Set<string> };

/**
 * The project's notifications. The badge is the unread count, re-read every 30 seconds and
 * whenever a job finishes. Opening the list marks the unread ones it shows as read.
 */
export default function NotificationsBell({ pid }: { pid: string }) {
  const [unread, setUnread] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [list, setList] = useState<List>({ status: "idle" });
  const alive = useRef(true);

  const refreshUnread = useCallback(() => {
    api.listEvents(pid, { unread: true }).then(
      (events) => {
        if (alive.current) setUnread(events.length);
      },
      () => {
        /* a failed background check keeps the last count; opening the list reports errors */
      },
    );
  }, [pid]);

  useEffect(() => {
    alive.current = true;
    setUnread(null);
    setList({ status: "idle" });
    refreshUnread();
    const timer = window.setInterval(refreshUnread, UNREAD_POLL_MS);
    window.addEventListener(JOB_FINISHED_EVENT, refreshUnread);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener(JOB_FINISHED_EVENT, refreshUnread);
    };
  }, [pid, refreshUnread]);

  const loadList = useCallback(async () => {
    setList({ status: "loading" });
    try {
      const events = (await api.listEvents(pid)).slice(0, SHOWN);
      if (!alive.current) return;
      const toMark = events.filter((e) => !e.read);
      setList({ status: "ready", events, wasUnread: new Set(toMark.map((e) => e.id)) });
      // Seeing them is reading them. A failed mark only means the badge stays until next time.
      await Promise.allSettled(toMark.map((e) => api.markEventRead(pid, e.id)));
      if (alive.current) refreshUnread();
    } catch (err) {
      if (alive.current) setList({ status: "error", message: errorMessage(err) });
    }
  }, [pid, refreshUnread]);

  const open = Boolean(anchor);
  const count = unread ?? 0;

  return (
    <>
      <IconButton
        size="large"
        aria-label={
          unread === null ? "Notifications" : count === 0 ? "Notifications, none unread" : `Notifications, ${count} unread`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          setAnchor(e.currentTarget);
          void loadList();
        }}
      >
        <Badge badgeContent={count} color="error" max={99}>
          <NotificationsNoneIcon />
        </Badge>
      </IconButton>

      <Popover
        open={open}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            role: "dialog",
            "aria-label": "Notifications",
            sx: { width: 380, maxWidth: "calc(100vw - 32px)", maxHeight: "min(70vh, 560px)", p: 2 },
          },
        }}
      >
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
          Notifications
        </Typography>
        {list.status === "loading" && <LoadingRow label="Loading notifications…" />}
        {list.status === "error" && (
          <ErrorRow what="The notifications could not be loaded" message={list.message} onRetry={() => void loadList()} />
        )}
        {list.status === "ready" && list.events.length === 0 && (
          <Typography color="text.secondary">
            Nothing yet. You are told here when a dataset is ready, a training run finishes, frames need a person, or
            a step fails.
          </Typography>
        )}
        {list.status === "ready" && list.events.length > 0 && (
          <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 1 }}>
            {list.events.map((e) => {
              const type = TYPE_WORDS[e.type] ?? { label: humanise(e.type), colour: "default" as const };
              const isNew = list.wasUnread.has(e.id);
              return (
                <Box
                  component="li"
                  key={e.id}
                  sx={{ borderTop: "1px solid", borderColor: "divider", pt: 1, display: "grid", gap: 0.5 }}
                >
                  <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75 }}>
                    <Chip size="small" variant="outlined" color={type.colour} label={type.label} />
                    {isNew && <Chip size="small" color="primary" label="New" />}
                    <Typography variant="body2" color="text.secondary">
                      <time dateTime={e.created_at} title={formatDate(e.created_at)}>
                        {formatRelative(e.created_at)}
                      </time>
                    </Typography>
                  </Box>
                  <Typography sx={{ overflowWrap: "anywhere", fontWeight: isNew ? 500 : 400 }}>{e.message}</Typography>
                </Box>
              );
            })}
          </Box>
        )}
      </Popover>
    </>
  );
}
