import { RunStatusDot } from "./RunStatusDot";
import { runStatusLabel, runStatusOrder } from "./runPresentation";

/** One mark per run, in recorded order: the shape carries the status, so a failed retry stays visible at a glance. */
export function RunStrip({ runs, en, max = 12, className = "" }: { runs: { status: string }[]; en: boolean; max?: number; className?: string }) {
  if (!runs.length) return null;
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const summary = runStatusOrder.filter((status) => counts.has(status)).map((status) => `${counts.get(status)} ${runStatusLabel(status, en)}`).join(en ? ", " : "，");
  const shown = runs.length > max ? runs.slice(runs.length - max) : runs;
  return (
    <span className={"run-strip " + className} role="img" aria-label={(en ? `${runs.length} runs: ` : `${runs.length} 次运行：`) + summary}>
      {runs.length > max && <span className="run-strip-more" aria-hidden="true">+{runs.length - max}</span>}
      {shown.map((run, index) => <RunStatusDot key={index} status={run.status} en={en} withLabel={false} />)}
    </span>
  );
}

/** Status counts as separate fields, most informative first. */
export function RunStatusCounts({ runs, en }: { runs: { status: string }[]; en: boolean }) {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  return (
    <span className="run-status-counts">
      {runStatusOrder.filter((status) => counts.has(status)).map((status) => (
        <span key={status} className="run-status-count">
          <RunStatusDot status={status} en={en} withLabel={false} />
          {counts.get(status)} {runStatusLabel(status, en)}
        </span>
      ))}
    </span>
  );
}
