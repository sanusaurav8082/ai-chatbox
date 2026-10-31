const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWorkflowFiles, getRunnableWorkflows } = require("../dist/workflowLoader.js");

const manifest = {
  id: "release.deploy",
  version: "1.0.0",
  name: "Deploy release",
  description: "Review and verify a release.",
  steps: [{ id: "review", type: "instruction", title: "Review", instructions: "Review changes and tests." }]
};

test("loads valid workflow JSON and exposes it through the registry", () => {
  const result = loadWorkflowFiles([{ path: "deploy.json", content: JSON.stringify(manifest) }]);
  assert.equal(result.loaded, 1);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.registry.get("release.deploy").version, "1.0.0");
});

test("rejects malformed JSON and invalid manifests without stopping other files", () => {
  const result = loadWorkflowFiles([
    { path: "broken.json", content: "{" },
    { path: "invalid.json", content: JSON.stringify({ ...manifest, version: "latest" }) },
    { path: "valid.json", content: JSON.stringify(manifest) }
  ]);
  assert.equal(result.loaded, 1);
  assert.equal(result.rejected.length, 2);
});

test("rejects oversized files and bounds the number of files considered", () => {
  const large = { path: "large.json", content: "x".repeat(20_001) };
  const result = loadWorkflowFiles([large, ...Array.from({ length: 101 }, (_, i) => ({
    path: `workflow-${i}.json`, content: JSON.stringify({ ...manifest, id: `workflow-${i}` })
  }))]);
  assert.equal(result.rejected[0].reason, "File exceeds 20000 bytes.");
  assert.ok(result.rejected.some(item => item.path === "(remaining files)"));
  assert.ok(result.loaded <= 99);
});

test("filters disabled workflows and returns copies", () => {
  const result = loadWorkflowFiles([
    { path: "enabled.json", content: JSON.stringify(manifest) },
    { path: "disabled.json", content: JSON.stringify({ ...manifest, id: "release.disabled", enabled: false }) }
  ]);
  const runnable = getRunnableWorkflows(result.registry.list());
  assert.equal(runnable.length, 1);
  runnable[0].steps[0].title = "changed";
  assert.equal(result.registry.get("release.deploy").steps[0].title, "Review");
});
