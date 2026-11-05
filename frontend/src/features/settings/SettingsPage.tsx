import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, projectId } from "@/shared/lib/api";

import { SelectMenu } from "@/shared/ui/SelectMenu";

import { PageHeader as Header } from "@/shared/layout/PageHeader";
export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings", projectId()],
    queryFn: () => api<any>("/api/settings"),
  });
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, any>>({});
  useEffect(() => {
    const value = settings.data?.settings ?? {};
    setDraft({
      ...value,
      agent: {
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        ...(value.agent ?? {}),
      },
    });
  }, [settings.data]);
  const setValue = (path: string, value: any) =>
    setDraft((current) => {
      const next = structuredClone(current);
      let target = next;
      const keys = path.split(".");
      keys.slice(0, -1).forEach((key) => {
        target[key] ??= {};
        target = target[key];
      });
      target[keys[keys.length - 1]] = value;
      return next;
    });
  const getValue = (path: string, fallback: any): any =>
    path.split(".").reduce((value: any, key) => value?.[key], draft) ??
    fallback;
  const save = async () => {
    setSaving(true);
    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ settings: draft }),
    });
    await queryClient.invalidateQueries({
      queryKey: ["settings", projectId()],
    });
    setSaving(false);
  };
  const field = (
    label: string,
    path: string,
    options: { value: string; label: string }[] | string[],
  ) => {
    const normalized = options.map((option: any) => ({
      value: typeof option === "string" ? option : option.value,
      label: typeof option === "string" ? option : option.label,
    }));
    return (
      <label key={path}>
        <span>{label}</span>
        <SelectMenu
          value={getValue(path, normalized[0]?.value ?? "")}
          onChange={(value) => setValue(path, value)}
          ariaLabel={label}
          options={normalized}
        />
      </label>
    );
  };
  const toggle = (label: string, path: string) => (
    <label key={path}>
      <span>{label}</span>
      <button
        className={`toggle ${getValue(path, true) ? "is-on" : ""}`}
        type="button"
        onClick={() => setValue(path, !getValue(path, true))}
        aria-label={label}
      >
        <i />
      </button>
    </label>
  );
  const card = (title: string, content: React.ReactNode) => (
    <section className="setting-card">
      <h2>
        {title}
      </h2>
      {content}
    </section>
  );
  return (
    <section className="reference-page reference-settings">
      <Header
        title="工作区设置"
        action={<Link className="button" to="/agent-settings">Agent 配置</Link>}
      />
      <div className="settings-grid-ref">
        {card(
          "界面与项目显示偏好",
          <>
            {field("默认视图", "interface.defaultView", [
              "科研拓扑",
              "研究总览",
              "研究记录",
            ])}
            {field("主题色", "interface.theme", ["森林绿", "海蓝", "石墨"])}
            {field("主题风格", "interface.themeMode", ["浅色模式", "深色模式"])}
            {field("结果展示密度", "interface.density", [
              "标准",
              "紧凑",
              "宽松",
            ])}
            {toggle("自动保存研究记录", "interface.autoSaveRecords")}
            {toggle("显示引用标注", "interface.showCitations")}
          </>,
        )}
        {card(
          "拓扑探索 Agent",
          <>
            {field("搜索深度", "topology.depth", [
              "浅层（1-2 层）",
              "中等（3-5 层）",
              "深层（6-8 层）",
            ])}
            {field("探索策略", "topology.strategy", ["多路径探索", "重点路径"])}
            {toggle("启用智能剪枝", "topology.smartPruning")}
            {field("结果排序方式", "topology.sort", [
              "相关性优先",
              "置信度优先",
            ])}
          </>,
        )}
        {card(
          "Topology Curator",
          <>
            {field("摘要生成模型", "curator.model", ["Codex", "GPT-4o"])}
            {field("摘要长度", "curator.summaryLength", [
              "简短（约 200 字）",
              "中等（约 500 字）",
              "详细（约 1000 字）",
            ])}
            {toggle("自动合并相似节点", "curator.autoMerge")}
          </>,
        )}
      </div>
      <footer className="settings-actions">
        <button
          className="button"
          type="button"
          onClick={() => setDraft(settings.data?.settings ?? {})}
        >
          放弃修改
        </button>
        <button
          className="button primary"
          type="button"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "保存设置"}
        </button>
      </footer>
    </section>
  );
}
