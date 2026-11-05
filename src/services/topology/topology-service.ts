import { versionHash } from "../../lib/hash.js";
import { AppError } from "../../lib/errors.js";
import { researchNodeKinds } from "../../domain/research/node-kinds.js";
import { nodeRef, objectKey } from "../../domain/research/object-ref.js";
import {
  aggregateResearchExperiments,
  researchExperimentNodeData,
} from "../../domain/experiments/research-experiment.js";

const bilingual = (zh, en) => ({ zh, en });

/**
 * Only these kinds may enter the formal research topology. Provider runs,
 * configs, artifacts, source adapters, Agent runtime objects, and execution
 * previews stay behind the experiment/detail boundary.
 */
export const RESEARCH_NODE_KINDS = Object.freeze(new Set(researchNodeKinds));

export function isResearchNodeKind(kind) {
  return RESEARCH_NODE_KINDS.has(String(kind ?? ""));
}

function node(id, kind, code, x, y, labelZh, labelEn, summaryZh, summaryEn, options = {}) {
  return {
    id,
    kind,
    code,
    position: { x, y },
    label: bilingual(labelZh, labelEn),
    summary: bilingual(summaryZh, summaryEn),
    status: options.status ?? "active",
    sourceRef: options.sourceRef ?? null,
    tags: options.tags ?? [],
    data: options.data ?? {},
  };
}

function edge(id, from, to, type, labelZh, labelEn, options = {}) {
  return {
    id,
    from: nodeRef(from),
    to: nodeRef(to),
    revision: 1,
    type,
    label: bilingual(labelZh, labelEn),
    status: options.status ?? "active",
    sourceRef: options.sourceRef ?? null,
    strength: options.strength ?? 0.8,
  };
}

function experimentNode(summary, x, y) {
  return node(
    `experiment:${summary.id}`,
    "experiment",
    summary.code,
    x,
    y,
    summary.label.zh,
    summary.label.en,
    summary.summary.zh,
    summary.summary.en,
    {
      status: summary.status,
      tags: ["experiment", "diffusion", "super-resolution"],
      data: researchExperimentNodeData(summary),
    },
  );
}

