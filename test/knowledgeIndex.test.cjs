const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildKnowledgeIndex, searchKnowledge, formatKnowledgeContext,
  MAX_KNOWLEDGE_FILE_BYTES, MAX_KNOWLEDGE_FILES, MAX_KNOWLEDGE_CHUNKS,
  MAX_KNOWLEDGE_CONTEXT_CHARS
} = require("../dist/knowledgeIndex.js");

test("builds chunks with markdown heading titles and stable paths", () => {
  const result = buildKnowledgeIndex([{ path: "docs/payments.md", content: "# Payment Retry\n\nRetry a failed invoice only after checking its idempotency key." }]);
  assert.equal(result.indexedFiles, 1);
  assert.equal(result.chunks[0].title, "Payment Retry");
  assert.equal(result.chunks[0].path, "docs/payments.md");
});

test("search ranks lexical matches and title/path matches higher", () => {
  const index = buildKnowledgeIndex([
    { path: "docs/general.md", content: "# Notes\n\nGeneral engineering principles and deployment notes." },
    { path: "docs/payment-retry.md", content: "# Payment Retry\n\nRetry invoice processing after checking idempotency keys." }
  ]);
  const hits = searchKnowledge(index.chunks, "payment retry invoice");
  assert.equal(hits[0].path, "docs/payment-retry.md");
  assert.ok(hits[0].score > 0);
});

test("returns no results for blank or unmatched queries and caps results", () => {
  const files = Array.from({ length: 8 }, (_, i) => ({ path: `doc-${i}.txt`, content: "shared unique token" }));
  const index = buildKnowledgeIndex(files);
  assert.deepEqual(searchKnowledge(index.chunks, "  "), []);
  assert.deepEqual(searchKnowledge(index.chunks, "nonexistent"), []);
  assert.ok(searchKnowledge(index.chunks, "shared", 100).length <= 5);
});

test("rejects oversized files and bounds file count and chunks", () => {
  const tooBig = { path: "huge.md", content: "x".repeat(MAX_KNOWLEDGE_FILE_BYTES + 1) };
  const files = [tooBig, ...Array.from({ length: MAX_KNOWLEDGE_FILES + 2 }, (_, i) => ({ path: `doc-${i}.md`, content: "# Repeated\n\n" + "word ".repeat(400) }))];
  const result = buildKnowledgeIndex(files);
  assert.ok(result.rejected.some((item) => item.path === "huge.md"));
  assert.ok(result.rejected.some((item) => item.path === "(remaining files)"));
  assert.ok(result.chunks.length <= MAX_KNOWLEDGE_CHUNKS);
});

test("formats results as bounded untrusted context with source paths", () => {
  const index = buildKnowledgeIndex([{ path: ".ai-chatbox/knowledge/runbook.md", content: "# Runbook\n\nRestart the worker after verifying queue depth." }]);
  const context = formatKnowledgeContext(searchKnowledge(index.chunks, "worker queue"));
  assert.match(context, /untrusted reference material/);
  assert.match(context, /\.ai-chatbox\/knowledge\/runbook\.md/);
  assert.ok(context.length <= MAX_KNOWLEDGE_CONTEXT_CHARS);
});

test("breaks very long paragraphs into bounded chunks", () => {
  const result = buildKnowledgeIndex([{ path: "long.txt", content: "x".repeat(4000) }]);
  assert.ok(result.chunks.length >= 2);
  assert.ok(result.chunks.every((chunk) => chunk.text.length <= 1600));
});
