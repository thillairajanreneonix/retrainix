import type { ReactNode } from "react";
import { Alert, Box, Card, CardContent, Link, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import type { ModelRecord } from "../api";
import { datasetFormatName } from "../format";

export const NOT_STATED = "not stated by the source";

type Field = "task" | "input_size" | "dataset_format" | "licence" | "min_gpu_memory_gb" | "source_url";

/** A field is shown only when the source states it: not null and not in unverified_fields. */
function stated(model: ModelRecord, field: Field): boolean {
  const value = model[field];
  return value !== null && value !== undefined && value !== "" && !model.unverified_fields.includes(field);
}

/** The licence text for a model, or the "not stated" wording. Used wherever a model is named. */
export function licenceText(model: ModelRecord): string {
  return stated(model, "licence") ? String(model.licence) : NOT_STATED;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Typography component="dt" variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: "anywhere" }}>
        {children}
      </Typography>
    </>
  );
}

function NotStated() {
  return (
    <Box component="span" sx={{ fontStyle: "italic", color: "text.secondary" }}>
      {NOT_STATED}
    </Box>
  );
}

/** Compact card for one catalogue model. Never fills in a value the source did not state. */
export default function ModelCard({ model, role }: { model: ModelRecord; role: string }) {
  const format = model.dataset_format ?? "";
  return (
    <Card component="section" aria-label={`${role}: ${model.name}`}>
      <CardContent sx={{ display: "grid", gap: 1.5 }}>
        <Box>
          <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>
            {role}
          </Typography>
          <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
            {model.name}
          </Typography>
        </Box>

        <Box
          component="dl"
          sx={{
            m: 0,
            display: "grid",
            gridTemplateColumns: "minmax(96px, max-content) minmax(0, 1fr)",
            columnGap: 2,
            rowGap: 0.75,
          }}
        >
          <Row label="Licence">{stated(model, "licence") ? <strong>{model.licence}</strong> : <NotStated />}</Row>
          <Row label="Task">{stated(model, "task") ? model.task : <NotStated />}</Row>
          <Row label="Input size">{stated(model, "input_size") ? `${model.input_size} px` : <NotStated />}</Row>
          <Row label="Dataset format">
            {stated(model, "dataset_format") ? datasetFormatName(format) : <NotStated />}
          </Row>
          <Row label="GPU memory">
            {stated(model, "min_gpu_memory_gb") ? `at least ${model.min_gpu_memory_gb} GB` : <NotStated />}
          </Row>
          <Row label="Source">
            {stated(model, "source_url") ? (
              <Link
                href={model.source_url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 0.5, minHeight: 44, mt: -1.25, mb: -1.25 }}
              >
                Model page
                <OpenInNewIcon fontSize="inherit" aria-hidden />
                <Box component="span" sx={visuallyHidden}>
                  (opens in a new tab)
                </Box>
              </Link>
            ) : (
              <NotStated />
            )}
          </Row>
        </Box>

        {model.licence_notice ? (
          <Alert severity="warning" sx={{ overflowWrap: "anywhere" }}>
            {model.licence_notice}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

const visuallyHidden = {
  // px strings on purpose: in sx a bare `width: 1` means 100%.
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;
