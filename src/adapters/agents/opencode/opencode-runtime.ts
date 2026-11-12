import type { AgentProfile, AgentDriverOptions, AgentAdapterContract } from "../../../domain/agents/agent-types.js";
import type { AgentModelCatalog } from "../../../domain/agents/agent-model-catalog.js";
import { AppError } from "../../../lib/errors.js";
import { OpenCodeAgentAdapter } from "./v1/opencode-agent-adapter.js";
import { discoverOpenCodeModels as discoverV1 } from "./v1/opencode-server.js";
import { OpenCodeV2AgentAdapter } from "./v2/opencode-agent-adapter.js";
import { discoverOpenCodeV2Models } from "./v2/opencode-catalog.js";

export function openCodeDriver(driver?: string): "opencode-server-v1" | "opencode-server-v2" | undefined {
  if (driver === "opencode-server" || driver === "opencode-server-v1") return "opencode-server-v1";
  if (driver === "opencode-server-v2") return driver;
}

export function openCodeVersionProfile(profile: AgentProfile): AgentProfile {
  const driver = openCodeDriver(profile.driver);
  if (!driver) return profile;
  return { ...profile, driver, versionArgs: profile.versionArgs ?? ["--version"], requireVersion: true,
    minVersion: profile.minVersion ?? (driver === "opencode-server-v2" ? "2.2.7" : "1.19.0"),
    maxVersion: driver === "opencode-server-v2" ? "3.0.0" : "2.0.0" };
}

export function assertOpenCodeBinding(profile: AgentProfile, expectedDriver?: string): void {
  if (expectedDriver && (openCodeDriver(expectedDriver) ?? expectedDriver) !== (openCodeDriver(profile.driver) ?? profile.driver)) {
    throw new AppError("AGENT_RESUME_DRIVER_MISMATCH", "原生会话属于另一版本的 Agent 驱动，请使用原版本继续或创建新会话。本地历史仍保留。", { status: 409 });
  }
}

export function createOpenCodeAdapter(profile: AgentProfile, options: AgentDriverOptions): AgentAdapterContract {
  return openCodeDriver(profile.driver) === "opencode-server-v2" ? new OpenCodeV2AgentAdapter(profile, options) : new OpenCodeAgentAdapter(profile, options);
}

export async function discoverOpenCodeModels(profile: AgentProfile, cwd: string): Promise<AgentModelCatalog> {
  return openCodeDriver(profile.driver) === "opencode-server-v2" ? discoverOpenCodeV2Models(profile, cwd) : discoverV1(profile, cwd);
}
