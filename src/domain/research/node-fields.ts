export type NodeField = { key: string; label: string; en: string; multiline?: boolean };
export const nodeKinds: Record<string, { label: string; en: string; fields: NodeField[] }> = {
  paper: { label: "文献", en: "Literature", fields: [
    { key: "authors", label: "作者", en: "Authors" },
    { key: "year", label: "发表年份", en: "Year" },
    { key: "venue", label: "会议 / 期刊", en: "Venue" },
  ] },
  experiment: { label: "实验", en: "Experiment", fields: [] },
  note: { label: "研究笔记", en: "Research note", fields: [] },
};
export const activityKinds: Record<string, [string, string]> = { meeting: ["组会 / 讨论", "Meeting"], reading: ["阅读记录", "Reading"], experimentReview: ["实验复盘", "Experiment review"], progress: ["研究进展", "Progress"], idea: ["研究想法", "Idea"] };
export const recordStatuses: Record<string, [string, string]> = { planned: ["已安排", "Planned"], draft: ["草稿", "Draft"], confirmed: ["已确认", "Confirmed"], cancelled: ["已取消", "Cancelled"] };
