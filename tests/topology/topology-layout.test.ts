import { installTopologyFixture } from "../helpers/topology-fixture.js";
import test from "node:test";
import { objectKey,nodeRef } from "../../src/domain/research/object-ref.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TopologyService } from "../../src/services/topology/topology-service.js";
import { TopologyLayoutService } from "../../src/services/topology/topology-layout-service.js";
import { startMvpServer } from "../../src/server.js";

test("ELK layout returns a deterministic, bounded top-to-bottom projection", async () => {
  const topology = new TopologyService().build();
  const service = new TopologyLayoutService();
  const first = await service.layout(topology);
  const second = await service.layout(topology);

  assert.equal(first.engine, "elk-layered");
  assert.equal(first.nodes.length, topology.nodes.length);
  assert.ok(first.edges.length >= 12);
  assert.deepEqual(first, second);

  const positions = new Map(first.nodes.map((item) => [item.id, item]));
  for (const item of first.nodes) {
    assert.ok(Number.isFinite(item.x) && Number.isFinite(item.y));
    assert.ok(item.x > 0 && item.x < 2300);
    assert.ok(item.y > 0 && item.y < 1260);
  }
  const y = (id) => positions.get(objectKey(nodeRef(id))).y;
  assert.ok(y("paper:sr3") < y("question:perception-distortion"));
  assert.ok(y("question:perception-distortion") < y("experiment:g1"));
  assert.ok(y("experiment:g1") < y("observation:perception-distortion"));
  assert.ok(y("observation:perception-distortion") < y("inference:factor-confounding"));
  assert.ok(y("inference:factor-confounding") < y("claim:conditioning-provisional"));
  assert.ok(y("claim:conditioning-provisional") < y("experiment:g3"));
  assert.equal(first.edges.some((edge) => edge.id === "e:g0-g1"), false, "comparison edges use the display comparison channel");
  assert.ok(first.edges.some((edge) => edge.id === "e:i1-claim"), "limits stays on the downward main channel");
  assert.ok(first.edges.some((edge) => edge.id === "e:claim-g3"), "requires_test stays on the downward main channel");
  assert.ok(first.edges.some((edge) => edge.id === "e:h1-g3"), "distinguished_by stays on the downward main channel");
  assert.ok(first.edges.find((edge) => edge.id === "e:g1-obs")?.sections?.length);
});

test("topology layout API exposes engine metadata and all node centers", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "topology-layout-"));
  const app = await startMvpServer({
    port: 0,
    config: { agentSessions: { historyFile: path.join(tempRoot, "history.json") } },
  });
  installTopologyFixture(app);
  try {
    const response = await fetch(`${app.url}/api/topology/layout`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.schemaVersion, "topology-layout.v1");
    assert.equal(payload.engine, "elk-layered");
    assert.equal(payload.nodes.length, 18);
    assert.equal(payload.coordinateSystem.width, 2300);
    assert.equal(payload.coordinateSystem.height, 1260);
  } finally {
    await app.agentSessionGateway.closeAll();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("semantic force layout separates weighted nodes while preserving the research direction", async () => {
  const topology = new TopologyService().build();
  const service = new TopologyLayoutService();
  const first = await service.layout(topology, { engine: "force" });
  const second = await service.layout(topology, { engine: "force" });

  assert.equal(first.engine, "semantic-force");
  assert.equal(first.nodes.length, topology.nodes.length);
  assert.equal(first.edges.length, 0, "force mode routes edges in the display layer with curves");
  assert.deepEqual(first, second);
  assert.equal(first.statistics.repulsion, "semantic-weighted");
  assert.ok(first.statistics.minNodeGap > 0.5);
  assert.equal(first.statistics.nodeOverlapCount, 0);

  const positions = new Map(first.nodes.map((item) => [item.id, item]));
  for (const item of first.nodes) {
    assert.ok(Number.isFinite(item.x) && Number.isFinite(item.y));
    assert.ok(item.x > 0 && item.x < 2300);
    assert.ok(item.y > 0 && item.y < 1260);
  }
  const y = (id) => positions.get(objectKey(nodeRef(id))).y;
  assert.ok(positions.get(objectKey(nodeRef("question:perception-distortion"))).repulsionWeight > positions.get(objectKey(nodeRef("paper:sr3"))).repulsionWeight);
  assert.ok(positions.get(objectKey(nodeRef("experiment:g1"))).repulsionWeight > positions.get(objectKey(nodeRef("note:sr3-reading"))).repulsionWeight);
  assert.ok(y("paper:sr3") < y("question:perception-distortion"));
  assert.ok(y("question:perception-distortion") < y("experiment:g1"));
  assert.ok(y("experiment:g1") < y("observation:perception-distortion"));
  assert.ok(y("observation:perception-distortion") < y("inference:factor-confounding"));
  assert.ok(y("inference:factor-confounding") < y("claim:conditioning-provisional"));
  assert.ok(y("claim:conditioning-provisional") < y("experiment:g3"));
});

test("topology layout API accepts the semantic force engine", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "topology-force-layout-"));
  const app = await startMvpServer({
    port: 0,
    config: { agentSessions: { historyFile: path.join(tempRoot, "history.json") } },
  });
  installTopologyFixture(app);
  try {
    const response = await fetch(`${app.url}/api/topology/layout?engine=force`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.engine, "semantic-force");
    assert.equal(payload.nodes.length, 18);
  } finally {
    await app.agentSessionGateway.closeAll();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});
