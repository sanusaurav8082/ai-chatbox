import { RegisteredWorkflow, WorkflowRegistry, parseWorkflowManifest } from "./workflowRuntime";

export const MAX_WORKFLOW_FILES = 100;
export const MAX_WORKFLOW_FILE_BYTES = 20_000;

export interface WorkflowFile {
  path: string;
  content: string;
}

export interface WorkflowLoadResult {
  registry: WorkflowRegistry;
  loaded: number;
  rejected: Array<{ path: string; reason: string }>;
}

/** Parse bounded JSON workflow files. Workflow files are data and are never evaluated as code. */
export function loadWorkflowFiles(files: WorkflowFile[]): WorkflowLoadResult {
  const registry = new WorkflowRegistry();
  const rejected: Array<{ path: string; reason: string }> = [];
  let loaded = 0;

  for (const file of files.slice(0, MAX_WORKFLOW_FILES)) {
    if (Buffer.byteLength(file.content, "utf8") > MAX_WORKFLOW_FILE_BYTES) {
      rejected.push({ path: file.path, reason: "File exceeds 20000 bytes." });
      continue;
    }
    try {
      const manifest = parseWorkflowManifest(JSON.parse(file.content) as unknown);
      registry.register(manifest);
      loaded += 1;
    } catch (error) {
      rejected.push({
        path: file.path,
        reason: (error instanceof Error ? error.message : "Invalid JSON or workflow manifest.").slice(0, 300)
      });
    }
  }

  if (files.length > MAX_WORKFLOW_FILES) {
    rejected.push({ path: "(remaining files)", reason: `Only the first ${MAX_WORKFLOW_FILES} workflow files are loaded.` });
  }
  return { registry, loaded, rejected };
}

/** Return copies of valid workflows, excluding definitions explicitly disabled in their manifests. */
export function getRunnableWorkflows(workflows: RegisteredWorkflow[]): RegisteredWorkflow[] {
  return workflows.filter((workflow) => workflow.enabled).map((workflow) => ({
    ...workflow,
    steps: workflow.steps.map((step) => ({ ...step }))
  }));
}
