export const historyKinds: Record<string, { zh: string; en: string; category: string }> = {
  "node.created": { zh: "创建了科研节点", en: "Created a research node", category: "nodes" },
  "node.updated": { zh: "修改了科研节点", en: "Updated a research node", category: "nodes" },
  "node.deleted": { zh: "删除了科研节点", en: "Deleted a research node", category: "nodes" },
  "relation.created": { zh: "建立了科研关系", en: "Created a research relation", category: "relations" },
  "relation.updated": { zh: "修改了科研关系", en: "Updated a research relation", category: "relations" },
  "relation.deleted": { zh: "移除了科研关系", en: "Removed a research relation", category: "relations" },
  "proposal.proposed": { zh: "提出了科研变更", en: "Proposed a research change", category: "proposals" },
  "proposal.revised": { zh: "修订了科研提议", en: "Revised a research proposal", category: "proposals" },
  "proposal.accepted": { zh: "确认了科研提议", en: "Accepted a research proposal", category: "proposals" },
  "proposal.rejected": { zh: "拒绝了科研提议", en: "Rejected a research proposal", category: "proposals" },
  "proposal.deferred": { zh: "暂缓了科研提议", en: "Deferred a research proposal", category: "proposals" },
  "group.created": { zh: "创建了节点组", en: "Created a node group", category: "groups" },
  "group.updated": { zh: "调整了节点组", en: "Updated a node group", category: "groups" },
  "group.deleted": { zh: "删除了节点组", en: "Deleted a node group", category: "groups" },
  "record.created": { zh: "撰写了研究记录", en: "Wrote a research record", category: "records" },
  "record.updated": { zh: "修订了研究记录", en: "Revised a research record", category: "records" },
  "record.confirmed": { zh: "确认了研究记录", en: "Confirmed a research record", category: "records" },
  "record.cancelled": { zh: "取消了研究活动", en: "Cancelled a research activity", category: "records" },
  "series.created": { zh: "创建了周期活动", en: "Created a recurring activity", category: "series" },
  "series.updated": { zh: "调整了周期活动", en: "Updated a recurring activity", category: "series" },
  "record.scheduled": { zh: "安排了研究活动", en: "Scheduled a research activity", category: "records" },
  "research.changed": { zh: "调整了科研对象", en: "Changed research objects", category: "nodes" },
};
export const historyCategories: Record<string, [string, string]> = {
  nodes: ["科研节点", "Research nodes"], relations: ["科研关系", "Relations"], proposals: ["提议与审批", "Proposals and review"],
  groups: ["节点组", "Node groups"], records: ["纪要与活动", "Notes and activities"], series: ["周期安排", "Recurring schedules"],
};
export const historyOutcomes: Record<string, [string, string]> = {
  applied: ["已生效", "Applied"], pending: ["待确认", "Pending"], rejected: ["已拒绝", "Rejected"], deferred: ["已暂缓", "Deferred"],
};
