import { useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink, Outlet, useLocation, useMatch } from "react-router-dom";
import {
  AppBar,
  Box,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import MenuIcon from "@mui/icons-material/Menu";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import ModelTrainingOutlinedIcon from "@mui/icons-material/ModelTrainingOutlined";
import NotificationsBell from "./NotificationsBell";

const DRAWER_WIDTH = 280;

type Destination = {
  label: string;
  icon: ReactNode;
  to: string | null; // null = not reachable yet
  active: boolean;
  disabledHint: string;
};

const pillSx = {
  borderRadius: 999,
  minHeight: 56,
  px: 2,
  width: "100%",
  textAlign: "left",
  color: "text.primary",
  "&.Mui-selected, &.Mui-selected:hover": { bgcolor: "#d7e8cd", color: "#0f2000" },
  "&.Mui-selected .MuiListItemIcon-root": { color: "#0f2000" },
  "&.Mui-disabled": { opacity: 1, color: "text.disabled" },
  "&.Mui-disabled .MuiListItemIcon-root": { color: "text.disabled" },
} as const;

function NavList({ destinations, onNavigate }: { destinations: Destination[]; onNavigate: () => void }) {
  return (
    <Box component="nav" aria-label="Main" sx={{ px: 1.5, py: 1 }}>
      <List disablePadding sx={{ display: "grid", gap: 0.5 }}>
        {destinations.map((d) => (
          <ListItem key={d.label} disablePadding>
            {d.to ? (
              <ListItemButton
                component={RouterLink}
                to={d.to}
                selected={d.active}
                aria-current={d.active ? "page" : undefined}
                onClick={onNavigate}
                sx={pillSx}
              >
                <ListItemIcon sx={{ minWidth: 40 }}>{d.icon}</ListItemIcon>
                <ListItemText primary={d.label} />
              </ListItemButton>
            ) : (
              <ListItemButton component="button" disabled sx={pillSx}>
                <ListItemIcon sx={{ minWidth: 40 }}>{d.icon}</ListItemIcon>
                <ListItemText
                  primary={d.label}
                  secondary={d.disabledHint}
                  slotProps={{ secondary: { sx: { color: "text.secondary" } } }}
                />
              </ListItemButton>
            )}
          </ListItem>
        ))}
      </List>
    </Box>
  );
}

/** Top app bar + navigation drawer (permanent on desktop, hamburger on phone width). */
export default function AppShell() {
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up("md"));
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const projectMatch = useMatch("/projects/:pid/*");
  const pid = projectMatch?.params.pid ?? null;
  const section = projectMatch?.params["*"] ?? "";
  const base = pid ? `/projects/${encodeURIComponent(pid)}` : null;

  // Close the phone drawer whenever the route changes.
  useEffect(() => setOpen(false), [location.pathname]);

  const destinations: Destination[] = [
    {
      label: "Project setup",
      icon: <FolderOpenOutlinedIcon />,
      to: base ?? "/",
      active: !pid || section === "",
      disabledHint: "",
    },
    {
      label: "Annotation QA",
      icon: <FactCheckOutlinedIcon />,
      to: base ? `${base}/qa` : null,
      active: section === "qa",
      disabledHint: "Open a project first",
    },
    {
      label: "Train & export",
      icon: <ModelTrainingOutlinedIcon />,
      to: base ? `${base}/train` : null,
      active: section === "train",
      disabledHint: "Open a project first",
    },
  ];

  const nav = <NavList destinations={destinations} onNavigate={() => setOpen(false)} />;

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          bgcolor: "background.default",
          color: "text.primary",
          borderBottom: "1px solid",
          borderColor: "divider",
          // Above the permanent drawer on desktop; below the phone drawer, which is a modal.
          zIndex: (t) => (desktop ? t.zIndex.drawer + 1 : t.zIndex.appBar),
        }}
      >
        <Toolbar sx={{ gap: 1 }}>
          {!desktop && (
            <IconButton
              edge="start"
              size="large"
              aria-label="Open navigation"
              aria-expanded={open}
              onClick={() => setOpen(true)}
            >
              <MenuIcon />
            </IconButton>
          )}
          <Typography
            variant="h6"
            component="h1"
            sx={{ fontWeight: 700, minHeight: 44, display: "flex", alignItems: "center" }}
          >
            <Box
              component={RouterLink}
              to="/"
              aria-label="Retrainix, all projects"
              sx={{
                color: "inherit",
                textDecoration: "none",
                minHeight: 44,
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              Retrainix
            </Box>
          </Typography>
          <Box sx={{ flex: 1 }} />
          {pid && <NotificationsBell pid={pid} />}
        </Toolbar>
      </AppBar>

      {desktop ? (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            "& .MuiDrawer-paper": {
              width: DRAWER_WIDTH,
              boxSizing: "border-box",
              border: "none",
              bgcolor: "background.default",
            },
          }}
        >
          <Toolbar />
          {nav}
        </Drawer>
      ) : (
        <Drawer
          variant="temporary"
          open={open}
          onClose={() => setOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            "& .MuiDrawer-paper": {
              width: `min(${DRAWER_WIDTH}px, 86vw)`,
              boxSizing: "border-box",
              bgcolor: "background.default",
              borderRadius: "0 16px 16px 0",
            },
          }}
        >
          <Toolbar>
            <Typography variant="h6" component="p" sx={{ fontWeight: 700 }}>
              Retrainix
            </Typography>
          </Toolbar>
          {nav}
        </Drawer>
      )}

      <Box
        component="main"
        sx={{
          ml: { md: `${DRAWER_WIDTH}px` },
          px: { xs: 2, sm: 3 },
          pb: 6,
          minWidth: 0,
        }}
      >
        <Toolbar />
        <Box sx={{ maxWidth: 1040, mx: "auto", pt: { xs: 2, sm: 3 } }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
