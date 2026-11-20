import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink, Outlet, useLocation, useMatch } from "react-router-dom";
import { Box, Drawer, IconButton, Tooltip, Typography, useMediaQuery } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import MenuOpenIcon from "@mui/icons-material/MenuOpen";
import CloseIcon from "@mui/icons-material/Close";
import GridViewOutlinedIcon from "@mui/icons-material/GridViewOutlined";
import SpaceDashboardOutlinedIcon from "@mui/icons-material/SpaceDashboardOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import ModelTrainingOutlinedIcon from "@mui/icons-material/ModelTrainingOutlined";
import { api } from "../api";
import { useLoad } from "../hooks";
import { rx } from "../theme";
import wordmark from "../assets/reneonix-wordmark-green.png";
import NotificationsBell from "./NotificationsBell";

// Below this width the rail is replaced by a menu button and a drawer.
const DESKTOP_QUERY = "(min-width:761px)";
const EXPANDED_KEY = "retrainix.nav.expanded";
const RAIL_ID = "retrainix-rail";

type Destination = {
  label: string;
  icon: ReactNode;
  to: string | null; // null = needs a project to be open
  active: boolean;
  disabledHint: string;
};

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false; // private window or blocked storage: the rail simply starts collapsed
  }
}

function writeExpanded(value: boolean): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, value ? "1" : "0");
  } catch {
    /* a remembered preference only; the shell works without it */
  }
}

const chromeFocus = { "&:focus-visible": { outline: `3px solid ${rx.accent}`, outlineOffset: 2 } } as const;

/** One destination: a link, or - while no project is open - a focusable entry that says why not. */
function NavItem({ d, showLabel, onNavigate }: { d: Destination; showLabel: boolean; onNavigate: () => void }) {
  const base = {
    display: "flex",
    alignItems: "center",
    justifyContent: showLabel ? "flex-start" : "center",
    gap: 1.5,
    width: showLabel ? "100%" : 48,
    minHeight: 48,
    px: showLabel ? 1.5 : 0,
    borderRadius: "12px",
    textDecoration: "none",
    fontWeight: 500,
    lineHeight: 1.3,
    ...chromeFocus,
  } as const;

  const text = showLabel ? (
    <Box component="span" sx={{ minWidth: 0, display: "grid" }}>
      <span>{d.label}</span>
      {!d.to && (
        <Box component="span" sx={{ fontSize: "0.75rem", fontWeight: 400 }}>
          {d.disabledHint}
        </Box>
      )}
    </Box>
  ) : null;

  const item = d.to ? (
    <Box
      component={RouterLink}
      to={d.to}
      aria-current={d.active ? "page" : undefined}
      aria-label={showLabel ? undefined : d.label}
      onClick={onNavigate}
      sx={{
        ...base,
        color: d.active ? rx.accentInk : rx.chromeText,
        bgcolor: d.active ? rx.accentSoft : "transparent",
        "&:hover": { bgcolor: d.active ? rx.accentSoft : rx.chromeHover },
      }}
    >
      {d.icon}
      {text}
    </Box>
  ) : (
    <Box
      component="span"
      role="link"
      aria-disabled="true"
      aria-label={`${d.label}: ${d.disabledHint}`}
      tabIndex={0}
      sx={{ ...base, color: rx.chromeMuted, cursor: "not-allowed" }}
    >
      {d.icon}
      {text}
    </Box>
  );

  if (showLabel) return item;
  return (
    <Tooltip title={d.to ? d.label : `${d.label}: ${d.disabledHint}`} placement="right">
      {item}
    </Tooltip>
  );
}

function NavList({ destinations, showLabel, onNavigate }: { destinations: Destination[]; showLabel: boolean; onNavigate: () => void }) {
  return (
    <Box
      component="ul"
      sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 1.5, justifyItems: showLabel ? "stretch" : "center" }}
    >
      {destinations.map((d) => (
        <li key={d.label}>
          <NavItem d={d} showLabel={showLabel} onNavigate={onNavigate} />
        </li>
      ))}
    </Box>
  );
}

