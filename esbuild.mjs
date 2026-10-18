import esbuild from "esbuild";
const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/extension.ts", "src/modelClient.ts", "src/agentRuntime.ts", "src/agentModelAdapter.ts", "src/mcpManager.ts", "src/conversationStore.ts", "src/skillRegistry.ts", "src/skillLoader.ts", "src/workflowRuntime.ts", "src/workflowLoader.ts", "src/workflowRunStore.ts", "src/knowledgeIndex.ts"],
  bundle: true, platform: "node", format: "cjs", target: "node18", outdir: "dist",
  external: ["vscode"], sourcemap: true, minify: false, logLevel: "info"
};
if (watch) { const context = await esbuild.context(options); await context.watch(); console.log("Watching extension sources..."); }
else { await esbuild.build(options); }
