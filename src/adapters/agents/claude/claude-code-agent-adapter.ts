import type { AgentProfile, AgentDriverOptions, AgentStartInput, AgentPromptInput } from "../../../domain/agents/agent-types.js";
import { AgentAdapter } from "../shared/agent-adapter.js";
import { ClaudeCliStreamDriver } from "./claude-cli-stream-driver.js";

export class ClaudeCodeAgentAdapter extends AgentAdapter {
  driver: ClaudeCliStreamDriver;
  constructor(profile: AgentProfile, options: AgentDriverOptions = {}) {
    super(profile, options);
    this.driver = new ClaudeCliStreamDriver(profile, options);
  }

  get nativeSessionId() {
    return this.driver.nativeSessionId;
  }

  get closed() {
    return this.driver.closed;
  }

  async start(input: AgentStartInput = {}) {
    return this.driver.start(input);
  }

  async prompt(input: AgentPromptInput) {
    return this.driver.prompt(input);
  }

  cancel() {
    return this.driver.cancel();
  }

  async resolvePermission(requestId: string, optionId: string | null, cancelled = false) {
    return this.driver.resolvePermission(requestId, optionId, cancelled);
  }

  async close() {
    return this.driver.close();
  }
}
