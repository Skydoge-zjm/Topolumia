import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";

// The independent site changes the selected run, coordinate, numbers and final decision.
export const sites = {
  plaza: { station: "P7", other: "P9", run: "night-east", step: 4, atlas: 0.438, reed: 0.312, threshold: 0.100, offset: 0.059, otherOffset: -0.014 },
  quay: { station: "Q4", other: "Q8", run: "night-west", step: 2, atlas: 0.527, reed: 0.450, threshold: 0.090, offset: -0.032, otherOffset: 0.017 },
};
export const nodeRef = id => ({ kind: "node", id });
export const groupRef = id => ({ kind: "group", id });
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const ruleFile = "release-rule.md";
export const metric = "holdout/mae";
const number = x => Number(x.toFixed(3));
const rowsFor = (site, amended) => [
  { station: site.other, offset: site.otherOffset, scope: "reference station" },
  { station: site.station, offset: amended ? site.offset : 0, scope: amended ? "signed Reed correction" : "preliminary" },
];
const table = (columns, rows) => ({ columns: columns.map(([key, label]) => ({ key, label })), rows });
const ledgerPayload = (site, amended) => table([["station", "Station"], ["offset", "Reed offset (°C)"], ["scope", "Disposition"]], rowsFor(site, amended));
const ruleText = (s, amended) => [
  "# Alder observatory signed deployment rule", "Document status: APPROVED. Board: Municipal instrument review.",
  "Release " + (amended ? "B / station correction accepted" : "A / preliminary offset zero") + ".",
  `For station ${s.station}, use the sealed ${s.run} run, ${metric} at step ${s.step}; keep instrument comparisons in degrees Celsius.`,
  `Compute improvement = Atlas error minus Reed error. Record DEPLOY if improvement is at least ${s.threshold.toFixed(3)} °C, otherwise HOLD.`,
  "Only blind validation is eligible. Daylight pilot data used the training stations and constitute a different split.",
  amended ? "Apply the newly signed station-ledger offset to Reed only (corrected error = raw Reed error + offset). Preserve both original snapshots." :
    "Use raw blind-run values for this preliminary decision. Report single-site scope; a city-wide performance claim requires independent stations.",
].join("\n");
const fileSource = (value, id) => ({ kind: "file", value, ...(id ? { assetId: id } : {}) });
const rep = id => ({ kind: "asset", assetId: id, role: "source" });
const nodeSpecs = [
  ["paper", "paper", "Radiation shield intercomparison", { paperTitle: "A synthetic intercomparison of passive urban radiation shields", authors: ["Rina Vale"], year: 2023 }],
  ["metrology", "paper", "Traceable station metrology", { paperTitle: "Relative offsets for paired urban sensors", authors: ["Emil Park"], year: 2024 }],
  ["protocol", "note", "Field release protocol"], ["ledger", "note", "Station calibration ledger"],
  ["board", "note", "Municipal instrument review"], ["atlas", "experiment", "Atlas blind validation"],
  ["reed", "experiment", "Reed blind validation"], ["pilot", "experiment", "Reed daylight pilot"],
  ["pilotAtlas", "experiment", "Atlas archive pilot"], ["weather", "experiment", "Roof weather uptime"],
  ["logger", "note", "Logger maintenance"], ["mapping", "note", "Station exposure map"],
  ["draft", "note", "Release rule working draft"], ["quality", "note", "Independent blinding check"],
  ["handover", "note", "Operations handover register"], ["spares", "note", "Spare instrument inventory"],
];

async function register(c, actor, name, contents, mediaType) {
  return c.assets.upload(Readable.from([Buffer.from(contents)]), { originalName: name, mediaType, idempotencyKey: "fixture-" + name }, actor);
}
async function indexSources(runtime) {
  const files = await runtime.registry.filesystem.snapshot();
  runtime.state.setSnapshot({ stateVersion: "source:" + sha256(JSON.stringify(files.files.map(f => [f.ref, f.version]))), files });
  return files.files;
}
async function recordBlock(c, actor, node, ownerName, value, site) {
  const assets = [];
  const alternate = site.run === "night-east" ? "night-west" : "night-east";
  for (const [name, isTarget] of [[alternate, false], [site.run, true]]) {
    const points = Array.from({ length: 7 }, (_, step) => ({ step, value: isTarget && step === site.step ? value : number((isTarget ? 0.75 : 0.36) - step * 0.021) }));
    const raw = { runId: name, name, params: { station: isTarget ? site.station : site.other, split: "blind", firmware: "L4" },
      scalars: { [metric]: points, "training/mae": [{ step: site.step, value: 0.098 }] } };
    assets.push((await register(c, actor, ownerName + "-" + name + ".json", JSON.stringify(raw), "application/json")).id);
  }
  const index = await c.records.inspect("wandb", assets, actor);
  const view = c.changes.direct([{ op: "addBlock", owner: nodeRef(node), clientRef: "record", type: "experimentRecord", title: "Sealed validation runs",
    payload: { provider: "wandb", runs: index.runs.map(({ metrics: _metrics, ...run }) => run) }, representations: assets.map(rep) }], actor);
  const id = view.allocation["block:record"];
  const stored = c.objects.block(nodeRef(node), id);
  const run = stored.payload.runs.find(r => r.sourceId === site.run);
  return { block: id, run: run.runId, assets };
}