function baseNodes(snapshot = null) {
  const experiments = new Map(
    aggregateResearchExperiments(snapshot).items.map((item) => [item.id, item]),
  );
  const experiment = (id, x, y, fallback) => experimentNode(
    experiments.get(id) ?? fallback,
    x,
    y,
  );
  const fallbackExperiment = (id, code, labelZh, labelEn, summaryZh, summaryEn, status = "needs_evidence") => ({
    id,
    code,
    status,
    label: bilingual(labelZh, labelEn),
    summary: bilingual(summaryZh, summaryEn),
    purpose: bilingual("—", "—"),
    design: {},
    controls: [],
    limitations: [],
    runSummary: { total: 0, completed: 0, failed: 0, unstable: 0, running: 0, planned: 0, observed: 0 },
    keyMetrics: {},
    metricSummary: {},
    attemptSourceCount: 0,
    detailRef: `research:experiment:${id}`,
  });

  return [
    node("paper:sr3", "paper", "P-01", 220, 92,
      "SR3 · Iterative Refinement", "SR3 · Iterative Refinement",
      "条件扩散超分的复现基线；原文设置与当前退化管线并不完全等价。", "Conditional diffusion SR baseline; its original degradation setup is not identical to the current pipeline.",
      { status: "grounded", tags: ["diffusion", "super-resolution"] }),
    node("paper:resshift", "paper", "P-02", 1260, 108,
      "ResShift · Residual Shifting", "ResShift · Residual Shifting",
      "启发我们把 noise schedule 与 conditioning 拆成独立因子，而不是直接替换模型。", "Motivates separating the noise schedule from conditioning rather than replacing the model outright.",
      { status: "grounded", tags: ["diffusion", "noise-schedule"] }),
    node("note:sr3-reading", "readingNote", "N-04", 405, 178,
      "复现笔记：先锁定退化与 evaluator", "Reproduction note: lock degradation and evaluator",
      "低分辨率退化、split、采样步数、checkpoint 与 evaluator 必须同时固定。", "Degradation, split, sampling steps, checkpoint, and evaluator must all be fixed.",
      { tags: ["paper-notes"] }),
    node("question:perception-distortion", "question", "Q-01", 770, 255,
      "退化感知条件真的改善了 ×4 超分吗？", "Does degradation-aware conditioning really improve ×4 SR?",
      "判断感知指标改善是否只是以像素保真和伪纹理为代价。", "Determine whether perceptual gains merely trade away pixel fidelity or introduce hallucinated texture.",
      { status: "active", tags: ["diffusion", "super-resolution"] }),
    node("assumption:synthetic-degradation", "assumption", "A-01", 165, 360,
      "DIV2K 合成退化足以代表目标场景", "Synthetic DIV2K degradation represents the target setting",
      "当前只有 bicubic-style 验证集，这个外推尚未验证。", "Only a bicubic-style validation set is available; this extrapolation remains untested.",
      { status: "contested" }),
    node("assumption:evaluator-stable", "assumption", "A-02", 1115, 352,
      "三组实验使用同一 evaluator", "All experiments use the same evaluator",
      "指标记录没有完整归档 LPIPS backbone 与 evaluator package version。", "The metric records do not fully archive the LPIPS backbone or evaluator package version.",
      { status: "needs_evidence" }),
    node("hypothesis:conditioning-main-effect", "hypothesis", "H-01", 670, 405,
      "conditioning 改善感知指标", "Conditioning improves perceptual metrics",
      "候选解释：conditioning 主要降低 LPIPS/FID，schedule 主要恢复 PSNR/SSIM。", "Candidate explanation: conditioning mainly lowers LPIPS/FID while the schedule restores PSNR/SSIM.",
      { status: "contested" }),
    node("hypothesis:seed-variance", "alternativeHypothesis", "H-02", 1350, 430,
      "差异主要来自 seed / sampler 方差", "Differences are mostly seed / sampler variance",
      "每个 cell 只有一个 seed，当前无法排除这一解释。", "Each cell has one seed, so this explanation cannot be ruled out.",
      { status: "needs_evidence" }),
    experiment("g0", 250, 585, fallbackExperiment("g0", "G0", "SR3 baseline", "SR3 baseline", "复现基线实验。", "Reproduction baseline experiment.")),
    experiment("g1", 640, 570, fallbackExperiment("g1", "G1", "加入 degradation encoder", "Add degradation encoder", "测试 degradation conditioning。", "Test degradation conditioning.")),
    experiment("g2", 1070, 610, fallbackExperiment("g2", "G2", "conditioning + corrected schedule", "Conditioning + corrected schedule", "测试 schedule 修正。", "Test the schedule correction.")),
    node("observation:perception-distortion", "observation", "O-01", 460, 780,
      "G1 感知更好，但像素指标下降", "G1 improves perception while pixel metrics fall",
      "LPIPS/FID 改善；PSNR/SSIM 同时下降。", "LPIPS/FID improve while PSNR/SSIM decline.",
      { status: "grounded" }),
    node("observation:schedule-recovery", "observation", "O-02", 940, 815,
      "G2 恢复像素指标并保留部分感知收益", "G2 recovers pixel metrics and retains some perceptual gain",
      "相对 G1，PSNR/SSIM 回升；LPIPS 仍优于 G0。", "Relative to G1, PSNR/SSIM recover while LPIPS remains better than G0.",
      { status: "grounded" }),
    node("gap:per-image-metrics", "gap", "GAP-01", 145, 905,
      "缺少逐图像 metric artifact", "Per-image metric artifact is missing",
      "无法判断 aggregate 改善是否由少数图像驱动。", "Cannot tell whether aggregate gains are driven by a few images.",
      { status: "needs_evidence" }),
    node("gap:seed-variance", "gap", "GAP-02", 1340, 900,
      "每个 cell 只有一个 seed", "Each cell has only one seed",
      "不能估计方差，也不能检验主效应方向是否稳定。", "Variance and stability of main-effect direction cannot be estimated.",
      { status: "needs_evidence" }),
    node("inference:factor-confounding", "inference", "I-01", 690, 982,
      "conditioning 与 schedule 仍然混杂", "Conditioning and schedule remain confounded",
      "G0→G1 与 G1→G2 是两个条件切片，尚不是完整因子设计。", "G0→G1 and G1→G2 are two conditional slices, not a complete factorial design.",
      { status: "contested" }),
    node("claim:conditioning-provisional", "claim", "C-01", 790, 1075,
      "暂不能声称 conditioning 具有稳定主效应", "A stable conditioning main effect cannot yet be claimed",
      "当前证据只支持在单一 seed 与特定 schedule 下报告观察差异。", "Current evidence only supports reporting observed differences at one seed and specific schedule.",
      { status: "provisional" }),
    experiment("g3", 825, 1185, fallbackExperiment("g3", "G3", "2×2×3 区分实验", "2×2×3 distinguishing experiment", "区分主效应、交互与 seed 方差。", "Distinguish main effects, interactions, and seed variance.", "proposed")),
  ];
}

