import { useEffect } from "react";

const dictionary: Record<string, string> = {
  "Topolumia 自身的运行时，独立于项目科研环境":
    "Topolumia application runtime, independent of the project research environment",
  "当前项目的科研 Python 环境与组件检测":
    "Project Python environment and research component diagnostics",
  "所选科研环境中的框架与 GPU 能力":
    "Framework and GPU capabilities in the selected research environment",
  "当前科研环境可见的 CUDA Toolkit 编译工具，与框架运行库分别检测":
    "CUDA Toolkit visible to the research environment, checked separately from framework runtimes",
  "正在连接研究工作台…": "Connecting to the research workspace…",
  "正在读取项目上下文…": "Loading project context…",
  项目管理: "Project management",
  项目列表: "Projects",
  项目: "Projects",
  创建研究项目: "Create research project",
  研究总览: "Research overview",
  科研拓扑: "Research topology",
  研究记录: "Research record",
  实验与复核: "Experiments",
  工具与环境: "Tools & environment",
  "Agent 配置": "Agent configuration",
  配置与运行: "Setup & runtime",
  会话执行偏好: "Session execution preferences",
  工作区设置: "Workspace settings",
  "完整 Trace": "Complete Trace",
  "Agent 会话": "Agent sessions",
  "Agent 研究审阅": "Agent research review",
  登录研究工作台: "Sign in to research workspace",
  初始化研究工作台: "Initialize research workspace",
  "使用服务器账号进入你的研究项目。":
    "Use your server account to enter your research projects.",
  "创建首个服务器管理员账号。密码至少需要 12 个字符。":
    "Create the first server administrator account. The password must be at least 12 characters.",
  用户名: "Username",
  密码: "Password",
  显示名称: "Display name",
  登录: "Sign in",
  登录失败: "Sign in failed",
  项目名称: "Project name",
  "项目 ID": "Project ID",
  角色: "Role",
  状态: "Status",
  最近更新: "Last updated",
  "选择一个研究项目进入工作台；项目之间的数据、成员和 Agent 上下文彼此隔离。":
    "Choose a research project. Data, members, and Agent context are isolated between projects.",
  "选择一个隔离的研究工作区。": "Choose an isolated research workspace.",
  项目协作: "Collaboration",
  创建项目: "Create project",
  取消: "Cancel",
  返回项目列表: "Back to projects",
  "请输入项目 ID": "Enter a project ID",
  请输入项目名称: "Enter a project name",
  "项目 ID 创建后不可修改，请谨慎填写。":
    "The project ID cannot be changed after creation.",
  "ⓘ 新建项目将独立初始化以下内容":
    "ⓘ A new project initializes the following independently",
  "独立的拓扑结构 · 独立的来源连接 · 独立的实验缓存 · 独立的 Agent 历史":
    "Independent topology · source connections · experiment cache · Agent history",
  "项目路径（隔离） · /projects/{project_id}":
    "Isolated project path · /projects/{project_id}",
  当前项目: "Current project",
  "当前账号还没有可访问的研究项目。":
    "This account has no accessible research projects.",
  active: "Active",
  当前研究项目: "Current project",
  本地工作区: "Local workspace",
  科研控制面: "Research control",
  连接与运行: "Connections & runtime",
  当前研究线: "Current research line",
  研究者: "Researcher",
  折叠侧栏: "Collapse sidebar",
  收起侧栏: "Collapse sidebar",
  切换到英文: "Switch to English",
  切换到中文: "Switch to Chinese",
  退出登录: "Sign out",
  退出: "Sign out",
  研究阶段: "Research stage",
  机制解析与验证: "Mechanism analysis and validation",
  更新时间: "Updated",
  "◉　当前研究问题": "◉　Current research question",
  "当前研究项目的核心机制与证据链是否已经闭合？":
    "Is the core mechanism and evidence chain of the current project complete?",
  阶段性判断: "Interim assessment",
  "⌘　当前阶段": "⌘　Current stage",
  文献调研: "Literature review",
  机制假设: "Mechanism hypothesis",
  实验验证: "Experimental validation",
  结果分析: "Results analysis",
  "▶　下一步行动": "▶　Next action",
  处理开放研究缺口: "Address open research gaps",
  "基于已发现的线索，继续补充证据和实验验证。":
    "Continue adding evidence and experimental validation based on the available leads.",
  查看实验方案: "View experiment plan",
  "◈　证据健康度": "◈　Evidence health",
  高可信: "High confidence",
  中等可信: "Medium confidence",
  "⌘　拓扑对象数量": "⌘　Topology objects",
  文献: "Papers",
  基因: "Genes",
  蛋白: "Proteins",
  通路: "Pathways",
  实验: "Experiments",
  "△　开放缺口": "△　Open gaps",
  关键机制缺口: "Mechanism gaps",
  实验验证缺口: "Validation gaps",
  数据覆盖缺口: "Data coverage gaps",
  "●　已完成运行": "●　Completed runs",
  实验运行: "Experiment runs",
  分析任务: "Analysis tasks",
  模型构建: "Model builds",
  其他任务: "Other tasks",
  "↗　已连接适配器": "↗　Connected adapters",
  已连接: "Connected",
  "◷　最近研究活动": "◷　Recent research activity",
  查看全部: "View all",
  时间: "Time",
  类型: "Type",
  内容: "Content",
  来源: "Source",
  实验系统: "Experiment system",
  实验记录: "Experiment record",
  文献分析: "Literature analysis",
  数据分析: "Data analysis",
  任务调度: "Task scheduling",
  拓扑更新: "Topology update",
  同步研究数据并更新关联证据链: "Sync research data and update linked evidence",
  研究事件: "Research event",
  已完成: "Completed",
  "▣　证据覆盖情况": "▣　Evidence coverage",
  查看详情: "View details",
  机制相关文献: "Mechanism literature",
  基因表达数据: "Gene expression data",
  蛋白互作证据: "Protein interaction evidence",
  通路富集证据: "Pathway enrichment evidence",
  临床关联证据: "Clinical association evidence",
  "RESEARCH GRAPH": "RESEARCH GRAPH",
  "围绕问题、假设、实验与证据组织研究过程。":
    "Organize research around questions, hypotheses, experiments, and evidence.",
  "个节点 ·": "nodes ·",
  条关系: "relations",
  "当前视角 · 全局研究流": "View · Global research flow",
  "展示 · 节点卡片": "Display · Node cards",
  "搜索节点、关系或关键词": "Search nodes, relations, or keywords",
  全局研究流: "Global research flow",
  当前问题: "Current question",
  实验比较: "Experiment comparison",
  适配视图: "Fit view",
  重置布局: "Reset layout",
  研究关系图: "Research graph",
  "按住节点拖动节点，按住空白区域平移画布":
    "Drag nodes to reposition them; drag empty space to pan the canvas",
  "滚轮缩放 · 空白区域平移": "Scroll to zoom · drag empty space to pan",
  "问题 / 假设": "Questions / hypotheses",
  "文献 / 记录": "Papers / records",
  "观察 / 推论": "Observations / inferences",
  缺口: "Gaps",
  缩小: "Zoom out",
  放大: "Zoom in",
  检查器: "Inspector",
  节点详情: "Node details",
  节点类型: "Node type",
  当前状态: "Current status",
  "节点 ID": "Node ID",
  关系: "Relations",
  关联关系: "Related",
  "选择一个节点查看详情。": "Select a node to view its details.",
  科研工作流: "Research workflow",
  来源同步: "Source sync",
  局部拓扑: "Local topology",
  "Agent 探索": "Agent exploration",
  拓扑整理: "Topology curation",
  实验预览: "Experiment preview",
  "基于证据链的研究过程记录，支持溯源、复核与拓扑关联。":
    "Evidence-linked research records with provenance, review, and topology links.",
  全部: "All",
  人工记录: "Human record",
  实验结果: "Experiment result",
  拓扑变化: "Topology change",
  "搜索记录内容、节点、来源、关键词...":
    "Search records, nodes, sources, or keywords...",
  时间轴: "Timeline",
  事件类型: "Event type",
  执行者: "Actor",
  关联节点: "Linked nodes",
  来源引用: "Source references",
  记录内容: "Record content",
  记录详情: "Record details",
  证据链: "Evidence chain",
  来源文献: "Source literature",
  分析过程: "Analysis process",
  相关来源: "Related sources",
  相关节点: "Related nodes",
  加入研究记录: "Add to research record",
  标记需复核: "Mark for review",
  "比较实验运行、指标和不确定性，决定下一步研究动作。":
    "Compare experiment runs, metrics, and uncertainty to decide the next research action.",
  新建实验预览: "New experiment preview",
  训练: "Training",
  评估: "Evaluation",
  失败: "Failed",
  需复核: "Needs review",
  关键指标: "Key metrics",
  对比实验组: "Comparison runs",
  "已选择 3 个 run": "3 runs selected",
  "指标选择 ⓘ": "Metric selection ⓘ",
  主要指标: "Primary metric",
  次要指标: "Secondary metric",
  "验证集 Loss": "Validation loss",
  "验证集 Accuracy": "Validation accuracy",
  训练对比: "Training comparison",
  线性坐标: "Linear scale",
  对数坐标: "Log scale",
  "不确定性 / 种子方差": "Uncertainty / seed variance",
  复核与决策: "Review and decision",
  研究假设: "Research hypothesis",
  证据支持: "Evidence support",
  下一步实验: "Next experiment",
  标记已复核: "Mark reviewed",
  未配置: "Not configured",
  最近检查: "Last checked",
  "此页面用于配置工作区的运行时与研究偏好，影响各类 Agent 的行为、数据来源、执行策略与系统边界。":
    "Configure workspace runtime and research preferences, including Agent behavior, sources, execution policies, and system boundaries.",
  界面与项目显示偏好: "Interface and project display",
  默认视图: "Default view",
  主题色: "Theme color",
  主题风格: "Theme style",
  浅色模式: "Light mode",
  深色模式: "Dark mode",
  结果展示密度: "Result density",
  自动保存研究记录: "Auto-save research records",
  显示引用标注: "Show citation markers",
  "交互 Agent": "Interactive Agent",
  默认模型: "Default model",
  推理强度: "Reasoning effort",
  "Codex 沙箱": "Codex sandbox",
  全权限: "Full access",
  工作区可写: "Workspace writable",
  只读: "Read-only",
  审批策略: "Approval policy",
  不主动审批: "No proactive approval",
  按需审批: "Approval on request",
  启用工具调用: "Enable tool calls",
  "拓扑探索 Agent": "Topology exploration Agent",
  搜索深度: "Search depth",
  探索策略: "Exploration strategy",
  多路径探索: "Multi-path exploration",
  重点路径: "Focused paths",
  启用智能剪枝: "Enable smart pruning",
  结果排序方式: "Result ordering",
  相关性优先: "Relevance first",
  置信度优先: "Confidence first",
  "Topology Curator": "Topology Curator",
  摘要生成模型: "Summary model",
  摘要长度: "Summary length",
  自动合并相似节点: "Auto-merge similar nodes",
  研究来源与连接: "Research sources and connections",
  默认知识库: "Default knowledge base",
  学术文献库: "Academic literature",
  项目资料库: "Project materials",
  文献检索引擎: "Literature search engine",
  检索结果数量: "Search result count",
  自动更新来源: "Auto-refresh sources",
  执行与实验模拟: "Execution and experiment simulation",
  默认执行环境: "Default runtime",
  最大执行时长: "Maximum runtime",
  并发任务数: "Concurrent tasks",
  实验模拟模式: "Experiment simulation mode",
  标准模式: "Standard mode",
  运行时边界: "Runtime boundary",
  "以下设置由服务器统一管理，工作区无法修改。":
    "The following settings are managed by the server and cannot be changed here.",
  系统运行时限制: "System runtime limits",
  由服务器管理: "Server managed",
  放弃修改: "Discard changes",
  保存设置: "Save settings",
  "保存中…": "Saving…",
  "查看项目成员、角色和研究工作区权限。":
    "Review project members, roles, and workspace permissions.",
  邀请成员: "Invite member",
  添加服务器账号: "Add server account",
  成员管理: "Member management",
  "项目成员、角色、状态和当前有效权限。":
    "Project members, roles, status, and effective permissions.",
  活跃: "Active",
  全部权限: "All permissions",
  成员更新: "Member updated",
  待处理邀请: "Pending invitations",
  "邀请接受前可以撤销。": "Invitations can be revoked before acceptance.",
  "暂无待处理邀请。": "No pending invitations.",
  权限详情: "Permission details",
  显式允许: "Explicit grants",
  显式禁止: "Explicit denies",
  最终有效权限: "Effective permissions",
  "围绕研究上下文查看 Codex 对话、工具调用和候选变化。":
    "Review Codex messages, tool calls, and candidate changes in research context.",
  新建会话: "New session",
  "新建 Agent 会话": "New Agent session",
  "在当前研究项目中创建一个 Agent 会话。":
    "Create an Agent session bound to the current research project.",
  会话标题: "Session title",
  "会话 ·": "Sessions ·",
  选择会话: "Select a session",
  "选择或创建一个会话开始。": "Select or create a session to begin.",
  本地数据库: "Local database",
  本地索引: "Local index",
  不同学习率探索: "Learning rate exploration",
  创建: "Create",
  "创建一个干净的项目空间，不复制其他项目的科研状态。":
    "Create a clean project space without copying research state from another project.",
  "待复核　1": "Needs review 1",
  待验证: "Needs validation",
  低可信: "Low confidence",
  "多种 Loss 对比": "Loss comparison",
  方法学缺口: "Methodology gaps",
  基线模型对比实验: "Baseline model comparison",
  "简短（约 200 字）": "Short (about 200 words)",
  "中等（3-5 层）": "Medium (3–5 layers)",
  "中等（约 500 字）": "Medium (about 500 words)",
  角色默认权限: "Role defaults",
  "角色默认权限、显式允许、显式禁止和最终有效权限。":
    "Role defaults, explicit grants, explicit denies, and effective permissions.",
  就绪: "Ready",
  开放缺口: "Open gaps",
  模型结构消融: "Model architecture ablation",
  "失败　1": "Failed 1",
  数据集: "Dataset",
  数据增强实验: "Data augmentation experiment",
  拓扑对象数量: "Topology objects",
  探索: "Explore",
  "同步活动　": "Sync activity　",
  "完成实验运行结果同步，发现 3 个待复核指标。":
    "Completed experiment result sync; found 3 metrics needing review.",
  下一步行动: "Next action",
  相关化合物: "Related compound",
  "详细（约 1000 字）": "Detailed (about 1,000 words)",
  项目角色: "Project role",
  新建项目将独立初始化以下内容:
    "A new project initializes the following independently",
  需关注: "Needs attention",
  "训练　7": "Training 7",
  研究审阅: "Research review",
  "研究助手 Agent": "Research assistant Agent",
  "已将 2 个候选节点提交审阅。": "Submitted 2 candidate nodes for review.",
  已连接适配器: "Connected adapters",
  "已完成　· seed: {run.seed ?? 42}": "Completed · seed: {run.seed ?? 42}",
  已完成运行: "Completed runs",
  "在验证集上表现稳定，最终 acc 91.7%":
    "Stable on the validation set with final accuracy of 91.7%",
  折叠会话列表: "Collapse session list",
  证据覆盖情况: "Evidence coverage",
  证据健康度: "Evidence health",
  中文: "Chinese",
  种子测试: "Seed test",
  种子稳定性测试: "Seed stability test",
  "最大内存：8 GB　|　最大并发任务数：10　|　单次任务最大时长：480 分钟":
    "Max memory: 8 GB | max concurrent tasks: 10 | max task duration: 480 minutes",
  最近活动: "Recent activity",
  最近研究活动: "Recent research activity",
  "最终有效权限　ⓘ": "Effective permissions　ⓘ",
  作用机制: "Mechanism",
  发送: "Send",
  研究上下文: "Research context",
  会话: "Session",
  工具调用: "Tool calls",
  候选变化: "Candidate changes",
  暂无候选变化: "No candidate changes",
  接受: "Accept",
  暂缓: "Defer",
  拒绝: "Reject",
  正在生成: "Streaming",
  推理摘要: "Reasoning summary",
  执行计划: "Execution plan",
  等待审批: "Approval required",
  审批已处理: "Approval resolved",
  允许本次: "Allow once",
  回合失败: "Turn failed",
  会话状态: "Session status",
  运行中: "Running",
  完成: "Done",
  待处理: "Pending",
  信息: "Info",
  "当前会话没有可显示的 Trace。": "This session has no trace to display.",
  返回会话: "Back to session",
  "当前没有可用的 Agent profile": "No Agent profile is available",
  创建会话失败: "Failed to create session",
  消息发送失败: "Failed to send message",
  标准: "Standard",
  紧凑: "Compact",
  宽松: "Spacious",
  海蓝: "Ocean blue",
  森林绿: "Forest green",
  石墨: "Graphite",
  "浅层（1-2 层）": "Shallow (1–2 layers)",
  "深层（6-8 层）": "Deep (6–8 layers)",
  快速预览: "Quick preview",
  分钟: "minutes",
  分钟前: "minutes ago",
  发现: "Discovered",
  发现对象: "Discovered objects",
  仓库: "Repository",
  操作: "Actions",
  成员: "Member",
  权限: "Permissions",
  候选: "Candidate",
  结论产出: "Conclusion",
  提交: "Submit",
  添加: "Add",
  同步: "Sync",
  "查看　同步　···": "View　Sync　···",
  查看拓扑: "View topology",
  查看来源: "View source",
  关闭检查器: "Close inspector",
  关闭详情: "Close details",
  等待项目路径: "Waiting for project path",
  "每 30 分钟自动同步": "Automatically syncs every 30 minutes",
  "仅限当前项目（项目级隔离）": "Limited to this project (project isolation)",
  "所有数据访问与处理均在项目专用的服务器托管运行时中完成，不会直接暴露到外部网络。":
    "All data access and processing runs in the project server runtime and is not directly exposed to the public network.",
  暂无成员数据: "No member data is available.",
  "当前项目暂无成员数据。": "No member data is available for this project.",
  "请选择权限　⌄": "Select permission　⌄",
  "停止 Agent": "Stop Agent",
  "让 Codex 检查当前研究状态…":
    "Ask Codex to inspect the current research state…",
  "此调用事件没有额外载荷。": "This call has no additional payload.",
  "基于文献内容，提取关键论点，进行对比分析和机制推断。":
    "Extract key arguments from the literature, compare them, and infer mechanisms.",
  "生成了关于化合物作用机制的分析结论，并关联到相关知识节点。":
    "Generated a mechanism analysis conclusion and linked it to relevant research nodes.",
  "较小的学习率和更强的数据增强能够提升模型泛化能力，在相同数据集上能获得更低的 loss 和更高 accuracy。":
    "A smaller learning rate and stronger augmentation may improve generalization, producing lower loss and higher accuracy on the same dataset.",
  "尝试更大的 batch size（256/512），验证收敛稳定性与泛化能力的提升效果。":
    "Try larger batch sizes (256/512) to validate convergence stability and generalization gains.",
  "收敛更快，loss 更低（0.284）": "Converges faster with lower loss (0.284)",
  "存在较大方差，稳定性不足": "Has high variance and insufficient stability",
  已处理: "Processed",
  "当前项目暂无成员。": "This project has no members yet.",
  "服务器尚未返回适配器状态。": "The server has not returned adapter status.",
  "当前项目还没有可复核的实验运行。":
    "This project has no experiment runs to review.",
  "当前项目还没有研究记录。": "This project has no research records yet.",
  "当前项目还没有 Agent 会话。": "This project has no Agent sessions yet.",
};

