import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Box, Card, CardContent, Link, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckIcon from "@mui/icons-material/Check";
import { rx } from "../theme";

/**
 * The small set of layout pieces every screen shares. Buttons, inputs, dialogs, tables and
 * cards are MUI components styled once in theme.ts; the loading, error and empty states are
 * in States.tsx. Nothing here fetches data.
 */

/** Title block at the top of a screen: where you are, what it is for, and its one main action. */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  back,
  actions,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { to: string; label: string };
  actions?: ReactNode;
  children?: ReactNode; // badges or chips that belong with the title
}) {
  return (
    <Box component="header" sx={{ display: "grid", gap: 1 }}>
      {back && (
        <Link
          component={RouterLink}
          to={back.to}
          underline="hover"
          sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, minHeight: 44, justifySelf: "start" }}
        >
          <ArrowBackIcon fontSize="small" aria-hidden />
          {back.label}
        </Link>
      )}
      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", md: "row" },
          alignItems: { xs: "stretch", md: "flex-start" },
          justifyContent: "space-between",
          gap: { xs: 2, md: 3 },
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          {eyebrow && (
            <Typography variant="overline" sx={{ color: "primary.dark", display: "block" }}>
              {eyebrow}
            </Typography>
          )}
          <Typography variant="h4" component="h2" sx={{ overflowWrap: "anywhere" }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 760 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {actions && (
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5, flexShrink: 0 }}>{actions}</Box>
        )}
      </Box>
      {children}
    </Box>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "error";

const TONES: Record<Tone, { bg: string; ink: string }> = {
  neutral: { bg: rx.neutralSoft, ink: rx.neutralInk },
  accent: { bg: rx.accentSoft, ink: rx.accentInk },
  success: { bg: rx.successSoft, ink: rx.success },
  warning: { bg: rx.warningSoft, ink: rx.warning },
  error: { bg: rx.errorSoft, ink: rx.error },
};

/** A status in words, with a colour that agrees with the words. Never colour alone. */
export function StatusBadge({ tone = "neutral", icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  const t = TONES[tone];
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        px: 1.25,
        py: 0.5,
        borderRadius: 999,
        bgcolor: t.bg,
        color: t.ink,
        fontSize: "0.75rem",
        fontWeight: 500,
        lineHeight: 1.5,
        maxWidth: "100%",
        overflowWrap: "anywhere",
        "& svg": { fontSize: 16 },
      }}
    >
      {icon}
      {children}
    </Box>
  );
}

/** One number the API really returned. A missing value is an em dash, never a zero. */
export function MetricCard({ label, value, hint }: { label: string; value: string | null; hint?: ReactNode }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent sx={{ display: "grid", gap: 0.5, p: { xs: 2, sm: 3 } }}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Typography
          component="p"
          sx={{ fontSize: "2.125rem", fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: "tabular-nums", m: 0 }}
        >
          {value ?? "—"}
        </Typography>
        {hint && (
          <Typography variant="body2" color="text.secondary">
            {hint}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export type WorkflowStep = {
  n: number;
  label: string;
  state: "done" | "current" | "waiting";
  href: string; // "#id" of the card for this step
  note: string; // one short line of real status
};

const STATE_WORD = { done: "Done", current: "Now", waiting: "Waiting" } as const;

/** The steps of a fixed sequence, where each stands, and a jump to each step's card. */
export function WorkflowStepper({ label, steps }: { label: string; steps: WorkflowStep[] }) {
  return (
    <Box component="nav" aria-label={label}>
      <Box
        component="ol"
        sx={{
          listStyle: "none",
          p: 0,
          m: 0,
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(3, minmax(0, 1fr))", lg: "repeat(6, minmax(0, 1fr))" },
        }}
      >
        {steps.map((s) => {
          const current = s.state === "current";
          const done = s.state === "done";
          return (
            <li key={s.n}>
              <Box
                component="a"
                href={s.href}
                aria-current={current ? "step" : undefined}
                sx={{
                  display: "grid",
                  gap: 0.5,
                  height: "100%",
                  minHeight: 44,
                  p: 1.5,
                  borderRadius: "12px",
                  border: "1px solid",
                  borderColor: current ? rx.accentInk : rx.border,
                  bgcolor: current ? rx.accentSoft : rx.surface,
                  color: rx.text,
                  textDecoration: "none",
                  "&:hover": { borderColor: current ? rx.accentInk : rx.borderStrong },
                }}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Box
                    aria-hidden
                    sx={{
                      width: 24,
                      height: 24,
                      flexShrink: 0,
                      borderRadius: "50%",
                      display: "grid",
                      placeItems: "center",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      bgcolor: current ? rx.accent : done ? rx.successSoft : rx.neutralSoft,
                      color: current ? rx.onAccent : done ? rx.success : rx.neutralInk,
                    }}
                  >
                    {done ? <CheckIcon sx={{ fontSize: 16 }} /> : s.n}
                  </Box>
                  <Typography
                    component="span"
                    sx={{ fontSize: "0.75rem", fontWeight: 600, color: current ? rx.accentInk : done ? rx.success : rx.muted }}
                  >
                    {STATE_WORD[s.state]}
                  </Typography>
                </Box>
                <Typography component="span" sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                  {s.label}
                </Typography>
                <Typography component="span" variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                  {s.note}
                </Typography>
              </Box>
            </li>
          );
        })}
      </Box>
    </Box>
  );
}
