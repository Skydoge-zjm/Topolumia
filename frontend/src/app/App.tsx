import { lazy, Suspense, useEffect, useState } from "react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Network,
  Plug,
  Settings,
  Sparkles,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { api, projectId } from "@/shared/lib/api";
import { useLocalizedDom } from "@/shared/lib/i18n";
import { useUiStore } from "@/shared/state/ui";
import type { CollaborationContext } from "@/shared/types/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { EntryPage } from "./entry/EntryPage";
import { LoginPage } from "./entry/LoginPage";
const ProjectsPage = lazy(() =>
  import("@/features/projects/ProjectsPage").then((module) => ({
    default: module.ProjectsPage,
  })),
);
const ProjectCreatePage = lazy(() =>
  import("@/features/projects/ProjectCreatePage").then((module) => ({
    default: module.ProjectCreatePage,
  })),
);
const OverviewPage = lazy(() =>
  import("@/features/overview/OverviewPage").then((module) => ({
    default: module.OverviewPage,
  })),
);
const TopologyPage = lazy(() =>
  import("@/features/topology/TopologyPage").then((module) => ({
    default: module.TopologyPage,
  })),
);
const ResearchRecordsPage = lazy(() =>
  import("@/features/research/records/ResearchRecordsPage").then((module) => ({
    default: module.ResearchRecordsPage,
  })),
);
const RecordDetailPage = lazy(() =>
  import("@/features/research/records/RecordDetailPage").then((module) => ({
    default: module.RecordDetailPage,
  })),
);
const NodeDetailPage = lazy(() =>
  import("@/features/topology/details/NodeDetailPage").then((module) => ({
    default: module.NodeDetailPage,
  })),
);
const GroupDetailPage = lazy(() =>
  import("@/features/topology/groups/GroupDetailPage").then((module) => ({
    default: module.GroupDetailPage,
  })),
);
const ResearchHistoryDetail = lazy(() =>
  import("@/features/research/history/ResearchHistoryDetail").then(
    (module) => ({ default: module.ResearchHistoryDetail }),
  ),
);
const ExperimentsPage = lazy(() =>
  import("@/features/experiments/ExperimentsPage").then((module) => ({
    default: module.ExperimentsPage,
  })),
);
const SettingsPage = lazy(() =>
  import("@/features/settings/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const CollaborationPage = lazy(() =>
  import("@/features/collaboration/CollaborationPage").then((module) => ({
    default: module.CollaborationPage,
  })),
);
const AgentTracePage = lazy(() =>
  import("@/features/agents/trace/AgentTracePage").then((module) => ({
    default: module.AgentTracePage,
  })),
);
const ToolsEnvironmentPage = lazy(() =>
  import("../features/environments/ToolsEnvironmentPage").then((module) => ({
    default: module.ToolsEnvironmentPage,
  })),
);
const AgentConfigurationPage = lazy(() =>
  import("../features/agents/configuration/AgentConfigurationPage").then(
    (module) => ({ default: module.AgentConfigurationPage }),
  ),
);
const AgentPage = lazy(() =>
  import("../features/agents/AgentPage").then((module) => ({
    default: module.AgentPage,
  })),
);

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <img src="/topolumia-mark.png" alt="" />
    </span>
  );
}

