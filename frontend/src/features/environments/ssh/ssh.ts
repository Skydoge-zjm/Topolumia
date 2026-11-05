export interface SshChallenge {
  id: string;
  kind: "host-key" | "password" | "passphrase" | "keyboard";
  host: string;
  port: number;
  user: string;
  title?: string;
  instructions?: string;
  fingerprint?: string;
  previousFingerprints?: string[];
  changed?: boolean;
  prompts: Array<{ label: string; secret: boolean }>;
  canRemember?: boolean;
}
export interface SshConfiguration {
  name: string;
  mode: "alias" | "manual";
  alias?: string;
  host?: string;
  port?: number;
  user?: string;
  auth?: "agent" | "key" | "password";
  keyPath?: string;
  timeoutSeconds: number;
  keepAlive: boolean;
}
export interface SshConnection extends SshConfiguration {
  id: string;
  revision: number;
  status:
    | "disconnected"
    | "connecting"
    | "verify_host"
    | "authentication"
    | "connected"
    | "error";
  error: string | null;
  remembered: boolean;
  storageWarning?: string | null;
  challenge: SshChallenge | null;
  info: {
    platform: string;
    home: string;
    python: string | null;
    user: string;
    status: string;
  } | null;
  effective: {
    host: string;
    port: number;
    user: string;
    usesProxy: boolean;
  } | null;
  connectedAt: string | null;
  updatedAt: string;
}
export interface SshOverview {
  connections: SshConnection[];
  credentialStorage: { available: boolean; kind: string };
  current: {
    kind: "local" | "ssh";
    name: string;
    hostLabel: string;
    source: string;
    accessible: boolean;
    connected: boolean;
    needsReview: boolean;
    connectionId?: string | null;
  };
}
export const environmentHeaders = (project: string, sshId?: string) => ({
  "x-rw-project-id": project,
  ...(sshId ? { "x-rw-ssh-id": sshId } : {}),
});
export const sshOverviewKey = (project: string, actor: string) => [
  "ssh-connections",
  project,
  actor,
];
