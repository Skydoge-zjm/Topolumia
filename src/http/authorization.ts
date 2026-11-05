export function requiredProjectPermission(pathname, method) {
  if (
    !pathname.startsWith("/api/") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/schemas/") ||
    pathname === "/api/health"
  )
    return null;
  if (pathname === "/api/auth/me" || pathname === "/api/collaboration/context")
    return null;
  if (
    pathname === "/api/projects" ||
    pathname === "/api/users" ||
    pathname.startsWith("/api/projects/")
  )
    return null;
  if (pathname === "/api/settings" && method !== "GET")
    return "project.manageSettings";
  if (pathname.startsWith("/api/tools-environment") && method !== "GET")
    return "project.manageSettings";
  if (pathname.startsWith("/api/ssh/") && method !== "GET")
    return "project.manageSettings";
  if (pathname.startsWith("/api/agent-configuration") && (method !== "GET" || pathname.endsWith("/native-config")))
    return "project.manageSettings";
  if (method === "GET") return "project.view";
  if (/^\/api\/research-nodes\//.test(pathname) && method === "DELETE" && pathname.split("/").length===4) return "research.withdrawOrSupersede";
  if (/^\/api\/research-(relations|groups|objects)(\/|$)/.test(pathname)) return "research.applyChange";
  if (/^\/api\/research-(records|series)(\/|$)/.test(pathname)) return "research.recordProgress";
  if (pathname === "/api/agent-events") return "research.recordProgress";
  if (pathname === "/api/research/candidates" && method === "POST")
    return "research.proposeChange";
  if (
    pathname.startsWith("/api/research/candidates/") &&
    pathname.endsWith("/edit") &&
    method === "POST"
  )
    return "research.proposeChange";
  if (pathname.startsWith("/api/research/candidates/") && method === "POST")
    // The decision is read and authorized by the shared research action policy.
    return "project.view";
  if (
    pathname.includes("/topology/curation/preview") ||
    pathname.includes("/topology/curation/trigger")
  )
    return "research.proposeChange";
  if (
    pathname === "/api/source-refresh" ||
    pathname === "/api/sync" ||
    pathname.includes("/experiment-gateway/sync")
  )
    return "source.refresh";
  if (
    pathname.includes("/experiment-gateway/metrics") ||
    pathname.includes("/simulations") ||
    pathname.includes("/executions/docker/run")
  )
    return "experiment.run";
  if (pathname.includes("/executions/docker/preview"))
    return "experiment.preview";
  if (pathname.includes("/agent-sessions"))
    return "agent.createSession";
  return "project.view";
}
