import { AppError } from "../../../lib/errors.js";

export class AgentAdapter {
  constructor(profile, options = {}) {
    this.profile = profile;
    this.options = options;
    this.onEvent = options.onEvent ?? (() => {});
  }

  async start(_input?: unknown): Promise<unknown> {
    throw new AppError("AGENT_ADAPTER_NOT_IMPLEMENTED", `${this.profile.label} 尚未实现启动能力。`, { status: 501 });
  }

  async prompt(_input: unknown): Promise<unknown> {
    throw new AppError("AGENT_ADAPTER_NOT_IMPLEMENTED", `${this.profile.label} 尚未实现消息能力。`, { status: 501 });
  }

  cancel() {}

  async resolvePermission(_requestId: string, _optionId: string | null, _cancelled = false, _selection: { permissionKeys?: string[] } = {}): Promise<void> {
    throw new AppError("AGENT_APPROVAL_UNSUPPORTED", `${this.profile.label} 不支持交互式审批。`, { status: 409 });
  }

  async readSnapshot(_input?: unknown): Promise<unknown> {
    throw new AppError("AGENT_SNAPSHOT_UNSUPPORTED", `${this.profile.label} 不支持读取原生会话快照。`, { status: 409 });
  }

  async close() {}
}
