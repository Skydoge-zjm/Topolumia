import { AgentAdapter } from "../shared/agent-adapter.js";
import { CodexAppServerDriver, CodexAppServerReader } from "./codex-app-server-driver.js";

export class CodexAgentAdapter extends AgentAdapter {
  constructor(profile, options = {}) {
    super(profile, options);
    this.driver = new CodexAppServerDriver(profile, options);
  }

  get nativeSessionId() {
    return this.driver.nativeSessionId;
  }

  get closed() {
    return this.driver.closed || this.driver.process?.closed === true;
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

  async resolvePermission(requestId, optionId, cancelled = false, selection = {}) {
    return this.driver.resolvePermission(requestId, optionId, cancelled, selection);
  }

  async readSnapshot({ nativeSessionId = this.nativeSessionId } = {}) {
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
