import { Link } from "react-router-dom";
import { ArrowRight, BookOpen, GitPullRequest, Network } from "lucide-react";

import { useUiStore } from "@/shared/state/ui";
import { TopologyIllustration } from "./TopologyIllustration";
import styles from "./entry.module.css";

const capabilities = [
  { icon: Network, zh: ["科研拓扑", "问题、假说、文献、实验和结论放进同一张图，节点组划出研究范围。"], en: ["Research topology", "Questions, hypotheses, papers, experiments and claims on one map, scoped by node groups."] },
  { icon: GitPullRequest, zh: ["Agent 提议，人工审批", "Codex、Claude Code 与 OpenCode 通过 MCP 读写研究上下文，变更经你确认后生效。"], en: ["Agents propose, you approve", "Codex, Claude Code and OpenCode work through MCP; changes apply only after your review."] },
  { icon: BookOpen, zh: ["可追溯的研究记录", "每次变更、审批、组会与复盘都留下记录，随时回看当时的状态。"], en: ["Traceable records", "Every change, review, meeting and retrospective is kept, with the state it applied to."] },
] as const;

export function EntryPage({ setupMode }: { setupMode: boolean }) {
  const { locale, setLocale } = useUiStore();
  const en = locale === "en";
  return (
    <div className={styles.entry}>
      <header className={styles.bar}>
        <img className={styles.wordmark} src="/topolumia-wordmark-white-clean.png" alt="Topolumia" />
        <span className={styles.spacer} />
        <button className={styles.ghost} type="button" onClick={() => setLocale(en ? "zh" : "en")}>{en ? "中文" : "EN"}</button>
        <Link className={styles.ghost} to="/login">{setupMode ? (en ? "Set up" : "初始化") : (en ? "Sign in" : "登录")}</Link>
      </header>
      <main className={styles.hero}>
        <div className={styles.copy}>
          <h1>{en ? "Keep the whole argument of your research in view." : <>让整项研究的论证<wbr />始终一目了然。</>}</h1>
          <p>{en
            ? "Topolumia is a local-first research workbench. It connects coding agents to your research context and keeps every change reviewable."
            : "Topolumia 是本地优先的科研工作台：把编程 Agent 接入你的研究上下文，并让每一次变更都可审阅、可追溯。"}</p>
          <div className={styles.actions}>
            <Link className={styles.primary} to="/login">
              {setupMode ? (en ? "Create the administrator" : "创建管理员账号") : (en ? "Sign in to the workbench" : "登录研究工作台")}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <span className={styles.local}>{en ? "Runs on this machine · 127.0.0.1" : "在本机运行 · 127.0.0.1"}</span>
          </div>
        </div>
        <TopologyIllustration />
      </main>
      <section className={styles.capabilities} aria-label={en ? "Capabilities" : "能力"}>
        {capabilities.map(({ icon: Icon, zh, en: english }) => {
          const [title, body] = en ? english : zh;
          return (
            <article key={title}>
              <Icon size={20} aria-hidden="true" />
              <h2>{title}</h2>
              <p>{body}</p>
            </article>
          );
        })}
      </section>
    </div>
  );
}
