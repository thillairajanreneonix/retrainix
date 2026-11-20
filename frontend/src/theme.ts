import { createTheme } from "@mui/material/styles";

/**
 * The one design system of the app. Every colour, radius and size a screen needs is a token
 * here, and the MUI theme below is built from them - screens read `rx` or the theme, they do
 * not write their own hex values. (Annotation overlay colours are the exception: they tell
 * classes apart and live with the review dialog.)
 *
 * Two palettes with the same keys are kept, because the team moved between them on 20 Nov
 * 2026. `ACTIVE` picks one; nothing else needs to change to switch.
 *   template - the UI master template: charcoal chrome, bright orange accent, light page.
 *   reneonix - the camera dashboard's dark theme with the green of the Reneonix mark.
 */
const TEMPLATE = {
  mode: "light",
  accent: "#FF6801", // fills: the main action, the current step, progress
  accentHover: "#EA5D00",
  accentPressed: "#D65100",
  accentSoft: "#FFF0E5",
  accentTrack: "#FFE4D1",
  accentInk: "#B54700", // accent-coloured TEXT and the focus ring: bright orange fails contrast as text
  onAccent: "#18181A", // text on an accent fill
  chartLine: "#EA5D00", // the accent a shade down: keeps a 3:1 contrast on the white card
  chrome: "#18181A", // top bar and navigation rail
  chromeHover: "#29292D",
  chromeText: "#F4F4F5",
  chromeMuted: "#A1A1AA",
  chromeBorder: "#2E2E33",
  canvas: "#FAFAFA",
  surface: "#FFFFFF",
  surfaceSubtle: "#F7F7F8",
  surfaceRaised: "#FFFFFF", // inputs, secondary buttons, menus
  hover: "#F4F4F5",
  hoverOverlay: "rgb(24 24 26 / 4%)",
  hoverOverlayStrong: "rgb(24 24 26 / 6%)",
  border: "#E7E7EB",
  borderStrong: "#D3D3DA",
  text: "#27272F",
  muted: "#62626B",
  disabledBg: "#EDEDF0",
  disabledText: "#74747D",
  neutralSoft: "#F0F0F3",
  neutralInk: "#50505A",
  success: "#18794E",
  successSoft: "#EAF6EF",
  successBorder: "#BFE3CF",
  warning: "#945400",
  warningSoft: "#FFF5DF",
  warningBorder: "#F1D9A5",
  error: "#B42318",
  errorSoft: "#FFF0EF",
  errorBorder: "#F2B8B5",
  onStatus: "#FFFFFF", // text on a solid success / warning / error fill
  switchTrack: "#A9A9B2",
  linkUnderline: "rgb(181 71 0 / 45%)",
  tooltipBg: "#18181A",
  tooltipText: "#FFFFFF",
  tooltipBorder: "#18181A",
  annotationSurface: "#232326", // the ground behind a frame that is being annotated or recorded
  annotationBorder: "#37373D",
  shadow: "0 1px 3px rgb(24 24 26 / 4%)",
  popShadow: "0 8px 24px rgb(24 24 26 / 10%)",
  logoFilter: "brightness(0) invert(1)", // the wordmark in white on the charcoal rail
} as const;

type Palette = { [K in keyof typeof TEMPLATE]: string };

const RENEONIX: Palette = {
  mode: "dark",
  accent: "#B1DE39",
  accentHover: "#8FB92C",
  accentPressed: "#7DA526",
  accentSoft: "#252F0F",
  accentTrack: "#2C3814",
  accentInk: "#C8EA6E",
  onAccent: "#0B0E09",
  chartLine: "#B1DE39",
  chrome: "#161A13",
  chromeHover: "#262D20",
  chromeText: "#E6EDE0",
  chromeMuted: "#93A089",
  chromeBorder: "#2A3124",
  canvas: "#0E110C",
  surface: "#161A13",
  surfaceSubtle: "#1A1F16",
  surfaceRaised: "#1E2419",
  hover: "#262D20",
  hoverOverlay: "rgb(230 237 224 / 6%)",
  hoverOverlayStrong: "rgb(230 237 224 / 8%)",
  border: "#2A3124",
  borderStrong: "#3A4431",
  text: "#E6EDE0",
  muted: "#93A089",
  disabledBg: "#1E2419",
  disabledText: "#6B7762",
  neutralSoft: "#222920",
  neutralInk: "#B7C2AE",
  success: "#8FD694",
  successSoft: "#162A1A",
  successBorder: "#2B4A30",
  warning: "#E3B341",
  warningSoft: "#2B2410",
  warningBorder: "#4D4019",
  error: "#F2707A",
  errorSoft: "#2A1416",
  errorBorder: "#5A2A2E",
  onStatus: "#0B0E09",
  switchTrack: "#3A4431",
  linkUnderline: "rgb(200 234 110 / 45%)",
  tooltipBg: "#1E2419",
  tooltipText: "#E6EDE0",
  tooltipBorder: "#3A4431",
  annotationSurface: "#000000",
  annotationBorder: "#2A3124",
  shadow: "none",
  popShadow: "0 8px 24px rgb(0 0 0 / 45%)",
  logoFilter: "none",
};

