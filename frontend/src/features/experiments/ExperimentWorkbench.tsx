import type { ContentBlock } from "@/features/topology/details/ContentBlockRenderer";
import { ObjectContentWorkspace } from "@/features/topology/details/ObjectContentWorkspace";
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
  collectionRevision,
  en,
  canEdit,
  onChanged,
  children,
}: {
  nodeId: string;
  owner: ResearchObjectRef;
  blocks: ContentBlock[];
  collectionRevision: number;
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
          <ObjectContentWorkspace
            owner={owner}
            en={en}
            canEdit={canEdit}
            allowAdd={false}
            collectionRevision={collectionRevision}
            initialBlocks={blocks}
            hiddenBlockIds={blocks.filter(block => block.type !== "experimentRecord").map(block => block.id)}
            nodeKind="experiment"
            onChanged={onChanged}
          />
        )}
        {children}
      </div>
    </div>
  );
}