function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <Box
      component={RouterLink}
      to="/"
      aria-label="Retrainix, dashboard"
      onClick={onClick}
      sx={{
        alignSelf: "stretch",
        display: "inline-flex",
        alignItems: "center",
        px: { xs: 2, sm: 3 },
        bgcolor: rx.accent,
        color: rx.onAccent,
        fontSize: { xs: 22, sm: 24 },
        fontWeight: 700,
        letterSpacing: "-0.8px",
        textDecoration: "none",
        "&:focus-visible": { outline: `3px solid ${rx.onAccent}`, outlineOffset: -5 },
      }}
    >
      Retrainix
    </Box>
  );
}

/** The Reneonix wordmark and line, at the foot of the menu when its labels are shown. */
function BrandFooter() {
  return (
    <Box sx={{ mt: "auto", pt: 2, px: 1, borderTop: `1px solid ${rx.chromeBorder}`, display: "grid", gap: 1 }}>
      <Box component="img" src={wordmark} alt="Reneonix" sx={{ width: 132, height: 44, objectFit: "contain", objectPosition: "left center", filter: rx.logoFilter }} />
      <Typography component="p" sx={{ fontSize: "0.75rem", color: rx.chromeMuted, lineHeight: 1.5 }}>
        Material Circularity,
        <br />
        Powered by Intelligence.
        <br />© 2026 Reneonix
      </Typography>
    </Box>
  );
}

/**
 * The frame every screen sits in: a charcoal top bar, and a navigation rail that expands to
 * show labels. Under 761 px the rail gives way to a menu button and a drawer.
 */