function useContext() {
  const client = useQueryClient(),
    id = projectId();
  const defaultContext = client.getQueryData<CollaborationContext>([
    "collaboration-context",
    "",
  ]);
  const sameProject = Boolean(id && defaultContext?.project?.id === id);
  return useQuery({
    queryKey: ["collaboration-context", id],
    queryFn: () => api<CollaborationContext>("/api/collaboration/context"),
    initialData: sameProject ? defaultContext : undefined,
    initialDataUpdatedAt: sameProject
      ? client.getQueryState(["collaboration-context", ""])?.dataUpdatedAt
      : undefined,
  });
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [setupMode, setSetupMode] = useState(false);
  const locale = useUiStore((state) => state.locale);
  const location = useLocation();
  const navigate = useNavigate();
  useLocalizedDom(locale);
  useEffect(() => {
    void api<{ initialized: boolean }>("/api/auth/status")
      .then(async (status) => {
        setSetupMode(!status.initialized);
        if (!status.initialized) {
          setAuthenticated(false);
          return;
        }
        const payload = await api<{ user: unknown }>("/api/auth/me");
        if (
          payload.user &&
          typeof payload.user === "object" &&
          "id" in payload.user
        )
          window.localStorage.setItem(
            "topolumia-actor-id",
            String(payload.user.id),
          );
        setAuthenticated(Boolean(payload.user));
      })
      .catch(() => setAuthenticated(false));
  }, []);
  if (authenticated === null)
    return <div className="loading">正在连接研究工作台…</div>;
  if (!authenticated)
    return (
      <Routes>
        <Route
          path="/login"
          element={
            <LoginPage
              setupMode={setupMode}
              onLoggedIn={() => {
                setAuthenticated(true);
                setSetupMode(false);
                const from = (location.state as { from?: string } | null)?.from;
                navigate(from && from !== "/" ? from : "/projects", { replace: true });
              }}
            />
          }
        />
        <Route path="/" element={<EntryPage setupMode={setupMode} />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname + location.search }} />} />
      </Routes>
    );
  if (location.pathname === "/login" || location.pathname === "/")
    return <Navigate to="/projects" replace />;
  if (
    ["/projects", "/project-create", "/collaboration"].includes(
      location.pathname,
    )
  )
    return (
      <Suspense
        fallback={
          <div className="loading">
            {locale === "en" ? "Loading page…" : "正在载入页面…"}
          </div>
        }
      >
        <ProjectShell />
      </Suspense>
    );
  return (
    <Suspense
      fallback={
        <div className="loading">
          {locale === "en" ? "Loading page…" : "正在载入页面…"}
        </div>
      }
    >
      <Workspace />
    </Suspense>
  );
}

function ProjectShell() {
  const context = useContext();
  const navigate = useNavigate();
  const { locale, setLocale } = useUiStore();
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    navigate("/login");
    window.location.reload();
  };
  if (context.isLoading)
    return <div className="loading">正在读取项目上下文…</div>;
  return (
    <div className="project-shell">
      <header className="project-topbar">
        <Link className="brand" to="/projects">
          <BrandMark />
          <span className="brand-copy">
            <strong>Topolumia</strong>
          </span>
        </Link>
        <span className="project-topbar-divider" />
        <strong>{locale === "en" ? "Project management" : "项目管理"}</strong>
        <span className="topbar-spacer" />
        <span className="account-chip">
          <span className="avatar avatar--green">
            {String(
              context.data?.actor?.displayName ??
                context.data?.actor?.username ??
                "S",
            )
              .slice(0, 1)
              .toUpperCase()}
          </span>
          <span>
            <b>
              {context.data?.actor?.displayName ??
                context.data?.actor?.username ??
                "研究者"}
            </b>
            <small>{context.data?.actor?.serverRole ?? "researcher"}</small>
          </span>
        </span>
        <button
          className="button"
          onClick={() => setLocale(locale === "en" ? "zh" : "en")}
        >
          {locale === "en" ? "中文" : "EN"}
        </button>
        <button className="button" onClick={logout}>
          <LogOut size={15} /> {locale === "en" ? "Sign out" : "退出"}
        </button>
      </header>
      <main className="project-main">
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/project-create" element={<ProjectCreatePage />} />
          <Route path="/collaboration" element={<CollaborationPage />} />
        </Routes>
      </main>
    </div>
  );
}

