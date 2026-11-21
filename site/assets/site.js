/* All public copy stays in the HTML. The Chinese page also works without scripts. */
"use strict";

const root = document.documentElement;
const languageButton = document.getElementById("language");
const sourceText = new Map();
const storageKey = "topolumia-site-lang";
let language = "zh";
let copyReset;

function initialLanguage() {
  const requested = new URLSearchParams(location.search).get("lang");
  if (requested === "en" || requested === "zh") return requested;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    /* The site can run without local storage. */
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function localText(zh, en) {
  return language === "en" ? en : zh;
}

function setLanguage(value) {
  language = value === "en" ? "en" : "zh";
  root.lang = localText("zh-CN", "en");
  for (const [element, original] of sourceText) {
    element.textContent = localText(original, element.dataset.en);
  }
  for (const img of document.querySelectorAll("[data-en-alt]")) {
    img.dataset.zhAlt ??= img.alt;
    img.alt = localText(img.dataset.zhAlt, img.dataset.enAlt);
  }
  for (const element of document.querySelectorAll("[data-en-aria]")) {
    element.dataset.zhAria ??= element.getAttribute("aria-label");
    element.setAttribute("aria-label", localText(element.dataset.zhAria, element.dataset.enAria));
  }
  languageButton.textContent = localText("EN", "中文");
  languageButton.setAttribute("aria-label", localText("Switch to English", "切换到中文"));
  document.title = localText(
    "Topolumia · 在 AI4Research 时代，掌控你的科研。",
    "Topolumia · Take charge of your research in the AI4Research era",
  );
  document.querySelector('meta[name="description"]').content = localText(
    "Topolumia 是本地优先的人机共研工作台。把 Codex、Claude Code 和 OpenCode 的研究提议连到文献、实验曲线与原始记录。",
    "A local-first workbench for researchers and agents. Connect research proposals from Codex, Claude Code and OpenCode to papers, experiment curves and raw records.",
  );
  resetCopy();
  renderExperiment();
}

// Both sets of tabs support roving focus and standard arrow/Home/End navigation.
function bindTabs(tablist) {
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  function select(active) {
    for (const tab of tabs) {
      const selected = tab === active;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
    }
    if (active.dataset.tab === "chart") drawPlot();
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const targets = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      };
      if (!Object.hasOwn(targets, event.key)) return;
      event.preventDefault();
      const next = tabs[targets[event.key]];
      select(next);
      next.focus();
    });
  }
}

