import { useState } from "react";
import type { ContentBlock } from "@/features/topology/details/ContentBlockRenderer";
import { ContentBlockRenderer } from "@/features/topology/details/ContentBlockRenderer";
import type { ResearchObjectRef } from "@/features/research/model";
import { ExperimentRunsPanel } from "./ExperimentRunsPanel";
import "./experiment-records.css";

/**
 * One experiment page instead of separate runs and material tabs: the run rail
 * stays in view while its record curves and associated materials render on the
 * right, so linking a material no longer means remembering another tab.
 */
export function ExperimentWorkbench({
  nodeId,
  owner,
  blocks,
  en,
  canEdit,
  onChanged,
  children,
}: {
  nodeId: string;
  owner: ResearchObjectRef;
  blocks: ContentBlock[];
  en: boolean;
  canEdit: boolean;
  onChanged: () => void;
  children?: React.ReactNode;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const recordBlocks = blocks.filter((block) => block.type === "experimentRecord");
  const visibleBlocks =
    selected.length && recordBlocks.length
      ? recordBlocks.filter((block) =>
          (block.payload?.runs ?? []).some((run: { runId?: string }) => run.runId && selected.includes(run.runId)),
        )
      : recordBlocks;
  return (
    <div className="experiment-workbench" translate="no">
      <aside className="experiment-rail" aria-label={en ? "Runs" : "运行"}>
        <ExperimentRunsPanel
          nodeId={nodeId}
          blocks={blocks}
          en={en}
          canEdit={canEdit}
          onChanged={onChanged}
          selected={selected}
          onSelectedChange={setSelected}
        />
      </aside>
      <div className="experiment-main">
        {selected.length > 0 && recordBlocks.length > 0 && visibleBlocks.length < recordBlocks.length && (
          <p className="experiment-filter-note" role="status">
            {en ? "Showing records for the selected runs." : "仅显示所选运行的记录。"}
            <button className="button" onClick={() => setSelected([])}>
              {en ? "Show all" : "显示全部"}
            </button>
          </p>
        )}
        {visibleBlocks.length > 0 && (
          <div className="content-block-list">
            {visibleBlocks.map((block) => (
              <article className="content-block-card" key={block.id}>
                <header>
                  <div className="content-block-title">
                    <h3>{block.title}</h3>
                  </div>
                </header>
                <ContentBlockRenderer block={block} owner={owner} en={en} />
              </article>
            ))}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
