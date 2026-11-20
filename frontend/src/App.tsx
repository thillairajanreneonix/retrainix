import { BrowserRouter, Link as RouterLink, Route, Routes, useParams } from "react-router-dom";
import { Button } from "@mui/material";
import SearchOffOutlinedIcon from "@mui/icons-material/SearchOffOutlined";
import AppShell from "./components/AppShell";
import { EmptyState } from "./components/States";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectSetupPage from "./pages/ProjectSetupPage";
import QaPage from "./pages/QaPage";
import TrainPage from "./pages/TrainPage";

// Remount per project so one project's jobs and frames never show under another.
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
        <Button variant="contained" component={RouterLink} to="/">
          All projects
        </Button>
      }
    >
      Retrainix has three screens: Project setup, Annotation QA, and Train &amp; export. Start from the project list.
    </EmptyState>
  );
}

// The three MVP screens (plan.md section 12) behind one shell. "/" is Project setup with no
// project open yet: the list of projects and the form that creates one.
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects/:pid" element={<ProjectSetupRoute />} />
          <Route path="/projects/:pid/qa" element={<QaRoute />} />
          <Route path="/projects/:pid/train" element={<TrainRoute />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