// Final values, chart, table and JSONL all read the same small demonstration dataset.
const experiments = {
  17: {
    baseline: [61, 65.4, 69.1, 71.4, 74.2, 76, 77.1, 78.4, 80.1, 81.2, 82.3, 83.2],
    method: [61, 66.1, 70.6, 73.8, 76.1, 78.2, 80.2, 81.1, 82, 83.7, 84.2, 85.2],
  },
  29: {
    baseline: [60.7, 64.3, 68.4, 72, 74.5, 76.2, 78.5, 79.3, 80.2, 81.9, 82.1, 83.4],
    method: [60.7, 65.1, 70, 71.9, 75.1, 77.3, 78.4, 80.2, 81.5, 82.7, 83.2, 83.9],
  },
  43: {
    baseline: [60.2, 65, 68.8, 71.2, 74.7, 76.4, 77.9, 78.8, 80.2, 81.1, 82, 82.6],
    method: [60.2, 65.1, 69.3, 72.8, 75, 77.5, 79.6, 81.3, 82, 83.2, 84, 84.8],
  },
};
const seedControl = document.getElementById("seed");
const plot = document.getElementById("plot");
const svgNamespace = "http://www.w3.org/2000/svg";
function svgNode(tag, attributes, label) {
  const element = document.createElementNS(svgNamespace, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (label !== undefined) element.textContent = label;
  return element;
}

function drawPlot() {
  if (plot.clientWidth === 0 || plot.clientHeight === 0) return;
  const series = experiments[seedControl.value];
  const width = plot.clientWidth,
    height = plot.clientHeight;
  const left = 28,
    right = width - 12,
    top = 10,
    bottom = height - 23;
  const x = (step) => left + (step * (right - left)) / 11;
  const y = (value) => bottom - ((value - 60) * (bottom - top)) / 30;
  const svg = svgNode("svg", {
    viewBox: "0 0 " + width + " " + height,
    role: "img",
    "aria-label":
      localText("基线和新方法的验证准确率曲线，随机种子 ", "Baseline and method validation accuracy for seed ") +
      seedControl.value,
  });
  for (const value of [60, 70, 80, 90]) {
    svg.append(
      svgNode("line", {
        x1: left,
        x2: right,
        y1: y(value),
        y2: y(value),
        stroke: "#d3dacb",
        "stroke-dasharray": "3 5",
      }),
    );
    svg.append(svgNode("text", { x: 0, y: y(value) + 4 }, String(value)));
  }
  for (const step of [0, 2, 4, 6, 8, 11]) {
    svg.append(svgNode("text", { x: x(step), y: height - 3, "text-anchor": "middle" }, String(step)));
  }
  for (const [key, stroke] of [
    ["baseline", "#975d38"],
    ["method", "#236747"],
  ]) {
    const values = series[key];
    const pts = values.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
    const style = {
      points: pts,
      fill: "none",
      stroke,
      "stroke-width": 2.7,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    };
    if (key === "baseline") style["stroke-dasharray"] = "7 5";
    svg.append(svgNode("polyline", style));
    values.forEach((v, i) =>
      svg.append(
        svgNode("circle", { cx: x(i), cy: y(v), r: i === 11 ? 4 : 2.3, fill: "#fffef9", stroke, "stroke-width": 1.5 }),
      ),
    );
  }
  plot.replaceChildren(svg);
}

function renderExperiment() {
  const seed = Number(seedControl.value);
  const run = experiments[seed];
  document.getElementById("base-value").textContent = run.baseline.at(-1).toFixed(1) + "%";
  document.getElementById("method-value").textContent = run.method.at(-1).toFixed(1) + "%";
  const tableRows = [];
  const records = [];
  run.baseline.forEach((base, step) => {
    const row = document.createElement("tr");
    for (const value of [String(step), base.toFixed(1), run.method[step].toFixed(1)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    tableRows.push(row);
    for (const name of ["baseline", "method"]) {
      records.push(JSON.stringify({ seed, run: name, step, "val/accuracy_pct": run[name][step] }));
    }
  });
  document.getElementById("values").replaceChildren(...tableRows);
  document.getElementById("raw").textContent = records.join("\n");
  document.getElementById("raw-name").textContent = "seed-" + seed + ".jsonl";
  drawPlot();
}

function resetCopy() {
  clearTimeout(copyReset);
  document.getElementById("copy-label").textContent = localText("复制", "Copy");
}

async function copyCommands() {
  const code = document.getElementById("commands");
  const label = document.getElementById("copy-label");
  clearTimeout(copyReset);
  try {
    await navigator.clipboard.writeText(code.textContent);
    label.textContent = localText("已复制", "Copied");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    label.textContent = localText("已选中，可手动复制", "Selected for copying");
  }
  copyReset = setTimeout(resetCopy, 2600);
}

for (const element of document.querySelectorAll("[data-en]")) {
  sourceText.set(element, element.textContent);
}
for (const tablist of document.querySelectorAll('[role="tablist"]')) bindTabs(tablist);
seedControl.addEventListener("change", renderExperiment);
document.getElementById("copy").addEventListener("click", copyCommands);
languageButton.addEventListener("click", () => {
  const next = language === "en" ? "zh" : "en";
  setLanguage(next);
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    /* Optional preference. */
  }
  const url = new URL(location.href);
  if (url.searchParams.has("lang")) {
    url.searchParams.set("lang", next);
    try {
      history.replaceState(null, "", url);
    } catch {
      /* Local file preview. */
    }
  }
});
setLanguage(initialLanguage());
seedControl.disabled = false;
root.classList.add("js");
if ("ResizeObserver" in window) new ResizeObserver(drawPlot).observe(plot);
else window.addEventListener("resize", drawPlot);
