import { describe, it, expect } from "vitest";
import { parsePipelineFile, validatePipeline } from "./parser";
import path from "path";

describe("parsePipelineFile", () => {
  it("parses a valid feature pipeline YAML", async () => {
    const def = await parsePipelineFile(
      path.join(process.cwd(), "data/.pipelines/feature.yaml"),
    );
    expect(def.name).toBe("feature");
    expect(def.stages.length).toBeGreaterThan(5);
    expect(def.trigger.type).toBe("kanban_task");
  });

  it("throws on missing file", async () => {
    await expect(parsePipelineFile("/nonexistent.yaml")).rejects.toThrow();
  });
});

describe("validatePipeline", () => {
  it("rejects pipeline with invalid depends_on reference", () => {
    const bad = {
      name: "bad",
      description: "test",
      trigger: { type: "kanban_task", conditions: {} },
      variables: {},
      defaults: {
        retry: { max_attempts: 3, on_exhaustion: "needs-human" },
        timeout: "30m",
      },
      stages: [
        { id: "a", name: "A", assignee: "x" },
        { id: "b", name: "B", assignee: "y", depends_on: ["nonexistent"] },
      ],
    };
    const errors = validatePipeline(
      bad as unknown as Parameters<typeof validatePipeline>[0],
    );
    expect(errors).toContain(
      'Stage "b" depends on unknown stage "nonexistent"',
    );
  });

  it("detects circular dependencies", () => {
    const circular = {
      name: "circ",
      description: "test",
      trigger: { type: "kanban_task", conditions: {} },
      variables: {},
      defaults: {
        retry: { max_attempts: 3, on_exhaustion: "needs-human" },
        timeout: "30m",
      },
      stages: [
        { id: "a", name: "A", assignee: "x", depends_on: ["b"] },
        { id: "b", name: "B", assignee: "y", depends_on: ["a"] },
      ],
    };
    const errors = validatePipeline(
      circular as unknown as Parameters<typeof validatePipeline>[0],
    );
    expect(errors.some((e: string) => e.includes("circular"))).toBe(true);
  });
});
