import type { CSSProperties, ReactNode } from "react";
import styles from "./LoadingSkeleton.module.css";

export function Skeleton({ width, height = 14, className = "" }: { width?: CSSProperties["width"]; height?: CSSProperties["height"]; className?: string }) {
  return <span aria-hidden="true" className={`${styles.shape} ${className}`} style={{ width, height }}><span className={styles.fill} /></span>;
}

function Lines({ count = 3 }: { count?: number }) {
  return <div className={styles.lines}>{Array.from({ length: count }, (_, index) => <Skeleton key={index} width={index === count - 1 ? "62%" : "100%"} />)}</div>;
}

function Panel() {
  return <div className={styles.panel}><Skeleton width="38%" height={18} /><Lines /><div className={styles.pair}><Skeleton width="30%" /><Skeleton width="24%" /></div></div>;
}

function Conversation() {
  return <div className={styles.messages}>{[true, false, true].map((user, index) => <div key={index} className={`${styles.bubble} ${user ? styles.user : ""}`}><Lines count={user ? 2 : 5} /></div>)}</div>;
}

export type LoadingLayout = "page" | "configuration" | "agent" | "conversation" | "sessions" | "session-icons" | "detail" | "cards" | "rows";

export function LoadingSkeleton({ layout = "page", label, heading = false, compactRail = false, className = "" }: {
  layout?: LoadingLayout;
  label: string;
  heading?: boolean;
  compactRail?: boolean;
  className?: string;
}) {
  let content: ReactNode;
  if (layout === "configuration") content = <><div className={styles.cards}>{[0, 1, 2].map(index => <Panel key={index} />)}</div><Panel /></>;
  else if (layout === "conversation") content = <Conversation />;
  else if (layout === "sessions") content = <div className={styles.sessions}>{[0, 1, 2, 3, 4].map(index => <div className={styles.session} key={index}><Skeleton width={24} height={24} /><Lines count={2} /></div>)}</div>;
  else if (layout === "session-icons") content = <div className={styles.sessionIcons}>{[0, 1, 2, 3, 4].map(index => <Skeleton key={index} width={24} height={24} />)}</div>;
  else if (layout === "agent") content = <div className={`${styles.agent} ${compactRail ? styles.compactRail : ""}`}><div className={styles.rail}>{compactRail ? <div className={styles.sessionIcons}>{[0, 1, 2].map(index => <Skeleton key={index} width={20} height={20} />)}</div> : <><Lines count={2} /><Panel /><Panel /></>}</div><div className={styles.chat}><Skeleton width="35%" height={20} /><Conversation /><Skeleton height={76} /></div></div>;
  else if (layout === "detail") content = <><div className={styles.facts}>{[0, 1, 2, 3].map(index => <Lines key={index} count={2} />)}</div><div className={styles.tabs}><Skeleton width={90} height={30} /><Skeleton width={100} height={30} /></div><Panel /><Panel /></>;
  else if (layout === "rows") content = <div className={styles.rows}>{[0, 1, 2, 3].map(index => <div className={styles.row} key={index}><Skeleton width="28%" /><Skeleton width="40%" /><Skeleton width="14%" /></div>)}</div>;
  else content = <><Panel /><Panel /></>;
  return <div className={`${styles.region} ${layout === "configuration" ? styles.configuration : ""} ${className}`} role="status" aria-busy="true" aria-label={label} data-loading-skeleton={layout}>
    <span className={styles.srOnly}>{label}</span>
    <div className={styles.visual} aria-hidden="true">{heading && <div className={styles.heading}><Skeleton width="42%" height={26} /><Skeleton width={96} height={34} /></div>}{content}</div>
  </div>;
}
