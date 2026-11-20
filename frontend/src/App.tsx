import { BrowserRouter, Link as RouterLink, Route, Routes, useParams } from "react-router-dom";
import { Button } from "@mui/material";
import SearchOffOutlinedIcon from "@mui/icons-material/SearchOffOutlined";
import AppShell from "./components/AppShell";
import { EmptyState } from "./components/States";
import DashboardPage, { DashboardHome } from "./pages/DashboardPage";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectSetupPage from "./pages/ProjectSetupPage";
import QaPage from "./pages/QaPage";
import TrainPage from "./pages/TrainPage";

// Remount per project so one project's jobs and frames never show under another.
function DashboardRoute() {
  const { pid = "" } = useParams();
  return <DashboardPage key={pid} pid={pid} />;
}

function ProjectSetupRoute() {
  const { pid = "" } = useParams();
  return <ProjectSetupPage key={pid} pid={pid} />;
}

function QaRoute() {
  const { pid = "" } = useParams();
  return <QaPage key={pid} pid={pid} />;
}

function TrainRoute() {
  const { pid = "" } = useParams();
  return <TrainPage key={pid} pid={pid} />;
}

function NotFound() {
  return (
    <EmptyState
      icon={<SearchOffOutlinedIcon fontSize="large" />}
      title="There is no page at this address"
      action={
        <Button variant="contained" component={RouterLink} to="/projects">
          All projects
        </Button>
      }
    >
      Start from the project list: each project has a Dashboard, Project setup, Annotation QA, and Train &amp;
      export.
    </EmptyState>
  );
}

// One shell around every screen. "/" is the Dashboard: it opens the newest project's dashboard.
// "/projects" is the list of projects and the form that creates one.
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardHome />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:pid/dashboard" element={<DashboardRoute />} />
          <Route path="/projects/:pid" element={<ProjectSetupRoute />} />
          <Route path="/projects/:pid/qa" element={<QaRoute />} />
          <Route path="/projects/:pid/train" element={<TrainRoute />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
