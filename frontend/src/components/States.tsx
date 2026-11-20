import type { ReactNode } from "react";
import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";

/** Inline "something is loading" row. Announced politely to screen readers. */
export function LoadingRow({ label }: { label: string }) {
  return (
    <Stack direction="row" useFlexGap spacing={2} role="status" aria-live="polite" sx={{ alignItems: "center", py: 2 }}>
      <CircularProgress size={20} aria-hidden />
      <Typography color="text.secondary">{label}</Typography>
    </Stack>
  );
}

/** A failed load, with the API's own message and a way to try again. */
export function ErrorRow({ what, message, onRetry }: { what: string; message: string; onRetry?: () => void }) {
  return (
    <Alert
      severity="error"
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {what}: {message}
    </Alert>
  );
}

/** Designed empty state: an icon, what will appear here, and what to do first. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Box
      sx={{
        border: "1px dashed",
        borderColor: "divider",
        borderRadius: "16px",
        bgcolor: "background.paper",
        px: { xs: 2, sm: 4 },
        py: { xs: 4, sm: 5 },
        textAlign: "center",
      }}
    >
      <Box
        aria-hidden
        sx={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          bgcolor: "primary.light",
          color: "primary.dark",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          mb: 2,
        }}
      >
        {icon}
      </Box>
      <Typography variant="h6" component="h3" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 520, mx: "auto" }}>
        {children}
      </Typography>
      {action ? <Box sx={{ mt: 3 }}>{action}</Box> : null}
    </Box>
  );
}
