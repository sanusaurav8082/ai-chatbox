const test = require("node:test");
const assert = require("node:assert/strict");
const { SkillRegistry, parseSkillManifest } = require("../dist/skillRegistry.js");

const coding = {
  id: "typescript.debugging",
  version: "1.0.0",
  name: "TypeScript debugging",
  description: "Help debug TypeScript errors",
  instructions: "Inspect the error, isolate the cause, and suggest a minimal fix.",
  keywords: ["typescript", "debugging", "compiler error"]
};

test("parses and normalizes a versioned skill manifest", () => {
  assert.deepEqual(parseSkillManifest({ ...coding, keywords: [" TypeScript ", "typescript", "DEBUGGING"] }), {
    ...coding, keywords: ["typescript", "debugging"]
  });
});

test("rejects invalid identifiers, versions, and oversized instructions", () => {
  assert.throws(() => parseSkillManifest({ ...coding, id: "../oops" }), /Skill id/);
  assert.throws(() => parseSkillManifest({ ...coding, version: "latest" }), /semantic version/);
  assert.throws(() => parseSkillManifest({ ...coding, instructions: "x".repeat(12_001) }), /at most 12000/);
});

test("selects enabled skills by keyword overlap with stable tie breaking", () => {
  const registry = new SkillRegistry();
  registry.register({ ...coding, id: "z-debug", keywords: ["typescript", "debugging"] });
  registry.register({ ...coding, id: "a-typescript", keywords: ["typescript"] });
  registry.register({ ...coding, id: "disabled", keywords: ["typescript"], enabled: false });
  const selected = registry.select("Please help debug this TypeScript compiler error");
  assert.deepEqual(selected.map((item) => item.skill.id), ["z-debug", "a-typescript"]);
  assert.equal(selected[0].score, 2);
});

test("returns cloned data and supports disabling skills", () => {
  const registry = new SkillRegistry();
  registry.register(coding);
  const listed = registry.list();
  listed[0].keywords.push("mutated");
  assert.equal(registry.list()[0].keywords.includes("mutated"), false);
  assert.equal(registry.setEnabled(coding.id, false), true);
  assert.deepEqual(registry.select("typescript debugging"), []);
  assert.equal(registry.setEnabled("missing", false), false);
});

test("selection limit is bounded and invalid limits are rejected", () => {
  const registry = new SkillRegistry();
  registry.register(coding);
  assert.deepEqual(registry.select("typescript", 0), []);
  assert.throws(() => registry.select("typescript", 6), /Selection limit/);
  assert.throws(() => registry.select("typescript", 1.5), /Selection limit/);
});
