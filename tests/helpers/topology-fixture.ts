// Tests that exercise the authored example graph opt in explicitly.
// Production project runtimes always start from an empty scientific topology.
export function installTopologyFixture(app) {
  app.topologyService.demo = true;
  app.state.topology = app.topologyService.build(app.state.snapshot);
}