function baseEdges() {
  return [
    edge("e:sr3-q", "paper:sr3", "question:perception-distortion", "frames", "界定问题", "frames"),
    edge("e:sr3-note", "paper:sr3", "note:sr3-reading", "summarized_by", "阅读摘记", "summarized by"),
    edge("e:note-q", "note:sr3-reading", "question:perception-distortion", "informs", "限定复现", "constrains reproduction"),
    edge("e:resshift-h1", "paper:resshift", "hypothesis:conditioning-main-effect", "motivates", "启发拆因子", "motivates factor split"),
    edge("e:q-a1", "question:perception-distortion", "assumption:synthetic-degradation", "depends_on", "依赖", "depends on", { status: "contested" }),
    edge("e:q-a2", "question:perception-distortion", "assumption:evaluator-stable", "depends_on", "依赖", "depends on", { status: "needs_evidence" }),
    edge("e:q-h1", "question:perception-distortion", "hypothesis:conditioning-main-effect", "derives", "提出", "derives"),
    edge("e:q-h2", "question:perception-distortion", "hypothesis:seed-variance", "alternative", "竞争解释", "alternative", { status: "contested" }),
    edge("e:q-g0", "question:perception-distortion", "experiment:g0", "answered_by", "先建立基线", "answered by baseline"),
    edge("e:h1-g1", "hypothesis:conditioning-main-effect", "experiment:g1", "tested_by", "由此检验", "tested by"),
    edge("e:h1-g2", "hypothesis:conditioning-main-effect", "experiment:g2", "tested_by", "部分检验", "partially tested by"),
    edge("e:g0-g1", "experiment:g0", "experiment:g1", "compared_against", "对照比较", "compared against", { strength: 0.72 }),
    edge("e:g1-g2", "experiment:g1", "experiment:g2", "extends", "继续拆分因素", "extends factor split", { strength: 0.72 }),
    edge("e:g0-obs", "experiment:g0", "observation:perception-distortion", "compared_in", "参与比较", "compared in"),
    edge("e:g1-obs", "experiment:g1", "observation:perception-distortion", "supports", "产生观察", "supports"),
    edge("e:g1-obs2", "experiment:g1", "observation:schedule-recovery", "compared_in", "参与比较", "compared in"),
    edge("e:g2-obs2", "experiment:g2", "observation:schedule-recovery", "supports", "产生观察", "supports"),
    edge("e:g0-gap", "experiment:g0", "gap:per-image-metrics", "reveals", "暴露缺口", "reveals gap", { status: "needs_evidence" }),
    edge("e:g2-gap", "experiment:g2", "gap:seed-variance", "insufficient_for", "不足以排除", "insufficient for", { status: "needs_evidence" }),
    edge("e:h2-gap", "hypothesis:seed-variance", "gap:seed-variance", "requires", "需要补齐", "requires"),
    edge("e:o1-i1", "observation:perception-distortion", "inference:factor-confounding", "supports", "支持", "supports"),
    edge("e:o2-i1", "observation:schedule-recovery", "inference:factor-confounding", "supports", "支持", "supports"),
    edge("e:i1-claim", "inference:factor-confounding", "claim:conditioning-provisional", "limits", "限制表述", "limits claim", { status: "contested" }),
    edge("e:gap-claim", "gap:seed-variance", "claim:conditioning-provisional", "weakens", "削弱", "weakens", { status: "needs_evidence" }),
    edge("e:claim-g3", "claim:conditioning-provisional", "experiment:g3", "requires_test", "要求新实验", "requires test"),
    edge("e:h1-g3", "hypothesis:conditioning-main-effect", "experiment:g3", "distinguished_by", "区分实验", "distinguished by"),
    edge("e:h2-g3", "hypothesis:seed-variance", "experiment:g3", "distinguished_by", "区分实验", "distinguished by"),
  ];
}

