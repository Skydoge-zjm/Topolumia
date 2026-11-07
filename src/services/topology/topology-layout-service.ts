import { nodeRef, groupRef, objectKey } from "../../domain/research/object-ref.js";
import ELK from "elkjs/lib/elk.bundled.js";
import { versionHash } from "../../lib/hash.js";

export const TOPOLOGY_LAYOUT_WIDTH = 2300;
export const TOPOLOGY_LAYOUT_HEIGHT = 1260;

const DEFAULT_NODE_SIZE = Object.freeze({ width: 58, height: 58 });
const NODE_SIZES = Object.freeze({
  paper: { width: 104, height: 60 },
  experiment: { width: 142, height: 64 },
  note: { width: 122, height: 68 },
});

// Display weights distinguish object types; argument roles come from edges.
export const FORCE_REPULSION_WEIGHT = Object.freeze({ paper: 0.78, experiment: 1.38, note: 1.1 });

const FORCE_RANK_Y = Object.freeze([126, 236, 350, 474, 646, 826, 972, 1082, 1172]);

// Only relations that express the main downward scientific reading flow are
// handed to ELK for edge routing. Comparison and explanatory backflow keep
// their dedicated display channels in the browser.
export const ELK_ROUTED_RELATION_TYPES = Object.freeze(new Set([
  "frames",
  "summarized_by",
  "informs",
  "motivates",
  "derives",
  "answered_by",
  "tested_by",
  "compared_in",
  "supports",
  "reveals",
  "limits",
  "requires_test",
  "distinguished_by",
]));

function nodeSize(kind) {
  return NODE_SIZES[kind] ?? DEFAULT_NODE_SIZE;
}

function rankOf(node) { return node.displayRank ?? 0; }

function rankFromRelations(topology) {
  const incoming = new Map(topology.nodes.map(node => [node.id, []]));
  for (const edge of topology.edges) if (ELK_ROUTED_RELATION_TYPES.has(edge.type) && incoming.has(edge.to) && incoming.has(edge.from)) incoming.get(edge.to).push(edge.from);
  const ranks = new Map(), visiting = new Set();
  const depth = id => {
    if (ranks.has(id)) return ranks.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const rank = Math.min(FORCE_RANK_Y.length - 1, Math.max(0, ...incoming.get(id).map(parent => depth(parent) + 1)));
    visiting.delete(id); ranks.set(id, rank); return rank;
  };
  for (const node of [...topology.nodes].sort((a, b) => a.id.localeCompare(b.id))) node.displayRank = depth(node.id);
}

function forceWeight(node) {
  return FORCE_REPULSION_WEIGHT[node.kind] ?? 1;
}

