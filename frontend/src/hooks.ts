import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { api, errorMessage, isJobActive, type Job, type JobType } from "./api";

export type Load<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

/**
 * Loads one thing from the API. `reload()` re-reads it; data already on screen stays there
 * while the re-read is in flight, so a refresh never blanks a list.
 */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const run = useCallback((showSpinner: boolean) => {
    const mine = ++generation.current;
    if (showSpinner) setState({ status: "loading" });
    loadRef.current().then(
      (data) => {
        if (generation.current === mine) setState({ status: "ready", data });
      },
      (err: unknown) => {
        if (generation.current !== mine) return;
        // A failed background re-read must not blank a page that is showing data (and, with it,
        // unmount things like an un-uploaded camera recording). A first load still reports it.
        setState((prev) =>
          !showSpinner && prev.status === "ready" ? prev : { status: "error", message: errorMessage(err) },
        );
      },
    );
  }, []);

  useEffect(() => {
    run(true);
    return () => {
      generation.current += 1; // drop answers that arrive after the inputs changed
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => {
    setState((prev) => (prev.status === "error" ? { status: "loading" } : prev));
    run(false);
  }, [run]);

  return [state, reload];
}

const POLL_MS = 2000; // docs/api.md: re-read a job every 2 seconds while queued or running

/** Fired on window whenever a polled job reaches a final state; the notification bell listens. */
export const JOB_FINISHED_EVENT = "retrainix:job-finished";
export function announceJobFinished(): void {
  window.dispatchEvent(new Event(JOB_FINISHED_EVENT));
}

/**
 * Re-reads `job` every 2 seconds while it is queued or running and hands each answer to
 * `onUpdate` (which should store it, so polling stops once the job is finished).
 * Returns the message of the last failed poll, or null.
 */
export function useJobPolling(pid: string, job: Job | null, onUpdate: (job: Job) => void): string | null {
  const [pollError, setPollError] = useState<string | null>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const jid = job?.id ?? null;
  const active = job !== null && isJobActive(job);

  useEffect(() => {
    setPollError(null);
    if (!jid || !active) return;
    let stopped = false;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      api
        .getJob(pid, jid)
        .then(
          (next) => {
            if (stopped) return;
            setPollError(null);
            if (!isJobActive(next)) announceJobFinished();
            onUpdateRef.current(next);
          },
          (err: unknown) => {
            if (!stopped) setPollError(errorMessage(err));
          },
        )
        .finally(() => {
          inFlight = false;
        });
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pid, jid, active]);

  return pollError;
}

const NO_PARAMS: Record<string, unknown> = {};

export type StepAsk =
  | { phase: "idle" }
  | { phase: "estimating" }
  | { phase: "confirm"; estimate: Record<string, unknown> }
  | { phase: "starting"; estimate: Record<string, unknown> | null }
  | { phase: "error"; message: string };

/**
 * One pipeline step that runs as a job of `type`: finds the newest real run (so progress and
 * the result survive a reload), polls it, and starts new ones - optionally through a dry run
 * whose `result.estimate` is shown for confirmation first. A refused start (409) ends in
 * `ask.phase === "error"` with the API's own message.
 */
export function useStepJob(
  pid: string,
  type: JobType,
  onChanged: () => void,
  params: Record<string, unknown> = NO_PARAMS,
) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [history, reloadHistory] = useLoad(
    async () => (await api.listJobs(pid, { type })).find((j) => !j.dry_run) ?? null,
    [pid, type],
  );
  const [started, setStarted] = useState<Job | null>(null);
  const job = started ?? (history.status === "ready" ? history.data : null);
  const [ask, setAsk] = useState<StepAsk>({ phase: "idle" });

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const onUpdate = useCallback((next: Job) => {
    setStarted(next);
    if (!isJobActive(next)) onChangedRef.current();
  }, []);
  const pollError = useJobPolling(pid, job, onUpdate);

  /** POSTs a dry run, re-reads it until it has finished, then asks for confirmation. */
  const requestEstimate = useCallback(async () => {
    setAsk({ phase: "estimating" });
    try {
      let dry = await api.createJob(pid, { type, dry_run: true, params: paramsRef.current });
      while (isJobActive(dry)) {
        await new Promise((r) => window.setTimeout(r, POLL_MS));
        if (!alive.current) return;
        dry = await api.getJob(pid, dry.id);
      }
      if (!alive.current) return;
      if (dry.status !== "succeeded") {
        setAsk({ phase: "error", message: dry.error ?? "The estimate did not finish, and gave no reason." });
        return;
      }
      const estimate = dry.result?.estimate;
      if (!estimate || typeof estimate !== "object") {
        setAsk({ phase: "error", message: "The API returned no estimate, so nothing was started." });
        return;
      }
      setAsk({ phase: "confirm", estimate: estimate as Record<string, unknown> });
    } catch (err) {
      if (alive.current) setAsk({ phase: "error", message: errorMessage(err) });
    }
  }, [pid, type]);

  /** Starts the real job. Pass the confirmed estimate, or null for a step with no dry run. */
  const start = useCallback(
    async (estimate: Record<string, unknown> | null) => {
      setAsk({ phase: "starting", estimate });
      try {
        const real = await api.createJob(pid, { type, dry_run: false, params: paramsRef.current });
        if (!alive.current) return;
        setStarted(real);
        setAsk({ phase: "idle" });
        onChangedRef.current();
      } catch (err) {
        if (alive.current) setAsk({ phase: "error", message: errorMessage(err) });
      }
    },
    [pid, type],
  );

  const dismiss = useCallback(() => setAsk({ phase: "idle" }), []);

  return {
    job,
    active: job !== null && isJobActive(job),
    busy: ask.phase === "estimating" || ask.phase === "starting",
    history,
    reloadHistory,
    ask,
    pollError,
    requestEstimate,
    start,
    dismiss,
  };
}

/** The pixel width of an element, kept current, so an SVG can be drawn at its real size. */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(el.clientWidth);
    observer.current = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setWidth(Math.round(w));
    });
    observer.current.observe(el);
  }, []);
  return [ref, width];
}
