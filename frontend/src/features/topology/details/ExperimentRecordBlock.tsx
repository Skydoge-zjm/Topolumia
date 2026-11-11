import type { ResearchObjectRef } from "@/features/research/model";
import { ExperimentWorkbench } from "@/features/experiments/ExperimentWorkbench";
import type { ContentBlock } from "./ContentBlockRenderer";

/** An experiment record block is its own workspace: runs, curves, exact data and raw events. */
export function ExperimentRecordBlock({ block, owner, en, candidateId }: { block: ContentBlock; owner: ResearchObjectRef; en: boolean; candidateId?: string }) {
  return <ExperimentWorkbench nodeId={owner.id} block={block} en={en} candidateId={candidateId} />;
}
