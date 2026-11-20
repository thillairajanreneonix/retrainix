// Display helpers. Nothing here invents a value: unknown input is shown as it arrived.

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const integer = new Intl.NumberFormat();

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
}

export function formatCount(n: number): string {
  return integer.format(n);
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1000;
    unit += 1;
  } while (value >= 1000 && unit < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Seconds into the video as m:ss (or m:ss.s when the sample point is not a whole second). */
export function formatTimestamp(seconds: number): string {
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  const tenths = Math.round((seconds - whole) * 10);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  return tenths > 0 && tenths < 10 ? `${base}.${tenths}` : base;
}

/** "data_uploaded" -> "Data uploaded". The wording is the API's own state name. */
export function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/**
 * Names in the project's own class order (their index in project.classes); names the project
 * does not have come last, alphabetically. Maps from the API carry no key order of their own.
 */
export function inClassOrder(names: string[], classes: string[]): string[] {
  const rank = (n: string) => {
    const i = classes.indexOf(n);
    return i >= 0 ? i : classes.length;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** A share between 0 and 1, shown as the API gave it, to two decimals. */
export function formatShare(value: number): string {
  return value.toFixed(2);
}

/** Reads a finite number out of an untyped job result. */
export function readNumber(source: unknown, key: string): number | null {
  if (!source || typeof source !== "object") return null;
  const v = (source as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "5 minutes ago", "yesterday". Falls back to the raw text when it is not a date. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const seconds = Math.round((t - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86400), "day");
}

// Every export is COCO segmentation now. "yolo_txt" is kept only so a dataset version that was
// exported before the change still reads as what it is, instead of as a raw id.
const FORMAT_NAMES: Record<string, string> = { coco_json: "COCO segmentation JSON", yolo_txt: "YOLO txt" };
export function datasetFormatName(format: string): string {
  return FORMAT_NAMES[format] ?? format;
}

type FrameCounts = { frames?: number; predicted?: number; gold_exemplar?: number; gold_holdout?: number } | null | undefined;

/**
 * Frames the project holds, the gold ones included. `counts.frames` alone is not that number:
 * at a gold freeze the gold frames leave `counts.frames` and `counts.predicted` (docs/api.md).
 */
export function framesInProject(counts: FrameCounts): number {
  return (counts?.frames ?? 0) + (counts?.gold_exemplar ?? 0) + (counts?.gold_holdout ?? 0);
}

/** Frames that carry labels: the ones the model has labelled, plus the gold ones (labels a person checked). */
export function framesWithLabels(counts: FrameCounts): number {
  return Math.min(counts?.predicted ?? 0, counts?.frames ?? 0) + (counts?.gold_exemplar ?? 0) + (counts?.gold_holdout ?? 0);
}
