import { useState } from "react";
import { Box, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import type { ModelVersion } from "../api";
import { formatCount, formatShare, plural, readNumber } from "../format";
import { useElementWidth } from "../hooks";

export type MetricKey = "map50" | "map50_95" | "class_agreement" | "recall";

export const METRICS: { key: MetricKey; label: string }[] = [
  { key: "map50", label: "mAP50" },
  { key: "map50_95", label: "mAP50-95" },
  { key: "class_agreement", label: "Class agreement" },
  { key: "recall", label: "Recall" },
];

const HEIGHT = 300;
const M = { top: 28, right: 20, bottom: 44, left: 40 };
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const INSET = 28; // keeps the first and last points clear of the axis labels and the edge
const LINE = "#386a20"; // the theme's primary; one series, so one colour
const SURFACE = "#ffffff";
const GRID = "#e4e7df";
const INK = "#1c1c1c";
const INK_MUTED = "#5c5f58";

type Point = { version: ModelVersion; value: number; x: number; y: number; active: boolean; hollow: boolean };

/** The sentence that tells a version's dot apart without relying on how it is drawn. */
function describe(p: Point, metric: string): string {
  const bits = [`v${p.version.version}: ${metric} ${formatShare(p.value)}`];
  if (p.active) bits.push("active version");
  if (p.hollow) bits.push("not promoted");
  return bits.join(", ");
}

/**
 * One metric per model version, all scored on the same gold hold-out. Hand-written SVG drawn
 * at the container's real pixel width so the text stays readable at phone width. The same
 * numbers are in the versions table below it, which is the chart's text alternative.
 */
export default function TrendChart({
  versions,
  activeVersion,
}: {
  versions: ModelVersion[]; // oldest first
  activeVersion: number | null;
}) {
  const [metric, setMetric] = useState<MetricKey>("map50");
  const [hover, setHover] = useState<number | null>(null);
  const [wrapRef, measured] = useElementWidth<HTMLDivElement>();
  const width = Math.max(measured, 280);
  const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? metric;

  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const xAt = (i: number) =>
    versions.length === 1 ? M.left + plotW / 2 : M.left + INSET + ((plotW - 2 * INSET) * i) / (versions.length - 1);
  const yAt = (v: number) => M.top + plotH * (1 - Math.min(Math.max(v, 0), 1));

  const points: Point[] = [];
  versions.forEach((version, i) => {
    const value = readNumber(version.metrics, metric);
    if (value === null) return;
    points.push({
      version,
      value,
      x: xAt(i),
      y: yAt(value),
      active: version.version === activeVersion,
      hollow: version.promoted === false,
    });
  });

  // Label every point while there is room; otherwise only the first, the last, the active and the best.
  const slot = versions.length > 1 ? (plotW - 2 * INSET) / (versions.length - 1) : plotW;
  const best = points.reduce<Point | null>((b, p) => (b === null || p.value > b.value ? p : b), null);
  const labelled = (p: Point, i: number) =>
    slot >= 44 || i === 0 || i === points.length - 1 || p.active || p === best;

  // Counts behind the figures: the same hold-out for every version, so they should all agree.
  const scored = versions.filter((v) => readNumber(v.metrics, "n_images") !== null);
  const latest = scored[scored.length - 1] ?? null;
  const nImages = latest ? readNumber(latest.metrics, "n_images") : null;
  const nObjects = latest ? readNumber(latest.metrics, "n_objects_gold") : null;
  const sameCounts = scored.every(
    (v) => readNumber(v.metrics, "n_images") === nImages && readNumber(v.metrics, "n_objects_gold") === nObjects,
  );

  const first = points[0] ?? null;
  const last = points[points.length - 1] ?? null;
  const activePoint = points.find((p) => p.active) ?? null;
  const summary =
    first && last
      ? `${metricLabel} by model version, on a scale from 0 to 1. ${
          first === last
            ? `Only v${first.version.version} has been scored: ${formatShare(first.value)}.`
            : `First, v${first.version.version}: ${formatShare(first.value)}. Latest, v${last.version.version}: ${formatShare(last.value)}.`
        }${activePoint ? ` Active version: v${activePoint.version.version}.` : ""} The versions table below has every figure.`
      : `${metricLabel} by model version: no version has this figure yet.`;

  const hovered = hover !== null ? (points.find((p) => p.version.version === hover) ?? null) : null;

  return (
    <Box sx={{ display: "grid", gap: 1.5, minWidth: 0 }}>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={metric}
        onChange={(_, next: MetricKey | null) => next && setMetric(next)}
        aria-label="Metric to plot"
        sx={{ flexWrap: "wrap", rowGap: 0.5 }}
      >
        {METRICS.map((m) => (
          <ToggleButton key={m.key} value={m.key} sx={{ textTransform: "none", minHeight: 44, px: 1.75, color: "text.primary" }}>
            {m.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Box ref={wrapRef} sx={{ position: "relative", minWidth: 0 }}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={summary}
          style={{ display: "block", maxWidth: "100%", fontFamily: "inherit" }}
        >
          <rect x={0} y={0} width={width} height={HEIGHT} fill={SURFACE} rx={12} />

          {TICKS.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={yAt(t)} y2={yAt(t)} stroke={GRID} strokeWidth={1} />
              <text x={M.left - 8} y={yAt(t)} textAnchor="end" dominantBaseline="middle" fontSize={12} fill={INK_MUTED}>
                {t === 0 || t === 1 ? t : t.toFixed(2)}
              </text>
            </g>
          ))}

          {versions.map((v, i) => {
            const isActive = v.version === activeVersion;
            // Thin the version labels when they would collide; the active one is always named.
            const every = Math.max(1, Math.ceil(36 / Math.max(slot, 1)));
            if (!isActive && i % every !== 0 && i !== versions.length - 1) return null;
            return (
              <text key={v.version} x={xAt(i)} y={HEIGHT - M.bottom + 18} textAnchor="middle" fontSize={12} fill={INK_MUTED}>
                v{v.version}
                {isActive && (
                  <tspan x={xAt(i)} dy={14} fill={INK} fontWeight={500}>
                    active
                  </tspan>
                )}
              </text>
            );
          })}

          {points.length > 1 && (
            <polyline
              points={points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={LINE}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {points.map((p, i) => (
            <g key={p.version.version}>
              {p.active && <circle cx={p.x} cy={p.y} r={10} fill="none" stroke={LINE} strokeWidth={2} />}
              {/* 2px surface ring keeps the dot legible where it sits on the line */}
              <circle cx={p.x} cy={p.y} r={7} fill={SURFACE} />
              <circle cx={p.x} cy={p.y} r={5} fill={p.hollow ? SURFACE : LINE} stroke={LINE} strokeWidth={2} />
              {labelled(p, i) && (
                <text
                  x={p.x}
                  y={p.y - 14 < M.top - 8 ? p.y + 24 : p.y - 14}
                  textAnchor="middle"
                  fontSize={13}
                  fontWeight={500}
                  fill={INK}
                  stroke={SURFACE}
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {formatShare(p.value)}
                </text>
              )}
              {/* hit target larger than the mark; the same details show on hover and on keyboard focus */}
              <circle
                cx={p.x}
                cy={p.y}
                r={Math.max(14, Math.min(22, slot / 2))}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={describe(p, metricLabel)}
                onPointerEnter={() => setHover(p.version.version)}
                onPointerLeave={() => setHover((h) => (h === p.version.version ? null : h))}
                onFocus={() => setHover(p.version.version)}
                onBlur={() => setHover((h) => (h === p.version.version ? null : h))}
                style={{ outline: "none", cursor: "default" }}
              />
              {hover === p.version.version && (
                <circle cx={p.x} cy={p.y} r={13} fill="none" stroke={INK} strokeWidth={1} pointerEvents="none" />
              )}
            </g>
          ))}
        </svg>

        {hovered && (
          <Box
            role="status"
            sx={{
              position: "absolute",
              left: Math.min(Math.max(hovered.x - 90, 4), Math.max(width - 184, 4)),
              top: hovered.y > HEIGHT / 2 ? hovered.y - 96 : hovered.y + 20,
              width: 180,
              bgcolor: "#23261f",
              color: "#ffffff",
              borderRadius: "8px",
              px: 1.25,
              py: 1,
              pointerEvents: "none",
              fontSize: 13,
              lineHeight: 1.4,
            }}
          >
            <Box sx={{ fontWeight: 700, fontSize: 15 }}>{formatShare(hovered.value)}</Box>
            <Box>
              {metricLabel}, v{hovered.version.version}
            </Box>
            <Box sx={{ opacity: 0.85 }}>
              {[hovered.active ? "active" : null, hovered.hollow ? "not promoted" : null].filter(Boolean).join(" · ") ||
                (hovered.version.trigger === "seed" ? "starting weights" : "promoted")}
            </Box>
          </Box>
        )}
      </Box>

      <Box component="ul" aria-label="How the points are drawn" sx={{ listStyle: "none", p: 0, m: 0, display: "flex", flexWrap: "wrap", columnGap: 2.5, rowGap: 0.5 }}>
        {[
          { text: "promoted, or the starting weights", hollow: false, ring: false },
          { text: "not promoted", hollow: true, ring: false },
          { text: "active now", hollow: false, ring: true },
        ].map((k) => (
          <Box component="li" key={k.text} sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <svg width={24} height={24} aria-hidden style={{ flexShrink: 0 }}>
              {k.ring && <circle cx={12} cy={12} r={10} fill="none" stroke={LINE} strokeWidth={2} />}
              <circle cx={12} cy={12} r={5} fill={k.hollow ? SURFACE : LINE} stroke={LINE} strokeWidth={2} />
            </svg>
            <Typography variant="body2" color="text.secondary">
              {k.text}
            </Typography>
          </Box>
        ))}
      </Box>

      <Typography sx={{ overflowWrap: "anywhere" }}>
        {nImages === null
          ? "No version reports how many hold-out images it was scored on."
          : sameCounts
            ? `Scored on the gold hold-out: n = ${plural(nImages, "image", "images")}${
                nObjects !== null ? `, ${plural(nObjects, "object", "objects")}` : ""
              }. Same frames for every version.`
            : `The versions do not all report the same hold-out counts (the latest: n = ${formatCount(nImages)} images${
                nObjects !== null ? `, ${formatCount(nObjects)} objects` : ""
              }); see each version's row in the table.`}
      </Typography>
      {metric === "recall" && (
        <Typography variant="body2" color="text.secondary">
          Recall counts a box as found whatever class it was given, and the gold boxes began as a model's own
          boxes that a person then corrected. mAP50 and class agreement also need the class to be right.
        </Typography>
      )}
      {versions.length === 1 && versions[0].trigger === "seed" && (
        <Typography color="text.secondary">This is the starting model before any training.</Typography>
      )}
    </Box>
  );
}
