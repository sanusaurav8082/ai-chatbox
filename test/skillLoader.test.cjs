const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSkillFiles, formatSkillContext, MAX_SKILL_FILE_BYTES } = require("../dist/skillLoader.js");

const manifest = {
  id: "typescript.debugging",
  version: "1.0.0",
  name: "TypeScript debugging",
  description: "Help debug TypeScript errors",
  instructions: "Inspect the error and propose a minimal fix.",
  keywords: ["typescript", "debugging"]
};

test("loads valid JSON manifests and selects matching instructions", () => {
  const result = loadSkillFiles([{ path: "debug.json", content: JSON.stringify(manifest) }]);
  assert.equal(result.loaded, 1);
  assert.deepEqual(result.rejected, []);
  const selected = result.registry.select("debug this TypeScript error");
  assert.equal(selected.length, 1);
  assert.match(formatSkillContext(selected), /Inspect the error/);
  assert.match(formatSkillContext(selected), /untrusted reference material/);
});

test("rejects malformed JSON and invalid manifests without stopping other files", () => {
  const result = loadSkillFiles([
    { path: "broken.json", content: "{" },
    { path: "invalid.json", content: JSON.stringify({ ...manifest, id: "../bad" }) },
    { path: "valid.json", content: JSON.stringify(manifest) }
  ]);
  assert.equal(result.loaded, 1);
  assert.equal(result.rejected.length, 2);
});

test("rejects oversized files and bounds the number of files read", () => {
  const tooLarge = loadSkillFiles([{ path: "large.json", content: "x".repeat(MAX_SKILL_FILE_BYTES + 1) }]);
  assert.equal(tooLarge.loaded, 0);
  assert.match(tooLarge.rejected[0].reason, /20000 bytes/);
  const many = loadSkillFiles(Array.from({ length: 101 }, (_, i) => ({
    path: `${i}.json`, content: JSON.stringify({ ...manifest, id: `skill-${i}` })
  })));
  assert.equal(many.loaded, 100);
  assert.match(many.rejected.at(-1).reason, /first 100/);
});

test("does not include disabled or unrelated skills in selected context", () => {
  const result = loadSkillFiles([
    { path: "debug.json", content: JSON.stringify(manifest) },
    { path: "disabled.json", content: JSON.stringify({ ...manifest, id: "disabled", enabled: false, keywords: ["database"] }) }
  ]);
  const context = formatSkillContext(result.registry.select("typescript debugging"));
  assert.match(context, /typescript.debugging/);
  assert.doesNotMatch(context, /id=disabled/);
  assert.equal(formatSkillContext([]), "");
});