const patterns: Array<[RegExp, string]> = [
  [/^全部　(\d+)$/, "All $1"],
  [/^训练　(\d+)$/, "Training $1"],
  [/^评估　(\d+)$/, "Evaluation $1"],
  [/^失败　(\d+)$/, "Failed $1"],
  [/^待复核　(\d+)$/, "Needs review $1"],
  [/^已选择 (\d+) 个 run$/, "$1 runs selected"],
  [/^会话 · (\d+)$/, "Sessions · $1"],
  [/^同步完成$/, "Sync completed"],
  [/^当前状态$/, "Current status"],
];

const dictionaryEntries = Object.entries(dictionary).sort(
  ([left], [right]) => right.length - left.length,
);
const reverseDictionaryEntries = Object.entries(dictionary)
  .map(([source, target]) => [target, source] as const)
  .sort(([left], [right]) => right.length - left.length);

function translateText(value: string, locale: "zh" | "en") {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const core = value.slice(
    leading.length,
    value.length - trailing.length || undefined,
  );
  if (locale === "zh") {
    let restored = core;
    for (const [source, target] of reverseDictionaryEntries)
      if (source.length > 1 && restored.includes(source))
        restored = restored.split(source).join(target);
    return `${leading}${restored}${trailing}`;
  }
  const direct = dictionary[core];
  if (direct) return `${leading}${direct}${trailing}`;
  for (const [pattern, replacement] of patterns)
    if (pattern.test(core))
      return `${leading}${core.replace(pattern, replacement)}${trailing}`;
  let translated = core;
  for (const [source, target] of dictionaryEntries)
    if (source.length > 1 && translated.includes(source))
      translated = translated.split(source).join(target);
  return `${leading}${translated}${trailing}`;
}

