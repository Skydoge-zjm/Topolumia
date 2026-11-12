import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ProjectRuntime,
  createProjectRuntimeRegistry,
} from "../application/project-runtime.js";
import type {
  CollaborationActor,
  CollaborationStore,
} from "../services/platform/collaboration-store.js";
import type { ProjectWorkspaceService } from "../services/platform/project-workspace-service.js";
import type { SshConnectionService } from "../ssh/ssh-connection-service.js";
import type { SshEnvironmentHub } from "../ssh/ssh-environment-hub.js";
import type { ManagedRecordCollectors } from "../services/environments/managed-record-collectors.js";
type Registry = Awaited<ReturnType<typeof createProjectRuntimeRegistry>>;
export type RouteContext = Pick<
  ProjectRuntime,
  | "config"
  | "registry"
  | "topologyCurator"
  | "researchCommands"
  | "state"
  | "curatorTriggerCoordinator"
  | "agentSessionGateway"
  | "sourceRefresh"
  | "userSettings"
  | "topologyService"
> & {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  pathname: string;
  requestedProjectId: string;
  requestActor: CollaborationActor;
  commandActor: CollaborationActor;
  requestRuntime: ProjectRuntime;
  collaboration: CollaborationStore;
  projectWorkspaces: ProjectWorkspaceService;
  sshConnections: SshConnectionService;
  sshEnvironments: SshEnvironmentHub;
  recordCollectors: ManagedRecordCollectors;
  topologyLayoutService: Registry["topologyLayoutService"];
  runtimes: Registry["runtimes"];
  getRuntime: Registry["getRuntime"];
  applyRuntimeSettings: Registry["applyRuntimeSettings"];
  ensureFreshForContext: (
    reason: string,
  ) => ReturnType<Registry["refreshForContext"]>;
};
