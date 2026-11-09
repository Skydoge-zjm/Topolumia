import { AppError } from "../lib/errors.js";


export function publicProjectForApi(project) {
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    workspace: project.workspace ?? { kind: "local", directory: project.root, revision: 0 },
    status: project.status,
    role: project.membership_role ?? null,
    stateVersion: project.state_version ?? null,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

export function agentContextFromRequest(state, topologyService, body) {
  const formalNodes = state.topology?.nodes ?? [];
  const nodeById = new Map(formalNodes.map((node) => [node.id, node]));
  const formalEdges = state.topology?.edges ?? [];
  const edgeById = new Map(formalEdges.map((edge) => [edge.id, edge]));
  const nodeIds = [
    ...new Set(Array.isArray(body?.nodeIds) ? body.nodeIds.map(String) : []),
  ];
  const edgeIds = [
    ...new Set(Array.isArray(body?.edgeIds) ? body.edgeIds.map(String) : []),
  ];
  if (nodeIds.length > 80 || edgeIds.length > 160) {
    throw new AppError(
      "AGENT_CONTEXT_TOO_LARGE",
      "Agent Working Set 的节点或关系数量超过上限。",
      { status: 422 },
    );
  }
  const invalidNodeIds = nodeIds.filter((id) => !nodeById.has(id));
  const invalidEdgeIds = edgeIds.filter((id) => !edgeById.has(id));
  if (invalidNodeIds.length) {
    throw new AppError(
      "AGENT_CONTEXT_NODE_NOT_FOUND",
      "Agent Working Set 中包含不存在的拓扑节点。",
      {
        status: 422,
        detail: { nodeIds: invalidNodeIds },
      },
    );
  }
  if (invalidEdgeIds.length) {
    throw new AppError(
      "AGENT_CONTEXT_EDGE_NOT_FOUND",
      "Agent Working Set 中包含不存在的拓扑关系。",
      {
        status: 422,
        detail: { edgeIds: invalidEdgeIds },
      },
    );
  }
  const allowedSourceRefs = new Set([
    ...topologyService.sourceIndex(state.snapshot).map((item) => item.ref),
    ...formalNodes.map((item) => item.sourceRef).filter(Boolean),
    ...formalNodes.flatMap((item) => item.data?.sourceRefs ?? []),
    ...formalEdges.map((item) => item.sourceRef).filter(Boolean),
  ]);
  const sourceRefs = [
    ...new Set(
      Array.isArray(body?.sourceRefs) ? body.sourceRefs.map(String) : [],
    ),
  ];
  const invalidSourceRefs = sourceRefs.filter(
    (ref) => !allowedSourceRefs.has(ref),
  );
  if (invalidSourceRefs.length) {
    throw new AppError(
      "AGENT_CONTEXT_SOURCE_NOT_FOUND",
      "Agent Working Set 中包含未授权的 source ref。",
      {
        status: 422,
        detail: { sourceRefs: invalidSourceRefs },
      },
    );
  }
  return {
    topologyStateVersion: state.topology?.stateVersion ?? null,
    sourceStateVersion: state.snapshot?.stateVersion ?? null,
    nodeIds,
    nodes: nodeIds.map((id) => {
      const node = nodeById.get(id);
      return {
        id: node.id,
        kind: node.kind,
        code: node.code,
        label: node.label,
        summary: node.summary,
        status: node.status,
        sourceRef: node.sourceRef ?? null,
        ...(node.kind === "experiment" ? { data: node.data } : {}),
      };
    }),
    edgeIds,
    edges: edgeIds.map((id) => {
      const edge = edgeById.get(id);
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        type: edge.type,
        label: edge.label,
        status: edge.status,
      };
    }),
    sourceRefs,
  };
}
