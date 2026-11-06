/* Bilingual copy. Chinese lives in index.html; this table replaces it when EN is on. */
const en = {
  "meta.title": "Topolumia · A local-first research workbench",
  "meta.description":
    "Connect Codex, Claude Code and OpenCode, read and write research context over MCP, and organise questions, literature, hypotheses, experiments and conclusions as a topology.",
  "nav.topology": "Topology",
  "nav.agents": "Agents",
  "nav.install": "Install",
  "nav.source": "GitHub",
  "hero.title": "Research is not a chat. It is a map that keeps growing.",
  "hero.lead":
    "Topolumia is a local-first research workbench. It connects Codex, Claude Code and OpenCode, reads and writes research context over MCP, and organises questions, literature, hypotheses, experiments and conclusions as a topology you can explore. Changes proposed by an agent go to review first; you decide what enters the record.",
  "hero.primary": "Get the source on GitHub",
  "hero.secondary": "Read the tutorial",
  "hero.meta": "Node.js 22.13+ · MIT licence · Listens on 127.0.0.1 by default",
  "map.title":
    "Topology sketch: literature supports a hypothesis, an experiment verifies it and produces observations, the conclusion narrows to a gap, and an agent proposes a new lead.",
  "pillars.topology.title": "Topology first",
  "pillars.topology.body":
    "Questions, hypotheses, experiments and observations exist as nodes and relations, with node groups for tightly related material. A type core offers the minimum structure and imposes no mandatory sections.",
  "pillars.review.title": "Human review",
  "pillars.review.body":
    "An agent allowed to run tools has not thereby had its conclusions accepted. Proposals arrive with their sources, and once accepted they are written through the same formal commit path as your own edits.",
  "pillars.local.title": "Local first",
  "pillars.local.body":
    "Accounts, sessions and research data stay in local SQLite. When you need compute, Topolumia detects Python, Conda and venv on this machine or over SSH, and the agent explores with its own tools.",
  "topology.title": "Questions, hypotheses, experiments and conclusions keep their relations.",
  "topology.body":
    "Literature nodes hold bibliographic data, method notes, key figures and open questions; experiment details show metrics, curves and links from related runs. Every formal object traces back to its source, and the topology updates instead of spawning another notebook.",
  "topology.caption": "Research topology",
  "topology.alt":
    "Research topology view: literature, hypothesis, experiment and observation nodes joined by labelled relations, with node details on the right",
  "agents.title": "Agents read the context, propose changes, and you decide.",
  "agents.body":
    "Sessions run inside the native Codex, Claude Code or OpenCode runtime while Topolumia serves research interfaces over MCP. Long tasks keep running with no per-turn countdown, and you can stop a session at any time.",
  "agents.candidate.title": "Pending review · new conclusion",
  "agents.candidate.body": "From Literature 3, Literature 5 and run 20250614; linked to #Node-003.",
  "agents.candidate.accept": "Accept",
  "agents.candidate.reject": "Reject",
  "agents.caption": "Agent session",
  "agents.alt":
    "Agent session view: session history on the left, conversation with cited sources in the middle, context and approval policy on the right",
  "record.title": "Every accepted change keeps its provenance.",
  "record.body":
    "The research record lists manual edits, agent proposals, source syncs and experiment results in time order, alongside minutes from group meetings, reading, reviews and periodic activity. Logic and chronology stay separate, so looking back shows the evidence, not only the conclusion.",
  "record.caption": "Research record",
  "record.alt":
    "Research record view: events listed in time order, with record detail and evidence chain on the right",
  "install.title": "Run it on your machine.",
  "install.body":
    "You need Node.js 22.13+ (22 / 24 LTS), npm and Git. The first visit to http://127.0.0.1:5510 creates the administrator account; there is no preset password. Agent CLIs and model providers are yours to prepare.",
  "foot.source": "Source",
  "foot.docs": "Docs",
  "foot.contribute": "Contribute",
  "foot.security": "Security",
  "foot.note": "MIT licence · © 2026 Topolumia contributors",
};

const nodes = document.querySelectorAll("[data-i18n]");
const original = new Map();
for (const node of nodes) original.set(node, node.innerHTML);
const originalAlts = new Map();
for (const node of document.querySelectorAll("[data-i18n-alt]")) originalAlts.set(node, node.alt);
const originalContent = new Map();
for (const node of document.querySelectorAll("[data-i18n-content]")) originalContent.set(node, node.content);

// Inline code in a translated string is written with backticks.
const markup = text => text.replace(/`([^`]+)`/g, "<code>$1</code>");

function apply(lang) {
  const english = lang === "en";
  document.documentElement.lang = english ? "en" : "zh-CN";
  for (const node of nodes) {
    const key = node.dataset.i18n;
    if (!english) node.innerHTML = original.get(node);
    else if (en[key]) node.innerHTML = markup(en[key]);
  }
  for (const node of document.querySelectorAll("[data-i18n-alt]")) {
    const key = node.dataset.i18nAlt;
    node.alt = english && en[key] ? en[key] : originalAlts.get(node);
  }
  for (const node of document.querySelectorAll("[data-i18n-content]")) {
    const key = node.dataset.i18nContent;
    node.content = english && en[key] ? en[key] : originalContent.get(node);
  }
  const label = document.querySelector("[data-lang-label]");
  if (label) label.textContent = english ? "中文" : "EN";
  const button = document.querySelector(".lang");
  if (button) button.setAttribute("aria-label", english ? "切换到中文" : "Switch to English");
  document.title = english ? en["meta.title"] : original.get(document.querySelector("[data-i18n='meta.title']")).replace(/<[^>]+>/g, "");
  try { localStorage.setItem("topolumia-site-lang", english ? "en" : "zh"); } catch {}
}

document.querySelector(".lang").addEventListener("click", () => {
  apply(document.documentElement.lang === "en" ? "zh" : "en");
});

let saved = null;
try { saved = localStorage.getItem("topolumia-site-lang"); } catch {}
const preferred = saved || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
apply(preferred);
