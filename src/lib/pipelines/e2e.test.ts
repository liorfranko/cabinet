import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parsePipelineFile } from "./parser";
import { createRun, getReadyStages, updateStage, getRun } from "./run-manager";
import { resolveTemplate } from "./template";

const TEST_DIR = path.join(os.tmpdir(), "pipeline-e2e-" + Date.now());

describe("Pipeline E2E", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it("advances a bug pipeline from start to merge", async () => {
    const pipeline = await parsePipelineFile(
      path.join(process.cwd(), "data/.pipelines/bug.yaml"),
    );

    // Resolve initial variables
    const triggerContext = {
      trigger: {
        title: "Bug: Login fails on Safari",
        body: "Users get a crash on Safari 17",
        task_id: "t-999",
      },
    };
    const variables: Record<string, unknown> = {
      trigger: triggerContext.trigger,
    };
    for (const [key, template] of Object.entries(pipeline.variables)) {
      variables[key] = resolveTemplate(template, triggerContext);
    }

    // Create run
    const run = await createRun(
      pipeline,
      "t-999",
      "/tmp/repo",
      variables,
      TEST_DIR,
    );
    expect(run.status).toBe("running");

    // First ready stage should be "decompose" (no deps)
    let ready = getReadyStages(run, pipeline);
    expect(ready[0].id).toBe("decompose");

    // Simulate decompose completion
    let updated = await updateStage(
      run.id,
      "decompose",
      {
        status: "completed",
        outputs: {
          components: ["frontend"],
          root_cause: "Safari flex gap bug",
        },
      },
      TEST_DIR,
    );

    // Next ready: implement_fix
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("implement_fix");

    // Simulate through to merge
    updated = await updateStage(
      run.id,
      "implement_fix",
      { status: "completed" },
      TEST_DIR,
    );
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("deslop");

    updated = await updateStage(
      run.id,
      "deslop",
      { status: "completed" },
      TEST_DIR,
    );
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("create_pr");

    updated = await updateStage(
      run.id,
      "create_pr",
      {
        status: "completed",
        outputs: { pr_number: 42 },
      },
      TEST_DIR,
    );
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("reviews");

    updated = await updateStage(
      run.id,
      "reviews",
      { status: "completed" },
      TEST_DIR,
    );
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("code_simplifier");

    updated = await updateStage(
      run.id,
      "code_simplifier",
      { status: "completed" },
      TEST_DIR,
    );
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("merge");

    updated = await updateStage(
      run.id,
      "merge",
      { status: "completed" },
      TEST_DIR,
    );
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("retro");

    updated = await updateStage(
      run.id,
      "retro",
      { status: "completed" },
      TEST_DIR,
    );

    // Run should be complete
    const final = await getRun(run.id, TEST_DIR);
    expect(final?.status).toBe("completed");
  });
});