export async function seedObservatory(runtime, actor, workspace, variant = "plaza") {
  const site = sites[variant];
  if (!site) throw new Error("Unknown observatory site: " + variant);
  const c = runtime.researchCommands;
  const direct = ops => c.changes.direct(ops, actor);
  const allocated = direct(nodeSpecs.map(([key, kind, nodeName, more]) => ({ op: "addNode", clientRef: key, kind, core: { nodeName, ...more } }))).allocation;
  const nodes = Object.fromEntries(nodeSpecs.map(([key]) => [key, allocated["node:" + key]]));
  const groups = {};
  const addGroup = (key, name, members, parent) => {
    groups[key] = direct([{ op: "addGroup", clientRef: key, core: { nodeName: name },
      members: members.map(([n, role]) => ({ nodeId: nodes[n], role })),
      ...(parent ? { parentId: groups[parent], expectedParentRevision: c.groups.get(groups[parent]).membershipRevision } : {}),
    }]).allocation["group:" + key];
  };
  addGroup("root", "Alder heat observatory", [["board", "board"]]);
  addGroup("validation", "Sealed blind validation", [["atlas", "reference"], ["reed", "challenger"], ["quality", "blinding"]], "root");
  addGroup("operations", "Observatory operations", [["ledger", "calibration"], ["protocol", "protocol"], ["handover", "register"]], "root");
  addGroup("archive", "Superseded pilots", [["pilot", "training pilot"], ["pilotAtlas", "archived control"], ["draft", "working copy"]], "root");
  addGroup("stations", "Station field team", [["mapping", "map"], ["logger", "maintenance"], ["spares", "inventory"]], "operations");
  const link = (from, to, type) => direct([{ op: "addEdge", clientRef: "edge", edge: { from, to, type },
    expectedEndpointRevisions: [from, to].map(object => ({ object, revision: c.objects.get(object).revision })) }]);
  for (const [a, b, type] of [["paper","protocol","motivates"],["metrology","ledger","documents"],["protocol","atlas","governs"],["protocol","reed","governs"],
    ["ledger","reed","calibrates"],["quality","reed","audits"],["pilot","draft","informs"],["mapping","ledger","locates"],["weather","logger","informs"],
    ["board","handover","publishes"]]) link(nodeRef(nodes[a]), nodeRef(nodes[b]), type);
  link(groupRef(groups.validation), nodeRef(nodes.board), "reports_to");
  link(groupRef(groups.archive), nodeRef(nodes.logger), "archived_by");
  await writeFile(path.join(workspace, ruleFile), ruleText(site, false));
  await writeFile(path.join(workspace, "release-rule-draft.md"), "# Unratified early draft\nUse daylight pilot training/mae at step 1, cutoff 0.025. This memo predates the signed protocol.\n");
  await writeFile(path.join(workspace, "field-notebook.md"), "# Field register\nRoof power cycling was unrelated to the blind validation comparison.\n");
  const files = await indexSources(runtime);
  const csv = "station,shield,calibration_batch\n" + site.station + ",Reed,N4\n" + site.other + ",Atlas,N5\n";
  const basis = await register(c, actor, "instrument-register.csv", csv, "text/csv");
  const manual = await register(c, actor, "metrology-method.md", "# Traceable offsets\nApply additive offsets only to the named shield and station.", "text/markdown");
  const image = await register(c, actor, "sampling-layout.png", await sharp(Buffer.from('<svg width="320" height="110" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="110" fill="#f1f5f4"/><path d="M45 65H275" stroke="#345f60" stroke-width="3"/><circle cx="60" cy="65" r="9" fill="#4d7164"/><circle cx="245" cy="65" r="9" fill="#a16c37"/><text x="27" y="37" font-family="sans-serif">Reference</text><text x="209" y="37" font-family="sans-serif">Shield</text></svg>')).png().toBuffer(), "image/png");
  const add = (key, owner, type, title, payload, extra = {}) => ({ op: "addBlock", clientRef: key, owner, type, title, payload, ...extra });
  const note = (key, owner, title, body) => add(key, nodeRef(nodes[owner]), "richText", title, { format: "markdown", body });
  const blocks = direct([
    note("scope","protocol","Approved evidence", "Use the indexed release-rule.md for the signed release in force. The archived daylight campaign trained on the evaluation stations."),
    add("ledger", nodeRef(nodes.ledger), "table", "Signed station offsets", ledgerPayload(site, false)),
    add("register", nodeRef(nodes.ledger), "spreadsheet", "Instrument register", { format: "csv" }, { representations: [rep(basis.id)] }),
    add("source", nodeRef(nodes.metrology), "document", "Metrology original", { format: "markdown" }, { representations: [rep(manual.id)] }),
    add("map", nodeRef(nodes.mapping), "image", "Instrument layout", { alt: "Reference and shield locations on the field transect" }, { representations: [rep(image.id)] }),
    add("quote", nodeRef(nodes.paper), "quote", "External validity", { text: "A single site cannot establish a city-wide effect.", sourceRefIds: [] }),
    add("url", nodeRef(nodes.paper), "link", "Synthetic archive catalogue", { url: "https://example.org/alder/field-study" }),
    add("code", nodeRef(nodes.quality), "code", "Eligibility check", { language: "python", code: 'eligible = observations[observations["split"] == "blind"]' }),
    add("pilotMetric", nodeRef(nodes.pilot), "metric", "Daylight training score", { items: [{ name: "training/mae", value: 0.098, unit: "°C" }] }),
    add("notesFile", nodeRef(nodes.handover), "file", "Register original", { label: "Station and batch register" }, { representations: [rep(basis.id)] }),
    add("terms", groupRef(groups.validation), "richText", "Blinding certificate", { format: "markdown", body: "The field coordinator sealed both blind instruments before release. Pilot sites overlap training sites." }),
    note("draft","draft","Obsolete policy","Unofficial cutoff 0.025 °C. The Municipal instrument review did not sign this memo."),
    note("board","board","Decision vocabulary","The review register records DEPLOY or HOLD for one station. Route evidence packets to this board."),
  ]).allocation;
  direct([add("chart", nodeRef(nodes.ledger), "chart", "Field offsets by station", { chartType: "bar", dataBlockId: blocks["block:ledger"] })]);
  const atlas = await recordBlock(c, actor, nodes.atlas, "atlas", site.atlas, site);
  const reed = await recordBlock(c, actor, nodes.reed, "reed", site.reed, site);
  const source = files.find(f => f.ref === "file:" + ruleFile);
  const formal = c.snapshot(null, actor);
  const inventory = { nodes: formal.nodes.length, groups: formal.groups.length, relations: formal.topology.edges.length, blocks: formal.blocks.length,
    kinds: [...new Set(formal.nodes.map(n => n.kind))].sort(), blockTypes: [...new Set(formal.blocks.map(b => b.type))].sort(), assets: c.store.all("assets").length,
    indexedFiles: files.map(f => ({ ref: f.ref, version: f.version })), recordRuns: 4, groupDepth: 3 };
  return { variant, site, nodes, groups, ledger: blocks["block:ledger"], register: blocks["block:register"], atlas, reed,
    rule: source.ref, initialVersion: source.version, basisAsset: basis.id, basisChecksum: sha256(csv), inventory,
    initialGain: number(site.atlas - site.reed), corrected: number(site.reed + site.offset), finalGain: number(site.atlas - site.reed - site.offset) };
}

// An external researcher issues an authentic second version between native turns.
export async function issueCorrection(runtime, actor, workspace, transferRoot, oracle) {
  const { site } = oracle, c = runtime.researchCommands;
  const current = c.objects.block(nodeRef(oracle.nodes.ledger), oracle.ledger);
  c.changes.direct([{ op: "updateBlock", owner: nodeRef(oracle.nodes.ledger), blockId: oracle.ledger, expectedRevision: current.revision,
    patch: { payload: ledgerPayload(site, true) } }], actor, "QA officer signs the station correction");
  await writeFile(path.join(workspace, ruleFile), ruleText(site, true));
  const files = await indexSources(runtime);
  const certificate = "station,reed_offset_degC,release\n" + site.station + "," + site.offset.toFixed(3) + ",B\n";
  await mkdir(path.join(transferRoot, "out"), { recursive: true });
  await writeFile(path.join(transferRoot, "out", "station-certificate.csv"), certificate);
  return { revisedVersion: files.find(f => f.ref === oracle.rule).version, ledgerRevision: c.objects.block(nodeRef(oracle.nodes.ledger), oracle.ledger).revision,
    certificateChecksum: sha256(certificate) };
}
