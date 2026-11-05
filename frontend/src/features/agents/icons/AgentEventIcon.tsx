import { useLayoutEffect, useRef } from "react";
import {
  Bot,
  Brain,
  CircleAlert,
  FilePenLine,
  FileText,
  Globe,
  Info,
  Images,
  ListTodo,
  MessageSquare,
  Plug,
  Search,
  ShieldCheck,
  Terminal,
  Workflow,
  Wrench,
} from "lucide-react";
import type { AgentEvent } from "@/shared/types/api";
import { describeTool } from "@/features/agents/tools/agentTool";
import {
  AGENT_MOTION,
  animateAgentElement,
} from "@/features/agents/motion/agentMotion";

type IconSource = {
  kind: string;
  title?: string;
  status?: string;
  events?: AgentEvent[];
  children?: IconSource[];
};
const icons = {
  reasoning: Brain,
  mcp: Plug,
  terminal: Terminal,
  search: Search,
  web: Globe,
  "file-read": FileText,
  "file-edit": FilePenLine,
  agent: Bot,
  tool: Wrench,
  image: Images,
  "image-gallery": Images,
  plan: ListTodo,
  approval: ShieldCheck,
  status: Info,
  error: CircleAlert,
  message: MessageSquare,
  activity: Workflow,
  "activity-batch": Workflow,
  subagent: Bot,
};

export function AgentEventIcon({ item }: { item: IconSource }) {
  let kind = item.kind;
  if (kind === "tool") kind = describeTool(item, false).kind;
  if (
    kind === "status" &&
    item.events?.some((event) => event.type === "files.changed")
  )
    kind = "file-edit";
  if (
    kind === "status" &&
    item.events?.some((event) =>
      ["agent.activity", "agent.delegated"].includes(event.type),
    )
  )
    kind = "agent";
  if (
    kind === "status" &&
    (item.status === "failed" ||
      item.events?.some((event) => event.type === "turn.failed"))
  )
    kind = "error";
  if (
    kind === "activity-batch" &&
    item.children?.length &&
    item.children.every((child) => child.kind === "reasoning")
  )
    kind = "reasoning";
  if (item.kind === "activity-batch") {
    const current = [...(item.children ?? [])]
      .reverse()
      .find(
        (child) =>
          child.status === "running" ||
          (child as IconSource & { streaming?: boolean }).streaming,
      );
    if (current)
      kind =
        current.kind === "tool"
          ? describeTool(current, false).kind
          : current.kind;
  }
  const Icon = icons[kind as keyof typeof icons] ?? Info;
  const ref = useRef<HTMLSpanElement>(null);
  const prior = useRef<{ kind: string; svg: SVGElement } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const svg = node?.querySelector<SVGElement>("svg:not([data-motion-exit])");
    if (!node || !svg) return;
    node
      .querySelectorAll("[data-motion-exit]")
      .forEach((element) => element.remove());
    if (prior.current && prior.current.kind !== kind) {
      const old = prior.current.svg;
      old.setAttribute("data-motion-exit", "true");
      old.removeAttribute("data-event-icon");
      node.append(old);
      const exit = animateAgentElement(
        old,
        [{ opacity: 1 }, { opacity: 0 }],
        AGENT_MOTION.icon,
      );
      const remove = () => old.remove();
      if (exit) exit.finished.then(remove, remove);
      else remove();
      animateAgentElement(
        svg,
        [{ opacity: 0 }, { opacity: 1 }],
        AGENT_MOTION.icon,
      );
    }
    prior.current = { kind, svg: svg.cloneNode(true) as SVGElement };
  }, [kind]);
  return (
    <span
      className="agent-motion-icon motion-indicator"
      data-motion-indicator="true"
      ref={ref}
      aria-hidden="true"
    >
      <Icon
        className="agent-event-icon"
        size={15}
        strokeWidth={1.7}
        aria-hidden="true"
        data-event-icon={kind}
      />
    </span>
  );
}
