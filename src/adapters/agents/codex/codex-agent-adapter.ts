import type { AgentProfile, AgentDriverOptions, AgentStartInput, AgentPromptInput } from "../../../domain/agents/agent-types.js";
import { AgentAdapter } from "../shared/agent-adapter.js";
import { CodexAppServerDriver, CodexAppServerReader } from "./codex-app-server-driver.js";

export class CodexAgentAdapter extends AgentAdapter {
  driver: CodexAppServerDriver;
  constructor(profile: AgentProfile, options: AgentDriverOptions = {}) {
    super(profile, options);
    this.driver = new CodexAppServerDriver(profile, options);
  }

  get nativeSessionId() {
    return this.driver.nativeSessionId;
  }

  get closed() {
    return this.driver.closed || this.driver.process?.closed === true;
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

  async resolvePermission(requestId: string, optionId: string | null, cancelled = false, selection: { permissionKeys?: string[] } = {}) {
    return this.driver.resolvePermission(requestId, optionId, cancelled, selection);
  }

  async readSnapshot({ nativeSessionId = this.nativeSessionId }: { nativeSessionId?: string | null } = {}) {
    if (this.driver.process && !this.driver.process.closed && this.nativeSessionId) {
      return this.driver.readSnapshot();
    }
    const reader = new CodexAppServerReader(this.profile, { requestTimeoutMs: this.options.requestTimeoutMs });
    return reader.readThread({ threadId: nativeSessionId });
  }

  async close() {
    return this.driver.close();
  }
}
