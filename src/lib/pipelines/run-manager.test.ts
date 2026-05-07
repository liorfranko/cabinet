import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createRun, getRun, updateStage, getReadyStages } from "./run-manager";
import type { PipelineDefinition } from "./types";

const TEST_DIR = path.join(os.tmpdir(), "pipeline-test-" + Date.now());

const mockPipeline: PipelineDefinition = {
  name: "test",
  description: "test pipeline",
  trigger: { type: "kanban_task", conditions: {} },
  variables: { branch: "test/{{ trigger.task_id }}" },
  defaults: {
    retry: { max_attempts: 3, on_exhaustion: "needs-human" },
    timeout: "30m",
  },
  stages: [
    { id: "first", name: "First", assignee: "agent-a" },
    {
      id: "second",
      name: "Second",
      assignee: "agent-b",
      depends_on: ["first"],
    },
    { id: "third", name: "Third", assignee: "agent-c", depends_on: ["second"] },
  ],
};

describe("run-manager", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it("creates a run with initial stage states", async () => {
    const run = await createRun(
      mockPipeline,
      "task-1",
      "/tmp/repo",
      {},
      TEST_DIR,
    );
    expect(run.status).toBe("running");
    expect(run.stages.first.status).toBe("ready");
    expect(run.stages.second.status).toBe("blocked");
    expect(run.stages.third.status).toBe("blocked");
  });

  it("persists run to disk and reads back", async () => {
    const run = await createRun(
      mockPipeline,
      "task-1",
      "/tmp/repo",
      {},
      TEST_DIR,
    );
    const loaded = await getRun(run.id, TEST_DIR);
    expect(loaded?.id).toBe(run.id);
    expect(loaded?.stages.first.status).toBe("ready");
  });

  it("getReadyStages returns only unblocked stages", async () => {
    const run = await createRun(
      mockPipeline,
      "task-1",
      "/tmp/repo",
      {},
      TEST_DIR,
    );
    const ready = getReadyStages(run, mockPipeline);
    expect(ready.map((s) => s.id)).toEqual(["first"]);
  });

  it("unblocks downstream when stage completes", async () => {
    let run = await createRun(
      mockPipeline,
      "task-1",
      "/tmp/repo",
      {},
      TEST_DIR,
    );
    run = await updateStage(
      run.id,
      "first",
      { status: "completed", outputs: {} },
      TEST_DIR,
    );
    const ready = getReadyStages(run!, mockPipeline);
    expect(ready.map((s) => s.id)).toEqual(["second"]);
  });
});