function Workspace() {
  const context = useContext();
  const navigate = useNavigate();
  const { sidebarCollapsed, toggleSidebar, locale, setLocale, agentFocus } =
    useUiStore();
  const location = useLocation();
  const isAgentPage = location.pathname === "/agents";
  const project = context.data?.project ?? context.data?.projects?.[0];
  useEffect(() => {
    if (project?.id && project.id !== projectId())
      window.localStorage.setItem("research-workbench-project", project.id);
  }, [project?.id]);
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    navigate("/login");
    window.location.reload();
  };
  if (context.isLoading)
    return <div className="loading">正在读取项目上下文…</div>;
  return (
    <div className="app">
      <header className="topbar">
        <Link className="brand" to="/overview">
          <BrandMark />
          <span className="brand-copy">
            <strong>Topolumia</strong>
          </span>
        </Link>
        <span className="topbar-spacer" />
        <SelectMenu
          className="topbar-locale-select"
          value={locale}
          onChange={(value) => setLocale(value as "zh" | "en")}
          ariaLabel={locale === "en" ? "Language" : "语言"}
          options={[
            { value: "zh", label: "中文" },
            { value: "en", label: "English" },
          ]}
        />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="topbar-account-trigger"
              aria-label={locale === "en" ? "Account menu" : "账号菜单"}
            >
              <span className="avatar avatar--green">
                {String(
                  context.data?.actor?.displayName ??
                    context.data?.actor?.username ??
                    "S",
                )
                  .slice(0, 1)
                  .toUpperCase()}
              </span>
              <span>
                <strong>
                  {context.data?.actor?.displayName ??
                    context.data?.actor?.username ??
                    "研究者"}
                </strong>
                <small>{context.data?.actor?.serverRole ?? "researcher"}</small>
              </span>
              <ChevronDown size={15} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="topbar-account-menu"
              align="end"
              sideOffset={8}
            >
              <DropdownMenu.Label className="topbar-account-label">
                {context.data?.actor?.username ?? "researcher"}
              </DropdownMenu.Label>
              <DropdownMenu.Separator className="topbar-account-separator" />
              <DropdownMenu.Item
                className="topbar-account-item"
                onSelect={() => navigate("/settings")}
              >
                {locale === "en" ? "Workspace settings" : "工作区设置"}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="topbar-account-item topbar-account-item--danger"
                onSelect={() => void logout()}
              >
                <LogOut size={14} />
                {locale === "en" ? "Sign out" : "退出登录"}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>
      <div
        className={`shell ${sidebarCollapsed || (isAgentPage && agentFocus) ? "is-collapsed" : ""}`}
      >
        <aside className="sidebar">
          <div className="sidebar-head">
            <Link className="sidebar-return" to="/projects" aria-label={locale === "en" ? "Projects" : "项目列表"}>
              <ArrowLeft size={15} />
              <span>{locale === "en" ? "Projects" : "项目列表"}</span>
            </Link>
            <button
              className="sidebar-collapse"
              onClick={toggleSidebar}
              aria-label={locale === "en" ? "Collapse sidebar" : "收起侧栏"}
            >
              {sidebarCollapsed ? (
                <ChevronRight size={16} />
              ) : (
                <ChevronLeft size={16} />
              )}
            </button>
          </div>
          <nav>
            <p className="sidebar-section-label">科研控制面</p>
            <NavLink className="nav-item" to="/overview">
              <LayoutDashboard size={16} />
              <span>研究总览</span>
            </NavLink>
            <NavLink className="nav-item" to="/topology">
              <Network size={16} />
              <span>科研拓扑</span>
            </NavLink>
            <NavLink className="nav-item" to="/records">
              <BookOpen size={16} />
              <span>研究记录</span>
            </NavLink>
            <NavLink className="nav-item" to="/experiments">
              <FlaskConical size={16} />
              <span>实验与复核</span>
            </NavLink>
            <NavLink className="nav-item" to="/agents">
              <Sparkles size={16} />
              <span>Agent 会话</span>
            </NavLink>
            <p className="sidebar-section-label sidebar-section-label--lower">
              配置与运行
            </p>
            <NavLink className="nav-item" to="/agent-settings">
              <Settings size={16} />
              <span>Agent 配置</span>
            </NavLink>
            <NavLink className="nav-item" to="/tools">
              <Plug size={16} />
              <span>工具与环境</span>
            </NavLink>
            <NavLink className="nav-item" to="/settings">
              <Settings size={16} />
              <span>工作区设置</span>
            </NavLink>
          </nav>
          <div className="sidebar-footer">
            <small>当前研究线</small>
            <strong>{project?.name ?? "Research Project"}</strong>
          </div>
        </aside>
        <main className={`main ${isAgentPage ? "agent-workspace-main" : ""}`}>
          <Routes>
            <Route
              path="/login"
              element={<Navigate to="/projects" replace />}
            />
            <Route path="/" element={<Navigate to="/projects" replace />} />
            <Route path="/agents" element={<AgentPage />} />
            <Route
              path="/agents/trace/:sessionId"
              element={<AgentTracePage />}
            />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/topology" element={<TopologyPage />} />
            <Route path="/topology/new" element={<NodeDetailPage />} />
            <Route path="/topology/nodes/:id" element={<NodeDetailPage />} />
            <Route path="/topology/groups/:id" element={<GroupDetailPage />} />
            <Route path="/records" element={<ResearchRecordsPage />} />
            <Route path="/records/new" element={<RecordDetailPage />} />
            <Route
              path="/records/history/:id"
              element={<ResearchHistoryDetail />}
            />
            <Route path="/records/:id" element={<RecordDetailPage />} />
            <Route
              path="/evidence"
              element={<Navigate to="/records" replace />}
            />
            <Route path="/experiments" element={<ExperimentsPage />} />
            <Route path="/tools" element={<ToolsEnvironmentPage />} />
            <Route
              path="/agent-settings"
              element={<AgentConfigurationPage />}
            />
            <Route path="/collaboration" element={<CollaborationPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<ProjectsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