function sourceIndex(snapshot) {
  return [
    ...(snapshot?.git ? [snapshot.git] : []),
    ...(snapshot?.mlflow?.runs ?? []),
    ...(snapshot?.experiments?.wandb?.runs ?? []),
    ...(snapshot?.experiments?.tensorboard?.runs ?? []),
    ...(snapshot?.experiments?.simulation?.runs ?? []),
    ...(snapshot?.files?.files ?? []),
  ];
}

function attachSnapshot(nodes, snapshot) {
  if (!snapshot) return;
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const appendProvenance = (id, file) => {
    const target = byId.get(id);
    if (!target || !file?.ref) return;
    target.data = {
      ...target.data,
      sourceRefs: [...new Set([...(target.data?.sourceRefs ?? []), file.ref])],
      provenance: {
        ...(target.data?.provenance ?? {}),
        files: [...new Set([...(target.data?.provenance?.files ?? []), file.ref])],
      },
    };
  };
  for (const file of snapshot.files?.files ?? []) {
    if (/paper-notes\.md$/i.test(file.relativePath ?? "")) appendProvenance("note:sr3-reading", file);
    if (/experiment-plan\.md$/i.test(file.relativePath ?? "")) appendProvenance("experiment:g3", file);
    if (/sr3-reproduction\.ya?ml$/i.test(file.relativePath ?? "")) {
      for (const id of ["experiment:g0", "experiment:g1", "experiment:g2"]) appendProvenance(id, file);
    }
  }
}

function withoutTransient(value) {
  const cloned = structuredClone(value);
  for (const item of cloned.nodes ?? []) delete item.exploration;
  for (const item of cloned.edges ?? []) delete item.exploration;
  return cloned;
}

function topologyPayload(nodes, edges, extra = {}) {
  const formalPayload = {
    schemaVersion: "research-topology.v1",
    coordinateSystem: { width: 1540, height: 1260, direction: "top-to-bottom", layout: "authored-irregular" },
    focusNodeIds: ["question:perception-distortion", "hypothesis:conditioning-main-effect", "experiment:g1", "gap:seed-variance"].filter(id => nodes.some(node => node.id === id)),
    nodes,
    edges,
    groups: [],
    ...extra,
  };
  return {
    ...formalPayload,
    stateVersion: versionHash(withoutTransient(formalPayload)),
  };
}

function carriedMetadata(topology) {
  return {
    sourceSnapshotVersion: topology.sourceSnapshotVersion ?? null,
    integration: topology.integration ?? {},
    ...(topology.deletedNodeIds?.length ? { deletedNodeIds: topology.deletedNodeIds } : {}),
  };
}

function ensureTopologyObjects(topology) {
  for (const item of topology.nodes ?? []) {
    if (!isResearchNodeKind(item.kind)) {
      throw new AppError("TOPOLOGY_NODE_KIND_FORBIDDEN", "正式科研拓扑不允许工具、运行时或单个 run 节点。", {
        status: 422,
        detail: { id: item.id, kind: item.kind },
      });
    }
  }
}