const textSources = new WeakMap<Text, { source: string; rendered: string }>();
const attributeSources = new WeakMap<
  Element,
  Map<string, { source: string; rendered: string }>
>();

function translateDom(root: Node, locale: "zh" | "en") {
  const parent = root instanceof Element ? root : root.parentElement;
  if (parent?.closest('[translate="no"], script, style, textarea')) return;
  const updateText = (node: Text) => {
    const currentValue = node.nodeValue ?? "",
      previous = textSources.get(node);
    const source =
      previous && previous.rendered === currentValue
        ? previous.source
        : currentValue;
    const translated = translateText(source, locale);
    if (node.nodeValue !== translated) node.nodeValue = translated;
    textSources.set(node, { source, rendered: translated });
  };
  const updateAttributes = (element: Element) => {
    const attributes =
      attributeSources.get(element) ??
      new Map<string, { source: string; rendered: string }>();
    for (const name of ["placeholder", "aria-label", "title"]) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      const previous = attributes.get(name),
        source =
          previous && previous.rendered === value ? previous.source : value;
      const translated = translateText(source, locale);
      if (value !== translated) element.setAttribute(name, translated);
      attributes.set(name, { source, rendered: translated });
    }
    attributeSources.set(element, attributes);
  };
  if (root.nodeType === Node.TEXT_NODE) {
    updateText(root as Text);
    return;
  }
  if (root instanceof Element) updateAttributes(root);
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node instanceof Element &&
          (node.getAttribute("translate") === "no" ||
            ["SCRIPT", "STYLE", "TEXTAREA"].includes(node.tagName))
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current.nodeType === Node.TEXT_NODE) updateText(current as Text);
    else if (current instanceof Element) updateAttributes(current);
  }
}

export function useLocalizedDom(locale: "zh" | "en") {
  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    const root = document.getElementById("root");
    if (!root) return;
    translateDom(root, locale);
    const observer = new MutationObserver((records) => {
      const changed = new Set<Node>();
      for (const record of records) {
        if (record.type === "childList")
          for (const node of record.addedNodes) changed.add(node);
        else changed.add(record.target);
      }
      for (const node of changed)
        if (node.isConnected) translateDom(node, locale);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["placeholder", "aria-label", "title"],
    });
    return () => observer.disconnect();
  }, [locale]);
}