const PALETTES = { template: TEMPLATE as Palette, reneonix: RENEONIX };
const ACTIVE: keyof typeof PALETTES = "template";

export const rx = {
  ...PALETTES[ACTIVE],
  headerHeight: 64,
  railWidth: 80,
  railWidthOpen: 224,
  radius: 16,
  controlRadius: 10,
  font: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
};

const focusRing = { outline: `3px solid ${rx.accentInk}`, outlineOffset: 3 } as const;

export const theme = createTheme({
  palette: {
    mode: rx.mode === "dark" ? "dark" : "light",
    // main is the fill of the main action; dark is the accent used as TEXT on a surface.
    primary: { main: rx.accent, dark: rx.accentInk, light: rx.accentSoft, contrastText: rx.onAccent },
    secondary: { main: rx.neutralInk, contrastText: rx.onStatus },
    success: { main: rx.success, light: rx.successSoft, contrastText: rx.onStatus },
    warning: { main: rx.warning, light: rx.warningSoft, contrastText: rx.onStatus },
    error: { main: rx.error, light: rx.errorSoft, contrastText: rx.onStatus },
    info: { main: rx.neutralInk, light: rx.neutralSoft, contrastText: rx.onStatus },
    text: { primary: rx.text, secondary: rx.muted, disabled: rx.disabledText },
    background: { default: rx.canvas, paper: rx.surface },
    divider: rx.border,
    action: {
      active: rx.text,
      hover: rx.hoverOverlay,
      selected: rx.accentSoft,
      disabledBackground: rx.disabledBg,
      disabled: rx.disabledText,
    },
  },
  shape: { borderRadius: rx.controlRadius },
  typography: {
    fontFamily: rx.font,
    fontSize: 14,
    h4: { fontSize: "1.75rem", fontWeight: 600, lineHeight: 1.2, letterSpacing: "-0.7px" }, // page title, 28 px
    h5: { fontSize: "1.125rem", fontWeight: 600, lineHeight: 1.35, letterSpacing: "-0.3px" }, // card title, 18 px
    h6: { fontSize: "1rem", fontWeight: 600, lineHeight: 1.4, letterSpacing: "-0.2px" },
    subtitle1: { fontSize: "0.9375rem", fontWeight: 600, lineHeight: 1.5 },
    subtitle2: { fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.5 },
    body1: { fontSize: "0.875rem", lineHeight: 1.5 },
    body2: { fontSize: "0.8125rem", lineHeight: 1.5 },
    caption: { fontSize: "0.75rem", lineHeight: 1.5 },
    overline: { fontSize: "0.75rem", fontWeight: 600, lineHeight: 1.5, letterSpacing: "0.6px" },
    button: { fontSize: "0.875rem", fontWeight: 600, textTransform: "none", letterSpacing: 0 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: rx.canvas, color: rx.text, WebkitFontSmoothing: "antialiased", colorScheme: rx.mode },
        "button, a, input, select, textarea, [tabindex]": { "&:focus-visible": focusRing },
        // A text field shows focus on its own border (see MuiOutlinedInput), so no second ring inside it.
        ".MuiInputBase-input:focus-visible": { outline: "none" },
        "@media (prefers-reduced-motion: reduce)": {
          "*, *::before, *::after": {
            transition: "none !important",
            animation: "none !important",
            scrollBehavior: "auto !important",
          },
        },
      },
    },
    MuiButtonBase: {
      defaultProps: { disableRipple: true },
      styleOverrides: { root: { "&.Mui-focusVisible": focusRing } },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          minHeight: 44,
          padding: "10px 16px",
          borderRadius: rx.controlRadius,
          fontWeight: 600,
          textTransform: "none",
          transition: "background-color 120ms ease, border-color 120ms ease",
          variants: [
            {
              props: { variant: "contained", color: "primary" },
              style: {
                backgroundColor: rx.accent,
                color: rx.onAccent,
                "&:hover": { backgroundColor: rx.accentHover },
                "&:active": { backgroundColor: rx.accentPressed },
              },
            },
            {
              props: { variant: "outlined" },
              style: {
                backgroundColor: rx.surfaceRaised,
                color: rx.text,
                borderColor: rx.border,
                "&:hover": { backgroundColor: rx.hover, borderColor: rx.borderStrong },
                "&:active": { backgroundColor: rx.hover },
              },
            },
            {
              props: { variant: "outlined", color: "error" },
              style: {
                color: rx.error,
                borderColor: rx.errorBorder,
                "&:hover": { backgroundColor: rx.errorSoft, borderColor: rx.errorBorder },
                "&:active": { backgroundColor: rx.errorSoft },
              },
            },
            {
              props: { variant: "text", color: "primary" },
              style: { color: rx.accentInk, "&:hover": { backgroundColor: rx.accentSoft } },
            },
            {
              props: { variant: "text", color: "inherit" },
              style: { "&:hover": { backgroundColor: rx.hoverOverlayStrong } },
            },
          ],
          "&.Mui-disabled": { backgroundColor: rx.disabledBg, color: rx.disabledText, borderColor: rx.disabledBg },
        },
        sizeSmall: { minHeight: 36, padding: "6px 12px" },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: { minWidth: 44, minHeight: 44, borderRadius: rx.controlRadius, color: rx.text, "&:hover": { backgroundColor: rx.hover } },
      },
    },
    MuiCard: {
      defaultProps: { variant: "outlined" },
      styleOverrides: {
        root: { borderRadius: rx.radius, borderColor: rx.border, boxShadow: rx.shadow, backgroundImage: "none", backgroundColor: rx.surface },
      },
    },
    MuiCardContent: {
      styleOverrides: { root: { padding: 24, "&:last-child": { paddingBottom: 24 } } },
    },
    MuiCardActionArea: {
      styleOverrides: { root: { borderRadius: rx.radius, "&:hover": { backgroundColor: rx.surfaceSubtle } }, focusHighlight: { display: "none" } },
    },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" }, outlined: { borderColor: rx.border } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: rx.radius, backgroundColor: rx.surface } } },
    MuiDialogTitle: { styleOverrides: { root: { fontSize: "1.125rem", fontWeight: 600, letterSpacing: "-0.3px" } } },
    MuiDialogActions: { styleOverrides: { root: { padding: "12px 24px 20px", gap: 4 } } },
    MuiPopover: {
      styleOverrides: { paper: { borderRadius: 12, border: `1px solid ${rx.border}`, backgroundColor: rx.surfaceRaised, boxShadow: rx.popShadow } },
    },
    MuiMenu: { styleOverrides: { paper: { backgroundColor: rx.surfaceRaised } } },
    MuiMenuItem: {
      styleOverrides: {
        root: { minHeight: 44, "&.Mui-selected, &.Mui-selected:hover": { backgroundColor: rx.accentSoft } },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          fontWeight: 500,
          fontSize: "0.75rem",
          variants: [
            { props: { variant: "filled", color: "default" }, style: { backgroundColor: rx.neutralSoft, color: rx.neutralInk } },
            { props: { variant: "filled", color: "primary" }, style: { backgroundColor: rx.accentSoft, color: rx.accentInk } },
            { props: { variant: "filled", color: "success" }, style: { backgroundColor: rx.successSoft, color: rx.success } },
            { props: { variant: "filled", color: "warning" }, style: { backgroundColor: rx.warningSoft, color: rx.warning } },
            { props: { variant: "filled", color: "error" }, style: { backgroundColor: rx.errorSoft, color: rx.error } },
            { props: { variant: "filled", color: "info" }, style: { backgroundColor: rx.neutralSoft, color: rx.neutralInk } },
            { props: { variant: "outlined", color: "default" }, style: { borderColor: rx.borderStrong, color: rx.text } },
            { props: { variant: "outlined", color: "primary" }, style: { borderColor: rx.accentInk, color: rx.accentInk } },
          ],
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          border: "1px solid",
          color: rx.text,
          alignItems: "flex-start",
          variants: [
            { props: { severity: "error" }, style: { backgroundColor: rx.errorSoft, borderColor: rx.errorBorder, "& .MuiAlert-icon": { color: rx.error } } },
            { props: { severity: "warning" }, style: { backgroundColor: rx.warningSoft, borderColor: rx.warningBorder, "& .MuiAlert-icon": { color: rx.warning } } },
            { props: { severity: "success" }, style: { backgroundColor: rx.successSoft, borderColor: rx.successBorder, "& .MuiAlert-icon": { color: rx.success } } },
            { props: { severity: "info" }, style: { backgroundColor: rx.surfaceSubtle, borderColor: rx.border, "& .MuiAlert-icon": { color: rx.neutralInk } } },
          ],
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { height: 8, borderRadius: 999, backgroundColor: rx.accentTrack },
        bar: { borderRadius: 999, backgroundColor: rx.accent },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: rx.controlRadius,
          backgroundColor: rx.surfaceRaised,
          minHeight: 44,
          "& .MuiOutlinedInput-notchedOutline": { borderColor: rx.borderStrong },
          "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: rx.muted },
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: rx.accentInk, borderWidth: 2 },
          "&.Mui-error .MuiOutlinedInput-notchedOutline": { borderColor: rx.error },
        },
        input: { padding: "10.5px 12px" },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: { color: rx.muted, "&.Mui-focused": { color: rx.accentInk }, "&.Mui-error": { color: rx.error } },
        outlined: { transform: "translate(12px, 11px) scale(1)", "&.MuiInputLabel-shrink": { transform: "translate(14px, -9px) scale(0.86)" } },
      },
    },
    MuiFormHelperText: { styleOverrides: { root: { marginLeft: 2, fontSize: "0.75rem", color: rx.muted } } },
    MuiLink: { styleOverrides: { root: { color: rx.accentInk, textDecorationColor: rx.linkUnderline, fontWeight: 500 } } },
    MuiTabs: { styleOverrides: { indicator: { height: 3, borderRadius: 3, backgroundColor: rx.accent } } },
    MuiTab: {
      styleOverrides: {
        root: { minHeight: 44, textTransform: "none", fontWeight: 500, color: rx.muted, "&.Mui-selected": { color: rx.accentInk, fontWeight: 600 } },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          minHeight: 44,
          textTransform: "none",
          fontWeight: 600,
          color: rx.text,
          borderColor: rx.border,
          backgroundColor: rx.surfaceRaised,
          "&.Mui-selected, &.Mui-selected:hover": { backgroundColor: rx.accentSoft, color: rx.accentInk, borderColor: rx.accentInk },
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          "&.Mui-checked": { color: rx.accent },
          "&.Mui-checked + .MuiSwitch-track": { backgroundColor: rx.accentInk, opacity: 0.55 },
        },
        track: { backgroundColor: rx.switchTrack, opacity: 1 },
      },
    },
    MuiTooltip: {
      defaultProps: { arrow: true },
      styleOverrides: {
        tooltip: { backgroundColor: rx.tooltipBg, color: rx.tooltipText, border: `1px solid ${rx.tooltipBorder}`, fontSize: "0.75rem", fontWeight: 500, borderRadius: 8, padding: "6px 10px" },
        arrow: { color: rx.tooltipBg },
      },
    },
    MuiTableContainer: { styleOverrides: { root: { border: `1px solid ${rx.border}`, borderRadius: 12, backgroundColor: rx.surface } } },
    MuiTableCell: {
      styleOverrides: {
        root: { padding: "14px 16px", borderBottomColor: rx.border, fontSize: "0.875rem" },
        head: { backgroundColor: rx.surfaceSubtle, color: rx.muted, fontSize: "0.75rem", fontWeight: 600 },
      },
    },
    MuiTableRow: { styleOverrides: { root: { "&:last-child td": { borderBottom: 0 } } } },
    MuiBadge: { styleOverrides: { badge: { fontWeight: 600 } } },
    MuiDivider: { styleOverrides: { root: { borderColor: rx.border } } },
    MuiDrawer: { styleOverrides: { paper: { backgroundImage: "none" } } },
  },
});
