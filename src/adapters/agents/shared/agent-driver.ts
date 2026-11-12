import { AppError } from "../../../lib/errors.js";
import type { AgentProfile, AgentDriverOptions, AgentCapabilities, AgentPromptPart, DriverEvent } from "../../../domain/agents/agent-types.js";

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return textValue(content);
  return content.map((part) => {
    if (part?.type === "image") return "";
    if (part?.type === "text") return String(part.text ?? "");
    if (part?.type === "resource") {
      const resource = part.resource ?? {};
      return `[Research resource: ${resource.uri ?? "unknown"}]\n${String(resource.text ?? "")}`;
    }
    return textValue(part);
  }).filter(Boolean).join("\n\n");
}

export function errorFromMessage(code: string, message: string, detail: unknown = {}, status = 502) {
  return new AppError(code, message, { status, detail: sanitizeDetail(detail), retryable: true });
}

function sanitizeDetail(detail: unknown): unknown {
  if (!detail || typeof detail !== "object") return detail;
  const copy: Record<string, unknown> = { ...detail };
  for (const key of ["token", "apiKey", "accessToken", "refreshToken", "authorization", "prompt"]) delete copy[key];
  if (typeof copy.stderr === "string") copy.stderr = copy.stderr.slice(-2_000);
  return copy;
}

export function normalizeStopReason(value: unknown) {
  const reason = String(value ?? "").toLowerCase();
  if (reason.includes("interrupt") || reason.includes("cancel")) return "cancelled";
  if (reason.includes("error") || reason.includes("fail")) return "error";
  return "end_turn";
}

export class AgentDriver {
  profile: AgentProfile;
  environment: Record<string, string>;
  onEvent: (event: DriverEvent) => void;
  requestTimeoutMs: number;
  closed: boolean;
  nativeSessionId: string | null;
  activeTurnId: string | null;
  cwd = process.cwd();
  capabilities: AgentCapabilities = {};
  agentInfo: { name?: string; title?: string; version?: string | null } = {};
  authMethods: unknown[] = [];
  constructor(profile: AgentProfile, options: AgentDriverOptions = {}) {
    this.profile = profile;
    this.environment = { ...(profile.env ?? {}), ...(options.env ?? {}) };
    this.onEvent = options.onEvent ?? (() => {});
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.closed = false;
    this.nativeSessionId = null;
    this.activeTurnId = null;
  }

  emit(type: string, payload: Record<string, unknown> = {}, turnId: string | null | undefined = this.activeTurnId) {
    this.onEvent({ type, turnId, payload: { nativeSessionId: this.nativeSessionId, ...payload } });
  }

  contextText(content: AgentPromptPart[]) {
    return contentToText(content);
  }
}