export class TopologyService {
  withObjects(topology, nodes, edges, groups = topology.groups ?? []) {
    ensureTopologyObjects({ nodes });
    return topologyPayload(structuredClone(nodes), structuredClone(edges), { ...carriedMetadata(topology), groups: structuredClone(groups) });
  }
  constructor({ demo = true } = {}) {
    this.demo = demo;
  }

  build(snapshot = null) {
    if (!this.demo) return topologyPayload([], [], { sourceSnapshotVersion: snapshot?.stateVersion ?? null });
    const nodes = baseNodes(snapshot);
    const edges = baseEdges();
    attachSnapshot(nodes, snapshot);
    return topologyPayload(nodes, edges, {
      sourceSnapshotVersion: snapshot?.stateVersion ?? null,
      integration: {
        experimentAggregation: "Experiment nodes aggregate authored attempts and provider runs.",
        providerDetails: "MLflow, W&B, and TensorBoard remain available through the experiment detail gateway.",
        runtimeBoundary: "Git, adapters, Agent sessions, and execution previews stay outside the formal topology.",
      },
    });
  }

  mergePersistentState(baseTopology, previousTopology) {
    if (!previousTopology) return baseTopology;
    const deleted = new Set(previousTopology.deletedNodeIds ?? []);
    const nodes = structuredClone(baseTopology.nodes).filter(node => !deleted.has(node.id));
    const edges = structuredClone(baseTopology.edges).filter(edge => !(edge.from.kind === "node" && deleted.has(edge.from.id)) && !(edge.to.kind === "node" && deleted.has(edge.to.id)));
    const nodeById = new Map(nodes.map((item) => [item.id, item]));
    const edgeIds = new Set(edges.map((item) => item.id));
    const groups = structuredClone(previousTopology.groups ?? []);
    const known = ref => ref.kind === "node" ? nodeById.has(ref.id) : groups.some(group => group.id === ref.id);

    for (const previous of previousTopology.nodes ?? []) {
      if (deleted.has(previous.id)) continue;
      if (!isResearchNodeKind(previous.kind)) continue;
      const current = nodeById.get(previous.id);
      if (!current) {
        const carried = structuredClone(previous);
        delete carried.candidate;
        delete carried.candidatePatchId;
        nodes.push(carried);
        nodeById.set(carried.id, carried);
        continue;
      }
      if (previous.data?.researchRevision) {
        current.label = structuredClone(previous.label);
        current.summary = structuredClone(previous.summary);
        current.status = previous.status;
        current.data = { ...current.data, researchRevision: previous.data.researchRevision };
      }
    }

    for (const previous of previousTopology.edges ?? []) {
      if (edgeIds.has(previous.id) || !known(previous.from) || !known(previous.to)) continue;
      if (previous.candidate || previous.adapter) continue;
      edges.push(structuredClone(previous));
      edgeIds.add(previous.id);
    }
    return topologyPayload(nodes, edges, {
      sourceSnapshotVersion: baseTopology.sourceSnapshotVersion ?? null,
      integration: baseTopology.integration ?? {},
      groups,
      ...(deleted.size ? { deletedNodeIds: [...deleted] } : {}),
    });
  }

  clearCandidate(topology) {
    const nodes = structuredClone(topology.nodes).filter((item) => isResearchNodeKind(item.kind));
    const groups = structuredClone(topology.groups ?? []).filter(group => !group.deleted);
    const objects = new Set([...nodes.map(item => objectKey(nodeRef(item.id))), ...groups.map(item => objectKey({ kind: "group", id: item.id }))]);
    const edges = structuredClone(topology.edges).filter(item => objects.has(objectKey(item.from)) && objects.has(objectKey(item.to)) && !item.candidate);
    return topologyPayload(nodes, edges, { ...carriedMetadata(topology), groups });
  }

  // Execution previews are rendered in the execution/Agent surfaces, not as
  // formal research objects.
  withExecutionPreview(topology) {
    return this.clearCandidate(topology);
  }

  sourceIndex(snapshot) {
    return sourceIndex(snapshot);
  }
}
