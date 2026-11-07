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
  const recordBlocks = blocks.filter((block) => block.type === "experimentRecord");
  return (
    <div className="experiment-workbench" translate="no">
      <aside className="experiment-rail" aria-label={en ? "Runs" : "运行"}>
        <ExperimentRunsPanel
          nodeId={nodeId}
          blocks={blocks}
          en={en}
          canEdit={canEdit}
          onChanged={onChanged}
        />
      </aside>
      <div className="experiment-main">
        {recordBlocks.length > 0 && (
          <div className="content-block-list">
            {recordBlocks.map((block) => (
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
