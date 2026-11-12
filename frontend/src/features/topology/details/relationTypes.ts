export const relationTypes: Record<string, [string, string]> = {
  supports: ["支持", "Supports"],
  contradicts: ["反驳", "Contradicts"],
  depends_on: ["依赖", "Depends on"],
  tested_by: ["由实验检验", "Tested by"],
  compared_against: ["对照", "Compared against"],
  informs: ["提供参考", "Informs"],
  summarized_by: ["由此总结", "Summarized by"],
  requires: ["需要", "Requires"],
  resolves: ["解决", "Resolves"],
};
export const relationTypeLabel = (type: string, en: boolean) => relationTypes[type]?.[en ? 1 : 0] ?? type;
