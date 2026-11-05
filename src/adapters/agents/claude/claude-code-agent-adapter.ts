import { AgentAdapter } from "../shared/agent-adapter.js";
import { ClaudeCliStreamDriver } from "./claude-cli-stream-driver.js";

export class ClaudeCodeAgentAdapter extends AgentAdapter {
  constructor(profile, options = {}) {
    super(profile, options);
    this.driver = new ClaudeCliStreamDriver(profile, options);
  }

  get nativeSessionId() {
    return this.driver.nativeSessionId;
  }

  get closed() {
    return this.driver.closed;
  }

  async start(input = {}) {
    return this.driver.start(input);
  }

  async prompt(input = {}) {
    return this.driver.prompt(input);
  }

  cancel() {
    return this.driver.cancel();
  }

  async resolvePermission(requestId, optionId, cancelled = false) {
    return this.driver.resolvePermission(requestId, optionId, cancelled);
  }

  async close() {
    return this.driver.close();
  }
}
