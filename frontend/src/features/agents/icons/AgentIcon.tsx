import { Braces, Code2, FlaskConical, Sparkles, Terminal } from "lucide-react";

function agentIconKey(
  profile?: { id?: string | null; provider?: string | null } | null,
): string {
  const value = `${profile?.id ?? ""} ${profile?.provider ?? ""}`.toLowerCase();
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude";
  if (value.includes("fixture")) return "fixture";
  if (value.includes("pi")) return "pi";
  if (value.includes("opencode")) return "opencode";
  if (value.includes("gemini")) return "gemini";
  return "agent";
}

export function AgentIcon({
  profile,
  size = 14,
}: {
  profile?: { id?: string | null; provider?: string | null } | null;
  size?: number;
}) {
  const key = agentIconKey(profile);
  if (key === "codex") {
    return (
      <span className={`agent-icon agent-icon-${key}`} aria-hidden="true">
        <img src="/agent-icons/openai.svg" alt="" width={size} height={size} />
      </span>
    );
  }
  if (key === "claude") {
    return (
      <span className={`agent-icon agent-icon-${key}`} aria-hidden="true">
        <img
          src="/agent-icons/anthropic.svg"
          alt=""
          width={size}
          height={size}
        />
      </span>
    );
  }
  const Icon =
    key === "fixture"
      ? FlaskConical
      : key === "pi"
        ? Braces
        : key === "opencode" || key === "gemini"
          ? Terminal
          : key === "codex"
            ? Code2
            : Sparkles;
  return (
    <span className={`agent-icon agent-icon-${key}`} aria-hidden="true">
      <Icon size={size} strokeWidth={1.8} />
    </span>
  );
}
