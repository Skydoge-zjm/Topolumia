import { useRef, useState } from "react";
import { ShieldQuestion, Check, X, Square } from "lucide-react";
import type {
  AgentApproval,
  AgentApprovalOption,
  AgentApprovalSelection,
  ApprovalScope,
} from "@domain/agents/agent-approval";
import { approvalDecision, approvalPermission } from "@domain/agents/agent-approval";

type Props = {
  approval: AgentApproval;
  en: boolean;
  disabled?: boolean;
  canApproveHighRisk?: boolean;
  onApproval: (
    id: string,
    selection: AgentApprovalSelection,
  ) => void | Promise<void>;
};
const scopes: Record<ApprovalScope, [string, string]> = {
  once: ["仅本次", "Once"],
  turn: ["当前回合", "This turn"],
  session: ["当前会话", "This session"],
  persistent: ["持久规则", "Saved rule"],
};
const json = (value: unknown) => JSON.stringify(value, null, 2);

function optionLabel(option: AgentApprovalOption, en: boolean) {
  if (option.mode === "acceptEdits")
    return en ? "Auto-allow edits for session" : "本会话自动允许编辑";
  if (!en && option.label) return option.label;
  const labels = {
    allow_once:
      option.scope === "turn"
        ? ["允许本回合", "Allow this turn"]
        : ["允许本次", "Allow once"],
    allow_session: ["本会话允许", "Allow for session"],
    allow_always: ["允许并保存规则", "Allow and save rule"],
    reject_once: ["拒绝本次", "Reject"],
    reject_always: ["拒绝并保存规则", "Reject and save rule"],
    cancel: ["停止本回合", "Stop turn"],
  };
  return (
    labels[option.kind]?.[en ? 1 : 0] ??
    option.label ??
    option.name ??
    option.optionId
  );
}