function stableUnit(value, salt = "") {
  let hash = 2166136261;
  for (const character of `${salt}:${value}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function forceClamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function forceNodeBounds(node, point) {
  const size = nodeSize(node.kind);
  const marginX = Math.max(92, size.width / 2 + 26);
  const marginY = Math.max(74, size.height / 2 + 22);
  return {
    x: forceClamp(point.x, marginX, TOPOLOGY_LAYOUT_WIDTH - marginX),
    y: forceClamp(point.y, marginY, TOPOLOGY_LAYOUT_HEIGHT - marginY),
  };
}

function forceSeedPosition(node) {
  const authoredX = Number.isFinite(node.position?.x) ? node.position.x : 770;
  const authoredY = Number.isFinite(node.position?.y) ? node.position.y : FORCE_RANK_Y[rankOf(node)] ?? 650;
  // Authored coordinates are deliberately stretched into the larger display
  // world. Small deterministic offsets break ties without introducing a new
  // random source on each request.
  const point = {
    x: 170 + authoredX * 1.43 + (stableUnit(node.id, "seed-x") - 0.5) * 42,
    y: 82 + authoredY * 0.93 + (stableUnit(node.id, "seed-y") - 0.5) * 26,
  };
  return forceNodeBounds(node, point);
}

function forceTargetPosition(node) {
  const authoredX = Number.isFinite(node.position?.x) ? node.position.x : 770;
  const rankY = FORCE_RANK_Y[rankOf(node)] ?? 650;
  const x = 170 + authoredX * 1.43;
  const y = rankY + (stableUnit(node.id, "rank-y") - 0.5) * 72;
  return forceNodeBounds(node, { x, y });
}

function portId(nodeId, side) {
  return `${nodeId}::${side.toLowerCase()}`;
}

function elkNode(node) {
  const size = nodeSize(node.kind);
  return {
    id: node.id,
    ...size,
    layoutOptions: {
      "elk.portConstraints": "FIXED_SIDE",
      "elk.partitioning.partition": String(rankOf(node)),
    },
    ports: ["NORTH", "SOUTH", "EAST", "WEST"].map((side) => ({
      id: portId(node.id, side),
      width: 1,
      height: 1,
      layoutOptions: { "elk.port.side": side },
    })),
  };
}

function elkEdge(edge) {
  return {
    id: edge.id,
    sources: [portId(edge.from, "SOUTH")],
    targets: [portId(edge.to, "NORTH")],
  };
}

function layoutVersion(topology) {
  return versionHash({
    topologyStateVersion: topology?.stateVersion ?? null,
    candidateLayerId: topology?.candidateLayer?.id ?? null,
    nodes: [
      ...(topology?.nodes ?? []),
      ...(topology?.candidateLayer?.nodes ?? []),
    ].map((node) => ({ id: node.id, kind: node.kind })),
    edges: [
      ...(topology?.edges ?? []),
      ...(topology?.candidateLayer?.edges ?? []),
    ].map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, type: edge.type })),
  });
}

function transformPoint(point, transform) {
  return {
    x: transform.offsetX + point.x * transform.scaleX,
    y: transform.offsetY + point.y * transform.scaleY,
  };
}

function normalizedLayout(elkResult, topology, version) {
  const rawNodes = elkResult.children ?? [];
  const left = Math.min(...rawNodes.map((node) => node.x ?? 0));
  const right = Math.max(...rawNodes.map((node) => (node.x ?? 0) + (node.width ?? 0)));
  const top = Math.min(...rawNodes.map((node) => node.y ?? 0));
  const bottom = Math.max(...rawNodes.map((node) => (node.y ?? 0) + (node.height ?? 0)));
  const rawWidth = Math.max(1, right - left);
  const rawHeight = Math.max(1, bottom - top);
  const margin = { x: 190, top: 58, bottom: 52 };
  const scaleY = Math.min(1, (TOPOLOGY_LAYOUT_HEIGHT - margin.top - margin.bottom) / rawHeight);
  const scaleX = Math.min(
    (TOPOLOGY_LAYOUT_WIDTH - margin.x * 2) / rawWidth,
    scaleY * 2.25,
  );
  const transform = {
    scaleX,
    scaleY,
    offsetX: (TOPOLOGY_LAYOUT_WIDTH - rawWidth * scaleX) / 2 - left * scaleX,
    offsetY: margin.top - top * scaleY,
  };
  const nodes = rawNodes.map((node) => ({
    id: node.id,
    ...transformPoint({
      x: (node.x ?? 0) + (node.width ?? 0) / 2,
      y: (node.y ?? 0) + (node.height ?? 0) / 2,
    }, transform),
  }));
  const edges = (elkResult.edges ?? []).flatMap((edge) => {
    if (!ELK_ROUTED_RELATION_TYPES.has(
      [...(topology?.edges ?? []), ...(topology?.candidateLayer?.edges ?? [])]
        .find((item) => item.id === edge.id)?.type,
    )) return [];
    const sections = (edge.sections ?? []).map((section) => ({
      startPoint: transformPoint(section.startPoint, transform),
      bendPoints: (section.bendPoints ?? []).map((point) => transformPoint(point, transform)),
      endPoint: transformPoint(section.endPoint, transform),
    }));
    return sections.length ? [{ id: edge.id, sections }] : [];
  });
  return {
    schemaVersion: "topology-layout.v1",
    engine: "elk-layered",
    topologyStateVersion: topology?.stateVersion ?? null,
    candidateLayerId: topology?.candidateLayer?.id ?? null,
    layoutVersion: version,
    coordinateSystem: { width: TOPOLOGY_LAYOUT_WIDTH, height: TOPOLOGY_LAYOUT_HEIGHT },
    nodes,
    edges,
    statistics: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      rawWidth,
      rawHeight,
      scaleX,
      scaleY,
    },
  };
}

function forceEdgeList(topology, nodeIds) {
  return [
    ...(topology?.edges ?? []),
    ...(topology?.candidateLayer?.edges ?? []),
  ].filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
}

function forceDistance(nodeA, nodeB) {
  const a = nodeSize(nodeA.kind);
  const b = nodeSize(nodeB.kind);
  const weight = (forceWeight(nodeA) + forceWeight(nodeB)) / 2;
  const wideKinds = new Set(["experiment", "note"]);
  const labelExtent = (node) => {
    const values = [node.label?.zh, node.label?.en, node.summary?.zh, node.summary?.en]
      .filter(Boolean)
      .map((value) => Array.from(String(value)).length);
    // Labels are rendered outside the shape at the current semantic zoom;
    // reserve part of their width in the collision ellipse as well.
    return Math.min(250, 48 + Math.max(0, ...values, 0) * 5.6);
  };
  const labelPadding = (labelExtent(nodeA) + labelExtent(nodeB)) / 2 + 52;
  const horizontalPadding = Math.max(
    wideKinds.has(nodeA.kind) || wideKinds.has(nodeB.kind) ? 168 : 126,
    labelPadding,
  );
  return {
    x: a.width / 2 + b.width / 2 + horizontalPadding * weight,
    y: a.height / 2 + b.height / 2 + 92 * weight,
  };
}

function forceDisplayLayout(topology, version) {
  const nodes = [
    ...(topology?.nodes ?? []),
    ...(topology?.candidateLayer?.nodes ?? []),
  ].sort((a, b) => (
    rankOf(a) - rankOf(b)
    || (a.position?.x ?? 0) - (b.position?.x ?? 0)
    || a.id.localeCompare(b.id)
  ));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = forceEdgeList(topology, nodeIds);
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const positions = nodes.map(forceSeedPosition);
  const targets = nodes.map(forceTargetPosition);
  const adjacency = edges.map((edge) => ({
    from: index.get(edge.from),
    to: index.get(edge.to),
    type: edge.type,
  })).filter((edge) => Number.isInteger(edge.from) && Number.isInteger(edge.to));
  const iterations = 190;
  let maxDisplacement = Infinity;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forces = nodes.map(() => ({ x: 0, y: 0 }));
    const cooling = 0.92 - (iteration / iterations) * 0.42;

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const p = positions[i];
        const q = positions[j];
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
          dx = (stableUnit(`${a.id}:${b.id}`, "pair-x") - 0.5) * 2;
          dy = (stableUnit(`${a.id}:${b.id}`, "pair-y") - 0.5) * 2;
        }
        const distance = Math.max(1, Math.hypot(dx, dy));
        const desired = forceDistance(a, b);
        const ellipse = Math.hypot(dx / desired.x, dy / desired.y);
        // A short-range rectangular collision force keeps labels/hit areas
        // apart. A weaker inverse-square tail prevents isolated nodes from
        // collapsing onto a single point without turning the graph into a
        // uniform cloud.
        const overlap = Math.max(0, 1 - ellipse);
        const tail = Math.max(0, 1.18 - ellipse) * 0.18;
        const magnitude = (overlap * 2.9 + tail) * ((forceWeight(a) + forceWeight(b)) / 2) * cooling;
        const nx = dx / distance;
        const ny = dy / distance;
        forces[i].x += nx * magnitude;
        forces[i].y += ny * magnitude;
        forces[j].x -= nx * magnitude;
        forces[j].y -= ny * magnitude;
      }
    }

    // Relations act as springs. Main forward relations retain a visible
    // vertical stride; comparison/backflow relations are deliberately weak so
    // they do not flatten the scientific reading direction.
    for (const edge of adjacency) {
      const a = nodes[edge.from];
      const b = nodes[edge.to];
      const p = positions[edge.from];
      const q = positions[edge.to];
      const rankDelta = rankOf(b) - rankOf(a);
      const targetY = (FORCE_RANK_Y[rankOf(b)] ?? q.y) - (FORCE_RANK_Y[rankOf(a)] ?? p.y);
      const targetX = rankDelta === 0 ? 150 : 0;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const relationStrength = ["compared_against", "extends", "alternative", "depends_on", "weakens", "insufficient_for", "requires"].includes(edge.type) ? 0.006 : 0.018;
      forces[edge.from].x += (dx - targetX) * relationStrength * cooling;
      forces[edge.from].y += (dy - targetY) * relationStrength * cooling;
      forces[edge.to].x -= (dx - targetX) * relationStrength * cooling;
      forces[edge.to].y -= (dy - targetY) * relationStrength * cooling;
    }

    for (let i = 0; i < nodes.length; i += 1) {
      // Semantic rank is a soft spring, while authored x preserves the user's
      // mental map and gives new nodes a stable landing zone.
      forces[i].y += (targets[i].y - positions[i].y) * 0.021 * cooling;
      forces[i].x += (targets[i].x - positions[i].x) * 0.009 * cooling;
      const step = Math.min(22, Math.hypot(forces[i].x, forces[i].y));
      if (step > 0) {
        const factor = step < 22 ? 1 : 22 / step;
        positions[i].x += forces[i].x * factor;
        positions[i].y += forces[i].y * factor;
      }
      positions[i] = forceNodeBounds(nodes[i], positions[i]);
    }
    maxDisplacement = Math.max(...forces.map((force) => Math.hypot(force.x, force.y)));
  }

  // Deterministic final collision relaxation. It is intentionally bounded so
  // a crowded topology remains organic instead of becoming a rigid grid.
  for (let pass = 0; pass < 28; pass += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const desired = forceDistance(nodes[i], nodes[j]);
        const p = positions[i];
        const q = positions[j];
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        const ellipse = Math.hypot(dx / desired.x, dy / desired.y);
        if (ellipse >= 1) continue;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const push = Math.min(34, (1 - ellipse) * 28);
        const nx = (Math.abs(dx) < 0.001 ? (stableUnit(`${nodes[i].id}:${nodes[j].id}`, "relax") > 0.5 ? 1 : -1) : dx / distance);
        const ny = Math.abs(dy) < 0.001 ? 0 : dy / distance;
        positions[i] = forceNodeBounds(nodes[i], { x: p.x + nx * push * 0.52, y: p.y + ny * push * 0.52 });
        positions[j] = forceNodeBounds(nodes[j], { x: q.x - nx * push * 0.52, y: q.y - ny * push * 0.52 });
        moved = true;
      }
    }
    if (!moved) break;
  }

  const centers = nodes.map((node, i) => ({
    id: node.id,
    x: positions[i].x,
    y: positions[i].y,
    repulsionWeight: forceWeight(node),
  }));
  let minGap = Infinity;
  let nodeOverlapCount = 0;
  let minNodeClearance = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const desired = forceDistance(nodes[i], nodes[j]);
      const p = positions[i];
      const q = positions[j];
      minGap = Math.min(minGap, Math.hypot((p.x - q.x) / desired.x, (p.y - q.y) / desired.y));
      const a = nodeSize(nodes[i].kind);
      const b = nodeSize(nodes[j].kind);
      const clearanceX = Math.abs(p.x - q.x) - (a.width + b.width) / 2;
      const clearanceY = Math.abs(p.y - q.y) - (a.height + b.height) / 2;
      const clearance = Math.max(clearanceX, clearanceY);
      minNodeClearance = Math.min(minNodeClearance, clearance);
      if (clearance < 0) nodeOverlapCount += 1;
    }
  }
  return {
    schemaVersion: "topology-layout.v1",
    engine: "semantic-force",
    topologyStateVersion: topology?.stateVersion ?? null,
    candidateLayerId: topology?.candidateLayer?.id ?? null,
    layoutVersion: version,
    coordinateSystem: { width: TOPOLOGY_LAYOUT_WIDTH, height: TOPOLOGY_LAYOUT_HEIGHT },
    nodes: centers,
    edges: [],
    statistics: {
      nodeCount: centers.length,
      edgeCount: edges.length,
      iterations,
      minNodeGap: Number.isFinite(minGap) ? Number(minGap.toFixed(3)) : null,
      minNodeClearance: Number.isFinite(minNodeClearance) ? Number(minNodeClearance.toFixed(3)) : null,
      nodeOverlapCount,
      maxDisplacement: Number.isFinite(maxDisplacement) ? Number(maxDisplacement.toFixed(3)) : null,
      repulsion: "semantic-weighted",
    },
  };
}

export class TopologyLayoutService {
  constructor(options = {}) {
    this.elk = options.elk ?? new ELK();
    this.cache = new Map();
    this.maxCacheEntries = Math.max(1, Number(options.maxCacheEntries ?? 12));
  }

  async layout(topology, options = {}) {
    const layoutObjects = [...(topology.nodes ?? []).map(node => ({ object: nodeRef(node.id), node })), ...(topology.groups ?? []).map(group => ({ object: groupRef(group.id), node: { id: group.id, kind: "group", label: group.core.nodeName, position: { x: 770, y: 350 } } }))];
    const displayKey = object => objectKey(object);
    const originalId = new Map(layoutObjects.map(item => [displayKey(item.object), item.object]));
    topology = { ...topology, nodes: layoutObjects.map(item => ({ ...item.node, id: displayKey(item.object), object: item.object })), edges: (topology.edges ?? []).map(edge => ({ ...edge, from: displayKey(edge.from), to: displayKey(edge.to) })) };

    rankFromRelations(topology);

    const engine = options.engine === "force" || options.engine === "semantic-force"
      ? "force"
      : "elk";
    const version = layoutVersion(topology);
    const cacheKey = `${engine}:${version}`;
    if (this.cache.has(cacheKey)) return structuredClone(this.cache.get(cacheKey));
    if (engine === "force") {
      const result = forceDisplayLayout(topology, version);
      result.nodes = result.nodes.map(item => ({ ...item, object: originalId.get(item.id) }));
      this.cache.set(cacheKey, result);
      while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
      return structuredClone(result);
    }
    const nodes = [
      ...(topology?.nodes ?? []),
      ...(topology?.candidateLayer?.nodes ?? []),
    ].sort((a, b) => (
      rankOf(a) - rankOf(b)
      || (a.position?.x ?? 0) - (b.position?.x ?? 0)
      || a.id.localeCompare(b.id)
    ));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = [
      ...(topology?.edges ?? []),
      ...(topology?.candidateLayer?.edges ?? []),
    ].filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
    const elkResult = await this.elk.layout({
      id: "research-topology",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.partitioning.activate": "true",
        "elk.spacing.nodeNode": "80",
        "elk.layered.spacing.nodeNodeBetweenLayers": "90",
        "elk.layered.spacing.edgeNodeBetweenLayers": "34",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "24",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.nodePlacement.favorStraightEdges": "true",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.unnecessaryBendpoints": "true",
        "elk.separateConnectedComponents": "false",
        "elk.randomSeed": "23",
      },
      children: nodes.map(elkNode),
      edges: edges.filter((edge) => ELK_ROUTED_RELATION_TYPES.has(edge.type)).map(elkEdge),
    });
    const result = normalizedLayout(elkResult, topology, version);
    result.nodes = result.nodes.map(item => ({ ...item, object: originalId.get(item.id) }));
    this.cache.set(cacheKey, result);
    while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
    return structuredClone(result);
  }
}
