const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "suite.cjs");
  const workspacePath = path.resolve(__dirname, "fixtures", "workspace");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates"
    ]
  });
}

main().catch((error) => {
  console.error("VS Code extension integration tests failed:", error);
  process.exitCode = 1;
});