export default function AppShell() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [expanded, setExpanded] = useState(readExpanded);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  const projectMatch = useMatch("/projects/:pid/*");
  const pid = projectMatch?.params.pid ?? null;
  const section = projectMatch?.params["*"] ?? "";
  const base = pid ? `/projects/${encodeURIComponent(pid)}` : null;

  // The open project's real name, for the top bar. Nothing is shown until it has loaded.
  const [project] = useLoad(() => (pid ? api.getProject(pid) : Promise.resolve(null)), [pid]);
  const projectName = project.status === "ready" && project.data ? project.data.name : null;

  // Close the drawer whenever the route changes, and whenever the rail takes over.
  useEffect(() => setDrawerOpen(false), [location.pathname, desktop]);

  const toggleRail = useCallback(() => {
    setExpanded((was) => {
      writeExpanded(!was);
      return !was;
    });
  }, []);

  const needProject = "open a project first";
  const destinations: Destination[] = [
    {
      label: "Dashboard",
      icon: <SpaceDashboardOutlinedIcon />,
      to: base ? `${base}/dashboard` : "/",
      active: section === "dashboard" || location.pathname === "/",
      disabledHint: "",
    },
    { label: "Projects", icon: <GridViewOutlinedIcon />, to: "/projects", active: location.pathname === "/projects", disabledHint: "" },
    { label: "Project setup", icon: <FolderOpenOutlinedIcon />, to: base, active: Boolean(pid) && section === "", disabledHint: needProject },
    { label: "Annotation QA", icon: <FactCheckOutlinedIcon />, to: base ? `${base}/qa` : null, active: section === "qa", disabledHint: needProject },
    { label: "Train & export", icon: <ModelTrainingOutlinedIcon />, to: base ? `${base}/train` : null, active: section === "train", disabledHint: needProject },
  ];

  const railWidth = expanded ? rx.railWidthOpen : rx.railWidth;
  const menuButtonSx = { color: rx.chromeText, "&:hover": { bgcolor: rx.chromeHover }, "&.Mui-focusVisible": { outline: `3px solid ${rx.accent}`, outlineOffset: 2 } } as const;

  return (
    <Box sx={{ minHeight: "100dvh", bgcolor: "background.default" }}>
      <Box
        component="a"
        href="#main"
        sx={{
          position: "fixed",
          top: 8,
          left: 8,
          zIndex: 1400,
          px: 2,
          py: 1,
          borderRadius: "10px",
          bgcolor: rx.surface,
          color: rx.text,
          fontWeight: 600,
          transform: "translateY(-200%)",
          "&:focus": { transform: "none" },
        }}
      >
        Skip to the page
      </Box>

      <Box
        component="header"
        sx={{
          position: "fixed",
          inset: "0 0 auto 0",
          zIndex: (t) => t.zIndex.appBar,
          height: rx.headerHeight,
          display: "flex",
          alignItems: "center",
          bgcolor: rx.chrome,
          color: rx.chromeText,
          borderBottom: `1px solid ${rx.chromeBorder}`,
          pr: { xs: 1.5, sm: 3 },
        }}
      >
        <Box sx={{ width: { xs: 56, sm: rx.railWidth }, flexShrink: 0, display: "grid", placeItems: "center" }}>
          {desktop ? (
            <Tooltip title={expanded ? "Hide the menu labels" : "Show the menu labels"} placement="bottom">
              <IconButton
                aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
                aria-expanded={expanded}
                aria-controls={RAIL_ID}
                onClick={toggleRail}
                sx={menuButtonSx}
              >
                {expanded ? <MenuOpenIcon /> : <MenuIcon />}
              </IconButton>
            </Tooltip>
          ) : (
            <IconButton aria-label="Open navigation" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)} sx={menuButtonSx}>
              <MenuIcon />
            </IconButton>
          )}
        </Box>

        <Typography component="h1" sx={{ alignSelf: "stretch", display: "flex", m: 0, fontSize: "inherit" }}>
          <Brand />
        </Typography>

        <Box sx={{ flex: 1, minWidth: 0, px: { xs: 1.5, sm: 3 }, display: { xs: "none", sm: "block" } }}>
          <Typography component="p" sx={{ fontSize: "0.75rem", color: rx.chromeMuted, lineHeight: 1.3 }}>
            {pid ? "Project" : "Workspace"}
          </Typography>
          <Typography component="p" noWrap sx={{ fontWeight: 600, lineHeight: 1.3 }}>
            {pid ? (projectName ?? "…") : "All projects"}
          </Typography>
        </Box>
        <Box sx={{ flex: 1, display: { xs: "block", sm: "none" } }} />

        {pid && (
          <Box sx={{ "& .MuiIconButton-root": { color: rx.chromeText, "&:hover": { bgcolor: rx.chromeHover }, "&.Mui-focusVisible": { outline: `3px solid ${rx.accent}`, outlineOffset: 2 } } }}>
            <NotificationsBell pid={pid} />
          </Box>
        )}
      </Box>

      {desktop ? (
        <Box
          id={RAIL_ID}
          component="nav"
          aria-label="Main"
          sx={{
            position: "fixed",
            inset: `${rx.headerHeight}px auto 0 0`,
            zIndex: (t) => t.zIndex.appBar - 1,
            width: railWidth,
            px: 1.5,
            py: 3,
            bgcolor: rx.chrome,
            color: rx.chromeText,
            borderRight: `1px solid ${rx.chromeBorder}`,
            overflowY: "auto",
            transition: "width 160ms ease",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          <NavList destinations={destinations} showLabel={expanded} onNavigate={() => undefined} />
          {expanded && <BrandFooter />}
        </Box>
      ) : (
        <Drawer
          variant="temporary"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          ModalProps={{ keepMounted: true }}
          slotProps={{ paper: { "aria-label": "Navigation" } }}
          sx={{ "& .MuiDrawer-paper": { width: "min(280px, 86vw)", boxSizing: "border-box", bgcolor: rx.chrome, color: rx.chromeText, borderRadius: 0 } }}
        >
          <Box sx={{ height: rx.headerHeight, display: "flex", alignItems: "center", justifyContent: "space-between", pr: 1 }}>
            <Brand onClick={() => setDrawerOpen(false)} />
            <IconButton aria-label="Close navigation" onClick={() => setDrawerOpen(false)} sx={menuButtonSx}>
              <CloseIcon />
            </IconButton>
          </Box>
          <Box component="nav" aria-label="Main" sx={{ px: 1.5, py: 2, flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
            <NavList destinations={destinations} showLabel onNavigate={() => setDrawerOpen(false)} />
            <BrandFooter />
          </Box>
        </Drawer>
      )}

      <Box
        component="main"
        id="main"
        tabIndex={-1}
        sx={{
          ml: desktop ? `${railWidth}px` : 0,
          pt: `${rx.headerHeight}px`,
          minWidth: 0,
          transition: "margin-left 160ms ease",
          "&:focus": { outline: "none" },
        }}
      >
        <Box sx={{ maxWidth: 1440, mx: "auto", p: { xs: 2, sm: 3, lg: 4 }, pb: { xs: 6, lg: 8 } }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
