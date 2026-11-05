import { useUiStore } from "@/shared/state/ui";

export function PageHeader({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  const locale = useUiStore((state) => state.locale);
  const titles: Record<string, string> = {
    项目: "Projects",
    研究总览: "Research overview",
    科研拓扑: "Research topology",
    研究记录: "Research record",
    实验与复核: "Experiments",
    项目协作: "Collaboration",
    工作区设置: "Workspace settings",
    "运行 Trace": "Runtime Trace",
  };
  return (
    <div className="page-title">
      <div>
        <h1>{locale === "en" ? (titles[title] ?? title) : title}</h1>
      </div>
      {action}
    </div>
  );
}
