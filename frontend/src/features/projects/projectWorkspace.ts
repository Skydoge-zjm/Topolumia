import type {
  ProjectWorkspace,
  ProjectWorkspaceChoice,
} from "@domain/projects/workspace";

export type WorkspaceDraft = {
  kind: ProjectWorkspaceChoice["kind"];
  localDirectory: string;
  sshDirectory: string;
  connectionId: string;
};
export function workspaceDraft(workspace?: ProjectWorkspace): WorkspaceDraft {
  return {
    kind:
      workspace?.kind === "unassigned"
        ? "managed"
        : (workspace?.kind ?? "managed"),
    localDirectory:
      workspace?.kind === "local" ? (workspace.directory ?? "") : "",
    sshDirectory: workspace?.kind === "ssh" ? (workspace.directory ?? "") : "",
    connectionId: workspace?.connectionId ?? "",
  };
}
export function workspaceChoice(draft: WorkspaceDraft): ProjectWorkspaceChoice {
  if (draft.kind === "local")
    return { kind: "local", directory: draft.localDirectory.trim() };
  if (draft.kind === "ssh")
    return {
      kind: "ssh",
      directory: draft.sshDirectory.trim(),
      connectionId: draft.connectionId,
    };
  return { kind: draft.kind };
}
export type WorkspaceView = {
  projectId: string;
  name: string;
  workspace: ProjectWorkspace;
  localHost: string;
  defaultDirectory: string;
};
export type DirectoryPage = {
  directory: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  total: number;
  nextOffset: number | null;
  partial: boolean;
  home: string;
  roots: { name: string; path: string }[];
  hostLabel?: string;
};