export function AgentApprovalCard({
  approval: a,
  en,
  disabled,
  canApproveHighRisk = false,
  onApproval,
}: Props) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const permissions =
    a.permissions && typeof a.permissions === "object"
      ? (a.permissions as Record<string, unknown>)
      : {};
  const availableKeys =
    a.category === "permissions"
      ? (["network", "fileSystem"] as const).filter(
          (key) => permissions[key] != null,
        )
      : [];
  const [unselected, setUnselected] = useState<string[]>([]);
  const permissionKeys = availableKeys.filter(
    (key) => !unselected.includes(key),
  );
  const pending = a.status === "pending";
  const labels: Record<string, [string, string]> = {
    allow: ["已允许", "Allowed"],
    reject: ["已拒绝", "Rejected"],
    cancel: ["已停止", "Stopped"],
    cancelled: ["已取消", "Cancelled"],
    expired: ["已失效", "Expired"],
    external: ["已在原生端处理", "Resolved in Agent"],
  };
  const state = pending
    ? en
      ? "Awaiting approval"
      : "等待审批"
    : (labels[a.decision ?? ""]?.[en ? 1 : 0] ?? (en ? "Resolved" : "已处理"));
  const act = async (option: AgentApprovalOption) => {
    if (lock.current || disabled || (approvalPermission(a, option) === "agent.approveHighRiskTool" && !canApproveHighRisk)) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await onApproval(a.requestId, {
        decision: approvalDecision(option.kind),
        optionId: option.optionId,
        ...(availableKeys.length && approvalDecision(option.kind) === "allow"
          ? { permissionKeys }
          : {}),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : en
            ? "Approval failed"
            : "审批失败",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const details = (
    <>
      {a.reason && (
        <p className="approval-reason" translate="no">
          {a.reason}
        </p>
      )}
      {a.command && (
        <pre className="approval-command" translate="no">
          {a.command}
        </pre>
      )}
      {a.cwd && (
        <div className="approval-location">
          <span>{en ? "Directory" : "工作目录"}</span>
          <code translate="no">{a.cwd}</code>
        </div>
      )}
      {a.network && (
        <div className="approval-location">
          <span>{en ? "Network" : "网络目标"}</span>
          <code translate="no">
            {a.network.protocol ? `${a.network.protocol}://` : ""}
            {a.network.host}
            {a.network.port ? `:${a.network.port}` : ""}
          </code>
        </div>
      )}
      {!!a.paths?.length && (
        <ul className="approval-paths" translate="no">
          {a.paths.map((path, i) => (
            <li key={i}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      )}
      {availableKeys.length > 0 && (
        <fieldset
          className="approval-permissions"
          disabled={!pending || busy || disabled}
        >
          <legend>{en ? "Requested permissions" : "本次请求的权限"}</legend>
          {availableKeys.map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={
                  pending
                    ? !unselected.includes(key)
                    : a.permissionKeys
                      ? a.permissionKeys.includes(key)
                      : a.decision === "allow"
                }
                onChange={(e) =>
                  setUnselected((previous) =>
                    e.target.checked
                      ? previous.filter((item) => item !== key)
                      : [...previous, key],
                  )
                }
              />
              {key === "network"
                ? en
                  ? "Network access"
                  : "网络访问"
                : en
                  ? "File system access"
                  : "文件系统访问"}
            </label>
          ))}
        </fieldset>
      )}
      {(a.input !== undefined ||
        a.permissions ||
        a.fileChanges?.length ||
        a.patterns?.length) && (
        <details className="approval-details">
          <summary>{en ? "Operation details" : "操作详情"}</summary>
          {!!a.fileChanges?.length &&
            a.fileChanges.map((change, i) => (
              <div key={i}>
                <code translate="no">
                  {change.path} {change.kind}
                </code>
                {change.diff && <pre translate="no">{change.diff}</pre>}
              </div>
            ))}
          {a.patterns?.length ? (
            <pre translate="no">{a.patterns.join("\n")}</pre>
          ) : null}
          {a.permissions ? (
            <pre translate="no">{json(a.permissions)}</pre>
          ) : null}
          {a.input !== undefined && <pre translate="no">{json(a.input)}</pre>}
        </details>
      )}
    </>
  );
  const button = (option: AgentApprovalOption) => (
    <button
      key={option.optionId}
      type="button"
      disabled={
        busy ||
        disabled ||
        (approvalPermission(a, option) === "agent.approveHighRiskTool" && !canApproveHighRisk) ||
        (approvalDecision(option.kind) === "allow" &&
          availableKeys.length > 0 &&
          !permissionKeys.length)
      }
      className={`button ${option.kind === "allow_once" && !a.defaultToNo ? "primary" : ""}`}
      onClick={() => void act(option)}
      aria-label={optionLabel(option, en)}
      aria-description={
        option.scope ? scopes[option.scope][en ? 1 : 0] : undefined
      }
      title={option.description}
      data-approval-option={option.optionId}
    >
      {option.kind === "cancel" ? (
        <Square size={12} />
      ) : approvalDecision(option.kind) === "allow" ? (
        <Check size={14} />
      ) : (
        <X size={14} />
      )}
      {optionLabel(option, en)}
    </button>
  );
  const heading = (
    <>
      <span className="agent-motion-icon">
        <ShieldQuestion
          size={14}
          data-event-icon="approval"
          aria-hidden="true"
        />
      </span>
      <strong>{state}</strong>
      {a.toolName && (
        <span className="approval-tool-name" translate="no">
          {a.toolName}
        </span>
      )}
      {a.selectedScope && <small>{scopes[a.selectedScope][en ? 1 : 0]}</small>}
      {a.options?.find((o) => o.optionId === a.optionId)?.mode ===
        "acceptEdits" && (
        <small>{en ? "Auto-allow file edits" : "自动允许文件编辑"}</small>
      )}
    </>
  );
  if (!pending)
    return (
      <details
        className="agent-approval is-resolved"
        data-state={a.decision ?? "resolved"}
        data-approval-id={a.requestId}
      >
        <summary>{heading}</summary>
        <div className="approval-body">{details}</div>
      </details>
    );
  const options = a.options ?? [];
  const saved = options.filter((o) => o.scope === "persistent");
  const sessionOptions = options.filter((o) => o.scope === "session");
  return (
    <article
      className="agent-approval is-pending"
      aria-busy={busy}
      data-approval-id={a.requestId}
      data-motion-key={`approval:${a.requestId}`}
      data-motion-role="approval"
      data-state="pending"
    >
      <header>{heading}</header>
      <div className="approval-body">
        {a.title && <strong translate="no">{a.title}</strong>}
        {!canApproveHighRisk && a.options?.some(option => approvalPermission(a, option) === "agent.approveHighRiskTool") && <p role="status">{en ? "Granting this permission requires high-risk tool approval access. You can reject or stop this turn." : "授予此权限需要高风险工具审批权限。你可以拒绝请求或停止本回合。"}</p>}
        {details}
        {sessionOptions.map((option) => (
          <div key={option.optionId} className="approval-session-scope">
            <small>{en ? "Session permission scope" : "本会话授权范围"}</small>
            {option.mode ? (
              <p>
                {en
                  ? "Claude will automatically approve file writes and edits for this session. Other tool permissions are still checked. Closing or reconnecting restores the configured mode."
                  : option.description}
              </p>
            ) : (option.patterns ?? a.rememberPatterns)?.length ? (
              <pre translate="no">
                {(option.patterns ?? a.rememberPatterns)!.join("\n")}
              </pre>
            ) : (
              option.description && <p translate="no">{option.description}</p>
            )}
          </div>
        ))}
        <div className="approval-actions">
          {options.filter((o) => o.scope !== "persistent").map(button)}
        </div>
        {saved.length > 0 && (
          <details className="approval-details approval-saved-rules">
            <summary>
              {en ? "Save a permission rule…" : "保存授权规则…"}
            </summary>
            {!!a.rememberPatterns?.length &&
              !saved.some((o) => o.patterns?.length) && (
                <pre translate="no">{a.rememberPatterns.join("\n")}</pre>
              )}
            <p>
              {en
                ? "These choices change saved permission rules."
                : "以下选项会写入持久权限规则。"}
            </p>
            {saved.map((option) => (
              <div key={option.optionId}>
                {option.description && (
                  <pre translate="no">{option.description}</pre>
                )}
                {option.patterns?.length ? (
                  <pre translate="no">{option.patterns.join("\n")}</pre>
                ) : null}
                {button(option)}
              </div>
            ))}
          </details>
        )}
        {!options.length && (
          <p>
            {en
              ? "This request has no supported action. Stop the turn to dismiss it."
              : "此请求没有可用的审批选项，可停止当前回合。"}
          </p>
        )}
        {busy && (
          <span role="status" className="approval-feedback">
            {en ? "Sending decision…" : "正在提交审批…"}
          </span>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </article>
  );
}
