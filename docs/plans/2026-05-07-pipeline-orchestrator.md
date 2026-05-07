# Pipeline Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED: Use forge:subagent-driven-development (if subagents available) or forge:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an autonomous pipeline orchestration engine to Cabinet that processes tasks through multi-agent development workflows (feature/bug/fast-track).

**Architecture:** Pipeline definitions (Hermes YAML format) define a DAG of stages. A dedicated orchestrator agent runs on a fast heartbeat, evaluates run state, dispatches work to specialist agents via Claude Code CLI conversations, handles completions/failures, and advances the pipeline. Cabinet is the control plane; external repos are the work plane.

**Tech Stack:** TypeScript, js-yaml (already installed), Cabinet's conversation-runner, task-inbox, persona-manager

**Verification Criteria:**
- [ ] Pipeline YAML files parse and validate correctly
- [ ] Template variables resolve from trigger task + upstream outputs
- [ ] Run state persists to disk and survives server restart
- [ ] Orchestrator heartbeat dispatches stages when dependencies are met
- [ ] Parallel fan-out spawns N conversations simultaneously
- [ ] Fan-in waits for all parallel stages before advancing
- [ ] Retry logic respects max_attempts and escalates on exhaustion
- [ ] Pipeline API returns run status with stage details
- [ ] End-to-end: a Cabinet task triggers a pipeline run that advances through stages

---

## Chunk 1: Pipeline Parser & Types

### Task 1: Define pipeline types

**Files:**
- Create: `src/lib/pipelines/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
export type StageStatus = "blocked" | "ready" | "in_progress" | "completed" | "failed" | "skipped";
export type RunStatus = "running" | "completed" | "failed" | "needs-human" | "cancelled";

export interface PipelineTrigger {
  type: "kanban_task";
  priority?: number;
  conditions: {
    board?: string;
    assignee?: string;
    body_contains?: string[];
  };
}

export interface PipelineDefaults {
  retry: {
    max_attempts: number;
    on_exhaustion: string;
  };
  timeout: string;
}

export interface StageOnFailure {
  retry_with?: {
    assignee: string;
    body: string;
    max_retries?: number;
  };
  goto?: string;
  inject_feedback?: boolean;
  max_loops?: number;
}

export interface FanOutAgent {
  assignee: string;
  focus: string;
}

export interface StageDefinition {
  id: string;
  name: string;
  assignee?: string;
  agents?: FanOutAgent[];
  type?: "parallel_fan_out";
  depends_on?: string[];
  condition?: string;
  skip_if?: string;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  actions?: Record<string, unknown>[];
  success_criteria?: string[];
  constraints?: string[];
  on_failure?: StageOnFailure;
  fan_in?: "all_pass";
  timeout?: string;
  preconditions?: string[];
}

export interface QualityGate {
  enabled: boolean;
  after_stages: string[];
  model?: string;
  max_rejections?: number;
  on_max_rejections?: string;
}

export interface PipelineMetrics {
  track: string[];
  alerts?: Array<{ condition: string; action: string }>;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  trigger: PipelineTrigger;
  variables: Record<string, string>;
  defaults: PipelineDefaults;
  stages: StageDefinition[];
  quality_gates?: Record<string, QualityGate>;
  metrics?: PipelineMetrics;
}

export interface StageRunState {
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  conversationId?: string;
  conversationIds?: string[];  // for parallel fan-out
  outputs?: Record<string, unknown>;
  retries: number;
  blockedBy?: string[];
  error?: string;
  failureLoop?: number;  // tracks goto loops
}

export interface PipelineRun {
  id: string;
  pipeline: string;
  triggerTaskId: string;
  targetRepo: string;
  variables: Record<string, unknown>;
  stages: Record<string, StageRunState>;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  escalationReason?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/pipelines/types.ts
git commit -m "feat(pipelines): add pipeline type definitions"
```

---

### Task 2: Pipeline YAML parser

**Files:**
- Create: `src/lib/pipelines/parser.ts`
- Test: `src/lib/pipelines/parser.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { parsePipelineFile, validatePipeline } from "./parser";
import path from "path";

describe("parsePipelineFile", () => {
  it("parses a valid feature pipeline YAML", async () => {
    const def = await parsePipelineFile(
      path.join(process.cwd(), "data/.pipelines/feature.yaml")
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
      defaults: { retry: { max_attempts: 3, on_exhaustion: "needs-human" }, timeout: "30m" },
      stages: [
        { id: "a", name: "A", assignee: "x" },
        { id: "b", name: "B", assignee: "y", depends_on: ["nonexistent"] },
      ],
    };
    const errors = validatePipeline(bad as any);
    expect(errors).toContain('Stage "b" depends on unknown stage "nonexistent"');
  });

  it("detects circular dependencies", () => {
    const circular = {
      name: "circ",
      description: "test",
      trigger: { type: "kanban_task", conditions: {} },
      variables: {},
      defaults: { retry: { max_attempts: 3, on_exhaustion: "needs-human" }, timeout: "30m" },
      stages: [
        { id: "a", name: "A", assignee: "x", depends_on: ["b"] },
        { id: "b", name: "B", assignee: "y", depends_on: ["a"] },
      ],
    };
    const errors = validatePipeline(circular as any);
    expect(errors.some((e: string) => e.includes("circular"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pipelines/parser.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement parser**

```typescript
import fs from "fs/promises";
import yaml from "js-yaml";
import type { PipelineDefinition } from "./types";

export async function parsePipelineFile(filePath: string): Promise<PipelineDefinition> {
  const raw = await fs.readFile(filePath, "utf-8");
  const doc = yaml.load(raw) as PipelineDefinition;
  if (!doc || !doc.name || !doc.stages) {
    throw new Error(`Invalid pipeline file: ${filePath}`);
  }
  return doc;
}

export async function loadAllPipelines(dir: string): Promise<PipelineDefinition[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const pipelines: PipelineDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const def = await parsePipelineFile(`${dir}/${entry.name}`);
    pipelines.push(def);
  }
  return pipelines;
}

export function validatePipeline(def: PipelineDefinition): string[] {
  const errors: string[] = [];
  const stageIds = new Set(def.stages.map((s) => s.id));

  for (const stage of def.stages) {
    if (stage.depends_on) {
      for (const dep of stage.depends_on) {
        if (!stageIds.has(dep)) {
          errors.push(`Stage "${stage.id}" depends on unknown stage "${dep}"`);
        }
      }
    }
  }

  // Check for circular dependencies via topological sort
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const stage = def.stages.find((s) => s.id === id);
    if (stage?.depends_on) {
      for (const dep of stage.depends_on) {
        if (stageIds.has(dep) && hasCycle(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const stage of def.stages) {
    visited.clear();
    visiting.clear();
    if (hasCycle(stage.id)) {
      errors.push(`Pipeline has circular dependency involving stage "${stage.id}"`);
      break;
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pipelines/parser.test.ts`
Expected: PASS (will need the YAML fixture — see Task 3)

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipelines/parser.ts src/lib/pipelines/parser.test.ts
git commit -m "feat(pipelines): YAML pipeline parser with validation"
```

---

### Task 3: Copy pipeline YAML definitions

**Files:**
- Create: `data/.pipelines/feature.yaml`
- Create: `data/.pipelines/bug.yaml`
- Create: `data/.pipelines/fast-track.yaml`

- [ ] **Step 1: Copy pipeline files from Hermes**

```bash
mkdir -p data/.pipelines
cp /Users/liorfr/.hermes/pipelines/feature.yaml data/.pipelines/feature.yaml
cp /Users/liorfr/.hermes/pipelines/bug.yaml data/.pipelines/bug.yaml
cp /Users/liorfr/.hermes/pipelines/fast-track.yaml data/.pipelines/fast-track.yaml
```

- [ ] **Step 2: Verify parser handles them**

Run: `npx vitest run src/lib/pipelines/parser.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add data/.pipelines/
git commit -m "feat(pipelines): add feature/bug/fast-track pipeline definitions"
```

---

## Chunk 2: Template Engine

### Task 4: Template resolver

**Files:**
- Create: `src/lib/pipelines/template.ts`
- Test: `src/lib/pipelines/template.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { resolveTemplate, evaluateCondition } from "./template";

describe("resolveTemplate", () => {
  const context = {
    trigger: { title: "Feature: Add OAuth", body: "Add OAuth to the login page", task_id: "t-123" },
    stages: {
      decompose: { outputs: { components: ["backend", "frontend"], test_files: ["tests/auth.test.ts"] } },
      write_spec: { outputs: { spec_file: "docs/specs/add-oauth.md" } },
    },
    run: { id: "run-abc" },
    branch: "feature/t-123-add-oauth",
  };

  it("resolves simple variable", () => {
    expect(resolveTemplate("{{ trigger.title }}", context)).toBe("Feature: Add OAuth");
  });

  it("resolves nested dot path", () => {
    expect(resolveTemplate("{{ stages.write_spec.outputs.spec_file }}", context)).toBe("docs/specs/add-oauth.md");
  });

  it("resolves slugify filter", () => {
    expect(resolveTemplate("{{ trigger.title | slugify }}", context)).toBe("feature-add-oauth");
  });

  it("resolves strip_prefix filter", () => {
    expect(resolveTemplate("{{ trigger.title | strip_prefix('Feature: ') }}", context)).toBe("Add OAuth");
  });

  it("resolves first filter on array", () => {
    expect(resolveTemplate("{{ stages.decompose.outputs.components | first }}", context)).toBe("backend");
  });

  it("resolves ternary expression", () => {
    const tpl = "{{ 'frontend-eng' if 'frontend' in stages.decompose.outputs.components else 'backend-eng' }}";
    expect(resolveTemplate(tpl, context)).toBe("frontend-eng");
  });

  it("passes through text without templates", () => {
    expect(resolveTemplate("no templates here", context)).toBe("no templates here");
  });
});

describe("evaluateCondition", () => {
  const context = {
    stages: { decompose: { outputs: { components: ["backend", "frontend"] } } },
  };

  it("evaluates 'in' expression as true", () => {
    expect(evaluateCondition("'backend' in stages.decompose.outputs.components", context)).toBe(true);
  });

  it("evaluates 'in' expression as false", () => {
    expect(evaluateCondition("'mobile' in stages.decompose.outputs.components", context)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pipelines/template.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement template resolver**

```typescript
type TemplateContext = Record<string, unknown>;

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function applyFilter(value: unknown, filter: string): unknown {
  const trimmed = filter.trim();

  if (trimmed === "slugify") {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  if (trimmed === "first") {
    return Array.isArray(value) ? value[0] : value;
  }
  if (trimmed === "last") {
    return Array.isArray(value) ? value[value.length - 1] : value;
  }

  const stripMatch = trimmed.match(/^strip_prefix\(['"](.+)['"]\)$/);
  if (stripMatch) {
    const prefix = stripMatch[1];
    const str = String(value);
    return str.startsWith(prefix) ? str.slice(prefix.length) : str;
  }

  return value;
}

function resolveSingleExpression(expr: string, context: TemplateContext): string {
  const trimmed = expr.trim();

  // Ternary: value if condition else other
  const ternaryMatch = trimmed.match(/^(.+?)\s+if\s+(.+?)\s+else\s+(.+)$/);
  if (ternaryMatch) {
    const [, trueVal, condition, falseVal] = ternaryMatch;
    const result = evaluateCondition(condition, context);
    const chosen = result ? trueVal.trim() : falseVal.trim();
    // Strip quotes from string literals
    const unquoted = chosen.replace(/^['"]|['"]$/g, "");
    return unquoted;
  }

  // Variable with optional filters: path | filter1 | filter2
  const parts = trimmed.split("|").map((p) => p.trim());
  const varPath = parts[0];
  let value = getNestedValue(context, varPath);

  for (let i = 1; i < parts.length; i++) {
    value = applyFilter(value, parts[i]);
  }

  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export function resolveTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, expr) => {
    return resolveSingleExpression(expr, context);
  });
}

export function evaluateCondition(condition: string, context: TemplateContext): boolean {
  // Handle: 'value' in path.to.array
  const inMatch = condition.match(/^['"](.+?)['"]\s+in\s+(.+)$/);
  if (inMatch) {
    const [, needle, hayPath] = inMatch;
    const haystack = getNestedValue(context, hayPath.trim());
    if (Array.isArray(haystack)) return haystack.includes(needle);
    if (typeof haystack === "string") return haystack.includes(needle);
    return false;
  }

  // Handle: path == 'value'
  const eqMatch = condition.match(/^(.+?)\s*==\s*['"](.+?)['"]$/);
  if (eqMatch) {
    const val = getNestedValue(context, eqMatch[1].trim());
    return String(val) === eqMatch[2];
  }

  // Handle: file_exists('path') — always false at plan time, evaluated at runtime
  if (condition.startsWith("file_exists(")) return false;

  return false;
}

export function resolveInputs(
  inputs: Record<string, string> | undefined,
  context: TemplateContext
): Record<string, string> {
  if (!inputs) return {};
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    resolved[key] = resolveTemplate(value, context);
  }
  return resolved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pipelines/template.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipelines/template.ts src/lib/pipelines/template.test.ts
git commit -m "feat(pipelines): Jinja-like template engine for variable resolution"
```

---

## Chunk 3: Run State Manager

### Task 5: Run state manager

**Files:**
- Create: `src/lib/pipelines/run-manager.ts`
- Test: `src/lib/pipelines/run-manager.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  createRun,
  getRun,
  updateStage,
  listActiveRuns,
  getReadyStages,
} from "./run-manager";
import type { PipelineDefinition } from "./types";

const TEST_DIR = path.join(os.tmpdir(), "pipeline-test-" + Date.now());

const mockPipeline: PipelineDefinition = {
  name: "test",
  description: "test pipeline",
  trigger: { type: "kanban_task", conditions: {} },
  variables: { branch: "test/{{ trigger.task_id }}" },
  defaults: { retry: { max_attempts: 3, on_exhaustion: "needs-human" }, timeout: "30m" },
  stages: [
    { id: "first", name: "First", assignee: "agent-a" },
    { id: "second", name: "Second", assignee: "agent-b", depends_on: ["first"] },
    { id: "third", name: "Third", assignee: "agent-c", depends_on: ["second"] },
  ],
};

describe("run-manager", () => {
  beforeEach(async () => { await fs.mkdir(TEST_DIR, { recursive: true }); });
  afterEach(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }); });

  it("creates a run with initial stage states", async () => {
    const run = await createRun(mockPipeline, "task-1", "/tmp/repo", {}, TEST_DIR);
    expect(run.status).toBe("running");
    expect(run.stages.first.status).toBe("ready");
    expect(run.stages.second.status).toBe("blocked");
    expect(run.stages.third.status).toBe("blocked");
  });

  it("persists run to disk and reads back", async () => {
    const run = await createRun(mockPipeline, "task-1", "/tmp/repo", {}, TEST_DIR);
    const loaded = await getRun(run.id, TEST_DIR);
    expect(loaded?.id).toBe(run.id);
    expect(loaded?.stages.first.status).toBe("ready");
  });

  it("getReadyStages returns only unblocked stages", async () => {
    const run = await createRun(mockPipeline, "task-1", "/tmp/repo", {}, TEST_DIR);
    const ready = getReadyStages(run, mockPipeline);
    expect(ready.map((s) => s.id)).toEqual(["first"]);
  });

  it("unblocks downstream when stage completes", async () => {
    let run = await createRun(mockPipeline, "task-1", "/tmp/repo", {}, TEST_DIR);
    run = await updateStage(run.id, "first", { status: "completed", outputs: {} }, TEST_DIR);
    const ready = getReadyStages(run!, mockPipeline);
    expect(ready.map((s) => s.id)).toEqual(["second"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pipelines/run-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement run manager**

```typescript
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import type { PipelineDefinition, PipelineRun, StageRunState, StageStatus, StageDefinition } from "./types";
import { evaluateCondition } from "./template";
import { DATA_DIR } from "@/lib/storage/path-utils";

const DEFAULT_RUNS_DIR = path.join(DATA_DIR, ".agents/.pipelines/runs");

function runsDir(baseDir?: string): string {
  return baseDir || DEFAULT_RUNS_DIR;
}

export async function createRun(
  pipeline: PipelineDefinition,
  triggerTaskId: string,
  targetRepo: string,
  resolvedVariables: Record<string, unknown>,
  baseDir?: string
): Promise<PipelineRun> {
  const dir = runsDir(baseDir);
  await fs.mkdir(dir, { recursive: true });

  const stages: Record<string, StageRunState> = {};
  for (const stage of pipeline.stages) {
    const hasDeps = stage.depends_on && stage.depends_on.length > 0;
    stages[stage.id] = {
      status: hasDeps ? "blocked" : "ready",
      retries: 0,
      blockedBy: stage.depends_on || undefined,
    };
  }

  const run: PipelineRun = {
    id: `run-${randomUUID().slice(0, 8)}`,
    pipeline: pipeline.name,
    triggerTaskId,
    targetRepo,
    variables: resolvedVariables,
    stages,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(dir, `${run.id}.json`), JSON.stringify(run, null, 2));
  return run;
}

export async function getRun(runId: string, baseDir?: string): Promise<PipelineRun | null> {
  const filePath = path.join(runsDir(baseDir), `${runId}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveRun(run: PipelineRun, baseDir?: string): Promise<void> {
  const dir = runsDir(baseDir);
  await fs.mkdir(dir, { recursive: true });
  run.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, `${run.id}.json`), JSON.stringify(run, null, 2));
}

export async function updateStage(
  runId: string,
  stageId: string,
  updates: Partial<StageRunState>,
  baseDir?: string
): Promise<PipelineRun | null> {
  const run = await getRun(runId, baseDir);
  if (!run || !run.stages[stageId]) return null;

  Object.assign(run.stages[stageId], updates);

  // If completed/skipped, check if we can unblock downstream
  if (updates.status === "completed" || updates.status === "skipped") {
    for (const [id, state] of Object.entries(run.stages)) {
      if (state.status !== "blocked") continue;
      if (state.blockedBy) {
        const allDepsResolved = state.blockedBy.every((dep) => {
          const depState = run.stages[dep];
          return depState && (depState.status === "completed" || depState.status === "skipped");
        });
        if (allDepsResolved) {
          run.stages[id].status = "ready";
        }
      }
    }
  }

  // Check if run is done
  const allStages = Object.values(run.stages);
  const allDone = allStages.every((s) =>
    s.status === "completed" || s.status === "skipped" || s.status === "failed"
  );
  if (allDone) {
    const anyFailed = allStages.some((s) => s.status === "failed");
    run.status = anyFailed ? "failed" : "completed";
    run.completedAt = new Date().toISOString();
  }

  await saveRun(run, baseDir);
  return run;
}

export async function listActiveRuns(baseDir?: string): Promise<PipelineRun[]> {
  const dir = runsDir(baseDir);
  try {
    const entries = await fs.readdir(dir);
    const runs: PipelineRun[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, entry), "utf-8");
        const run: PipelineRun = JSON.parse(raw);
        if (run.status === "running") runs.push(run);
      } catch { /* skip */ }
    }
    return runs;
  } catch {
    return [];
  }
}

export function getReadyStages(run: PipelineRun, pipeline: PipelineDefinition): StageDefinition[] {
  return pipeline.stages.filter((stage) => {
    const state = run.stages[stage.id];
    return state && state.status === "ready";
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pipelines/run-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipelines/run-manager.ts src/lib/pipelines/run-manager.test.ts
git commit -m "feat(pipelines): run state manager with dependency resolution"
```

---

## Chunk 4: Stage Dispatcher

### Task 6: Stage dispatcher

**Files:**
- Create: `src/lib/pipelines/dispatcher.ts`

- [ ] **Step 1: Implement dispatcher**

The dispatcher bridges pipeline stages to Cabinet's conversation-runner. It builds prompts from stage inputs + agent persona and starts a conversation.

```typescript
import { startConversationRun } from "@/lib/agents/conversation-runner";
import { readPersona } from "@/lib/agents/persona-manager";
import { resolveInputs, resolveTemplate } from "./template";
import type { StageDefinition, PipelineRun, PipelineDefinition, FanOutAgent } from "./types";
import type { ConversationMeta } from "@/types/conversations";

export interface DispatchResult {
  conversationId: string;
  agentSlug: string;
}

function buildStagePrompt(
  stageDef: StageDefinition,
  resolvedInputs: Record<string, string>,
  run: PipelineRun
): string {
  const lines: string[] = [];
  lines.push(`# Task: ${stageDef.name}`);
  lines.push("");
  lines.push(`Pipeline: ${run.pipeline} | Run: ${run.id} | Stage: ${stageDef.id}`);
  lines.push(`Target repo: ${run.targetRepo}`);
  lines.push("");

  if (Object.keys(resolvedInputs).length > 0) {
    lines.push("## Inputs");
    for (const [key, val] of Object.entries(resolvedInputs)) {
      lines.push(`- **${key}:** ${val}`);
    }
    lines.push("");
  }

  if (stageDef.success_criteria && stageDef.success_criteria.length > 0) {
    lines.push("## Success Criteria");
    for (const criterion of stageDef.success_criteria) {
      lines.push(`- ${criterion}`);
    }
    lines.push("");
  }

  if (stageDef.constraints && stageDef.constraints.length > 0) {
    lines.push("## Constraints");
    for (const constraint of stageDef.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push("");
  }

  lines.push("## Output Format");
  lines.push("When done, emit a structured outputs block at the end of your response:");
  lines.push("```pipeline-outputs");
  if (stageDef.outputs) {
    for (const [key, type] of Object.entries(stageDef.outputs)) {
      lines.push(`${key}: <${type}>`);
    }
  } else {
    lines.push("status: done");
  }
  lines.push("```");

  return lines.join("\n");
}

function buildTemplateContext(run: PipelineRun): Record<string, unknown> {
  const stageOutputs: Record<string, { outputs: unknown }> = {};
  for (const [id, state] of Object.entries(run.stages)) {
    stageOutputs[id] = { outputs: state.outputs || {} };
  }
  return {
    ...run.variables,
    trigger: run.variables.trigger || {},
    stages: stageOutputs,
    run: { id: run.id },
  };
}

export async function dispatchStage(
  stageDef: StageDefinition,
  run: PipelineRun,
  pipeline: PipelineDefinition
): Promise<DispatchResult[]> {
  const context = buildTemplateContext(run);

  // Parallel fan-out: dispatch one conversation per agent
  if (stageDef.type === "parallel_fan_out" && stageDef.agents) {
    const results: DispatchResult[] = [];
    for (const agent of stageDef.agents) {
      const assignee = resolveTemplate(agent.assignee, context);
      const resolvedInputs = resolveInputs(stageDef.inputs, context);
      resolvedInputs.focus = agent.focus;

      const prompt = buildStagePrompt(stageDef, resolvedInputs, run);
      const meta = await startConversationRun({
        agentSlug: assignee,
        title: `[${run.pipeline}] ${stageDef.name} — ${agent.focus}`,
        trigger: "job",
        prompt,
        cwd: run.targetRepo,
      });
      results.push({ conversationId: meta.id, agentSlug: assignee });
    }
    return results;
  }

  // Single agent dispatch
  const assignee = resolveTemplate(stageDef.assignee || "", context);
  const resolvedInputs = resolveInputs(stageDef.inputs, context);
  const prompt = buildStagePrompt(stageDef, resolvedInputs, run);

  const meta = await startConversationRun({
    agentSlug: assignee,
    title: `[${run.pipeline}] ${stageDef.name}`,
    trigger: "job",
    prompt,
    cwd: run.targetRepo,
  });

  return [{ conversationId: meta.id, agentSlug: assignee }];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/pipelines/dispatcher.ts
git commit -m "feat(pipelines): stage dispatcher bridges stages to conversation-runner"
```

---

### Task 7: Failure handler

**Files:**
- Create: `src/lib/pipelines/failure-handler.ts`

- [ ] **Step 1: Implement failure handler**

```typescript
import type { PipelineRun, StageDefinition, PipelineDefinition } from "./types";
import { updateStage, saveRun } from "./run-manager";

export interface FailureDecision {
  action: "retry" | "goto" | "escalate" | "fail";
  targetStage?: string;
  injectFeedback?: boolean;
  feedback?: string;
}

export function decideOnFailure(
  stageDef: StageDefinition,
  run: PipelineRun,
  pipeline: PipelineDefinition,
  error?: string
): FailureDecision {
  const state = run.stages[stageDef.id];
  const maxAttempts = pipeline.defaults.retry.max_attempts;
  const onExhaustion = pipeline.defaults.retry.on_exhaustion;

  if (!stageDef.on_failure) {
    // Default: retry up to max, then escalate
    if (state.retries < maxAttempts - 1) {
      return { action: "retry" };
    }
    return { action: "escalate" };
  }

  const onFail = stageDef.on_failure;

  // goto with loop limit
  if (onFail.goto) {
    const loopCount = state.failureLoop || 0;
    const maxLoops = onFail.max_loops || 2;
    if (loopCount < maxLoops) {
      return {
        action: "goto",
        targetStage: onFail.goto,
        injectFeedback: onFail.inject_feedback,
        feedback: error,
      };
    }
    return { action: "escalate" };
  }

  // retry_with: delegate fix to another agent
  if (onFail.retry_with) {
    const maxRetries = onFail.retry_with.max_retries || maxAttempts;
    if (state.retries < maxRetries) {
      return { action: "retry" };
    }
    return { action: "escalate" };
  }

  return { action: "escalate" };
}

export async function applyFailureDecision(
  decision: FailureDecision,
  stageDef: StageDefinition,
  run: PipelineRun,
  baseDir?: string
): Promise<PipelineRun> {
  switch (decision.action) {
    case "retry": {
      const state = run.stages[stageDef.id];
      state.retries += 1;
      state.status = "ready";
      state.conversationId = undefined;
      state.error = undefined;
      await saveRun(run, baseDir);
      return run;
    }
    case "goto": {
      // Mark current stage as completed (with failure noted)
      run.stages[stageDef.id].status = "completed";
      run.stages[stageDef.id].completedAt = new Date().toISOString();
      // Reset target stage to ready
      if (decision.targetStage && run.stages[decision.targetStage]) {
        const target = run.stages[decision.targetStage];
        target.status = "ready";
        target.retries = 0;
        target.failureLoop = (target.failureLoop || 0) + 1;
        target.conversationId = undefined;
        if (decision.injectFeedback && decision.feedback) {
          // Store feedback in outputs so the next dispatch picks it up
          target.outputs = { ...target.outputs, _feedback: decision.feedback };
        }
      }
      await saveRun(run, baseDir);
      return run;
    }
    case "escalate": {
      run.stages[stageDef.id].status = "failed";
      run.status = "needs-human";
      run.escalationReason = `Stage "${stageDef.id}" exhausted retries`;
      await saveRun(run, baseDir);
      return run;
    }
    case "fail":
    default: {
      run.stages[stageDef.id].status = "failed";
      run.status = "failed";
      await saveRun(run, baseDir);
      return run;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/pipelines/failure-handler.ts
git commit -m "feat(pipelines): failure handler with retry, goto, and escalation"
```

---

## Chunk 5: Orchestrator Core Loop

### Task 8: Orchestrator heartbeat

**Files:**
- Create: `src/lib/pipelines/orchestrator.ts`

- [ ] **Step 1: Implement orchestrator**

```typescript
import path from "path";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { loadAllPipelines, parsePipelineFile } from "./parser";
import { listActiveRuns, getRun, getReadyStages, updateStage, createRun, saveRun } from "./run-manager";
import { dispatchStage } from "./dispatcher";
import { decideOnFailure, applyFailureDecision } from "./failure-handler";
import { evaluateCondition, resolveTemplate } from "./template";
import { readConversationMeta } from "@/lib/agents/conversation-store";
import { getAllTasks } from "@/lib/agents/task-inbox";
import type { PipelineDefinition, PipelineRun, StageDefinition } from "./types";

const PIPELINES_DIR = path.join(DATA_DIR, ".pipelines");
const RUNS_DIR = path.join(DATA_DIR, ".agents/.pipelines/runs");

export async function orchestratorTick(): Promise<{
  dispatched: number;
  completed: number;
  failed: number;
  newRuns: number;
}> {
  const stats = { dispatched: 0, completed: 0, failed: 0, newRuns: 0 };

  // 1. Load pipeline definitions
  let pipelines: PipelineDefinition[];
  try {
    pipelines = await loadAllPipelines(PIPELINES_DIR);
  } catch {
    return stats;
  }

  // 2. Process active runs
  const activeRuns = await listActiveRuns(RUNS_DIR);

  for (const run of activeRuns) {
    const pipeline = pipelines.find((p) => p.name === run.pipeline);
    if (!pipeline) continue;

    // Check in-progress stages for completion
    for (const stage of pipeline.stages) {
      const state = run.stages[stage.id];
      if (!state || state.status !== "in_progress") continue;

      const isComplete = await checkStageCompletion(stage, state, run);
      if (isComplete === "completed") {
        await updateStage(run.id, stage.id, {
          status: "completed",
          completedAt: new Date().toISOString(),
        }, RUNS_DIR);
        stats.completed++;
      } else if (isComplete === "failed") {
        const decision = decideOnFailure(stage, run, pipeline, state.error);
        await applyFailureDecision(decision, stage, run, RUNS_DIR);
        if (decision.action === "escalate" || decision.action === "fail") {
          stats.failed++;
        }
      }
    }

    // Re-read run after updates
    const updatedRun = await getRun(run.id, RUNS_DIR);
    if (!updatedRun || updatedRun.status !== "running") continue;

    // Evaluate and dispatch ready stages
    const readyStages = getReadyStages(updatedRun, pipeline);
    for (const stage of readyStages) {
      // Check condition
      if (stage.condition) {
        const context = buildRunContext(updatedRun);
        if (!evaluateCondition(stage.condition, context)) {
          await updateStage(updatedRun.id, stage.id, { status: "skipped" }, RUNS_DIR);
          continue;
        }
      }

      // Dispatch
      try {
        const results = await dispatchStage(stage, updatedRun, pipeline);
        const conversationIds = results.map((r) => r.conversationId);

        await updateStage(updatedRun.id, stage.id, {
          status: "in_progress",
          startedAt: new Date().toISOString(),
          conversationId: conversationIds[0],
          conversationIds: conversationIds.length > 1 ? conversationIds : undefined,
        }, RUNS_DIR);

        stats.dispatched++;
      } catch (err) {
        await updateStage(updatedRun.id, stage.id, {
          status: "failed",
          error: String(err),
        }, RUNS_DIR);
        stats.failed++;
      }
    }
  }

  // 3. Check for new trigger tasks
  const newRuns = await checkForNewTriggers(pipelines);
  stats.newRuns = newRuns;

  return stats;
}

async function checkStageCompletion(
  stage: StageDefinition,
  state: { conversationId?: string; conversationIds?: string[] },
  run: PipelineRun
): Promise<"completed" | "failed" | "running"> {
  const ids = state.conversationIds || (state.conversationId ? [state.conversationId] : []);
  if (ids.length === 0) return "running";

  let allDone = true;
  let anyFailed = false;

  for (const convId of ids) {
    try {
      const meta = await readConversationMeta(convId);
      if (!meta) { allDone = false; continue; }
      if (meta.status === "completed") continue;
      if (meta.status === "failed" || meta.status === "error") { anyFailed = true; continue; }
      allDone = false;
    } catch {
      allDone = false;
    }
  }

  if (!allDone) return "running";
  if (anyFailed) return "failed";
  return "completed";
}

async function checkForNewTriggers(pipelines: PipelineDefinition[]): Promise<number> {
  let newRuns = 0;

  try {
    const tasks = await getAllTasks("pending");

    for (const task of tasks) {
      for (const pipeline of pipelines) {
        if (matchesTrigger(task, pipeline)) {
          const variables = resolveInitialVariables(pipeline, task);
          const targetRepo = (variables.targetRepo as string) || "/Users/liorfr/Repos/idp";
          await createRun(pipeline, task.id, targetRepo, variables, RUNS_DIR);
          newRuns++;
          break;
        }
      }
    }
  } catch { /* no tasks */ }

  return newRuns;
}

function matchesTrigger(
  task: { title: string; description: string; fromAgent: string; status: string },
  pipeline: PipelineDefinition
): boolean {
  const trigger = pipeline.trigger;
  if (trigger.conditions.assignee && task.fromAgent !== trigger.conditions.assignee) return false;
  if (trigger.conditions.body_contains) {
    const text = `${task.title} ${task.description}`.toLowerCase();
    return trigger.conditions.body_contains.some((kw) => text.includes(kw.toLowerCase()));
  }
  return false;
}

function resolveInitialVariables(
  pipeline: PipelineDefinition,
  task: { id: string; title: string; description: string }
): Record<string, unknown> {
  const context = {
    trigger: { title: task.title, body: task.description, task_id: task.id },
  };
  const resolved: Record<string, unknown> = { trigger: context.trigger };
  for (const [key, template] of Object.entries(pipeline.variables)) {
    resolved[key] = resolveTemplate(template, context);
  }
  return resolved;
}

function buildRunContext(run: PipelineRun): Record<string, unknown> {
  const stageOutputs: Record<string, { outputs: unknown }> = {};
  for (const [id, state] of Object.entries(run.stages)) {
    stageOutputs[id] = { outputs: state.outputs || {} };
  }
  return { ...run.variables, stages: stageOutputs, run: { id: run.id } };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/pipelines/orchestrator.ts
git commit -m "feat(pipelines): orchestrator heartbeat loop"
```

---

## Chunk 6: Metrics & API

### Task 9: Metrics collector

**Files:**
- Create: `src/lib/pipelines/metrics.ts`

- [ ] **Step 1: Implement metrics**

```typescript
import type { PipelineRun } from "./types";

export interface PipelineMetricsSummary {
  runId: string;
  pipeline: string;
  status: string;
  totalDuration?: number;  // ms
  stageDurations: Record<string, number>;
  totalRetries: number;
  stageRetries: Record<string, number>;
}

export function computeMetrics(run: PipelineRun): PipelineMetricsSummary {
  const stageDurations: Record<string, number> = {};
  const stageRetries: Record<string, number> = {};
  let totalRetries = 0;

  for (const [id, state] of Object.entries(run.stages)) {
    if (state.startedAt && state.completedAt) {
      stageDurations[id] = new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
    }
    stageRetries[id] = state.retries;
    totalRetries += state.retries;
  }

  const totalDuration = run.completedAt
    ? new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()
    : undefined;

  return {
    runId: run.id,
    pipeline: run.pipeline,
    status: run.status,
    totalDuration,
    stageDurations,
    totalRetries,
    stageRetries,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/pipelines/metrics.ts
git commit -m "feat(pipelines): metrics computation for pipeline runs"
```

---

### Task 10: Pipeline API routes

**Files:**
- Create: `src/app/api/pipelines/route.ts`
- Create: `src/app/api/pipelines/runs/route.ts`
- Create: `src/app/api/pipelines/runs/[id]/route.ts`
- Create: `src/app/api/pipelines/trigger/route.ts`

- [ ] **Step 1: Create pipelines list route**

```typescript
// src/app/api/pipelines/route.ts
import { NextResponse } from "next/server";
import path from "path";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { loadAllPipelines } from "@/lib/pipelines/parser";

const PIPELINES_DIR = path.join(DATA_DIR, ".pipelines");

export async function GET() {
  try {
    const pipelines = await loadAllPipelines(PIPELINES_DIR);
    return NextResponse.json({ pipelines: pipelines.map((p) => ({ name: p.name, description: p.description, stageCount: p.stages.length })) });
  } catch {
    return NextResponse.json({ pipelines: [] });
  }
}
```

- [ ] **Step 2: Create runs list route**

```typescript
// src/app/api/pipelines/runs/route.ts
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { DATA_DIR } from "@/lib/storage/path-utils";
import type { PipelineRun } from "@/lib/pipelines/types";

const RUNS_DIR = path.join(DATA_DIR, ".agents/.pipelines/runs");

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get("status");

  try {
    const entries = await fs.readdir(RUNS_DIR);
    const runs: PipelineRun[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(RUNS_DIR, entry), "utf-8");
      const run: PipelineRun = JSON.parse(raw);
      if (!statusFilter || run.status === statusFilter) runs.push(run);
    }
    runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return NextResponse.json({ runs });
  } catch {
    return NextResponse.json({ runs: [] });
  }
}
```

- [ ] **Step 3: Create single run route**

```typescript
// src/app/api/pipelines/runs/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { getRun } from "@/lib/pipelines/run-manager";
import { computeMetrics } from "@/lib/pipelines/metrics";

const RUNS_DIR = path.join(DATA_DIR, ".agents/.pipelines/runs");

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id, RUNS_DIR);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const metrics = computeMetrics(run);
  return NextResponse.json({ run, metrics });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id, RUNS_DIR);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  run.status = "cancelled";
  run.completedAt = new Date().toISOString();
  const { saveRun } = await import("@/lib/pipelines/run-manager");
  await saveRun(run, RUNS_DIR);
  return NextResponse.json({ run });
}
```

- [ ] **Step 4: Create trigger route**

```typescript
// src/app/api/pipelines/trigger/route.ts
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { parsePipelineFile } from "@/lib/pipelines/parser";
import { createRun } from "@/lib/pipelines/run-manager";
import { resolveTemplate } from "@/lib/pipelines/template";

const PIPELINES_DIR = path.join(DATA_DIR, ".pipelines");
const RUNS_DIR = path.join(DATA_DIR, ".agents/.pipelines/runs");

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { pipeline: pipelineName, taskId, title, description, targetRepo } = body;

  if (!pipelineName || !title) {
    return NextResponse.json({ error: "pipeline and title required" }, { status: 400 });
  }

  try {
    const def = await parsePipelineFile(path.join(PIPELINES_DIR, `${pipelineName}.yaml`));

    const context = { trigger: { title, body: description || "", task_id: taskId || `manual-${Date.now()}` } };
    const variables: Record<string, unknown> = { trigger: context.trigger };
    for (const [key, template] of Object.entries(def.variables)) {
      variables[key] = resolveTemplate(template, context);
    }

    const repo = targetRepo || "/Users/liorfr/Repos/idp";
    const run = await createRun(def, taskId || `manual-${Date.now()}`, repo, variables, RUNS_DIR);

    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/pipelines/
git commit -m "feat(pipelines): REST API for pipelines, runs, and manual trigger"
```

---

## Chunk 7: Orchestrator Agent Persona & Integration

### Task 11: Create orchestrator persona

**Files:**
- Create: `data/.agents/orchestrator/persona.md`

- [ ] **Step 1: Create persona file**

```markdown
---
name: Pipeline Orchestrator
role: 'Autonomous pipeline routing — scans runs, dispatches stages, handles failures'
provider: claude-code
heartbeat: '*/2 * * * *'
budget: 50
active: true
workdir: /data
focus: []
tags:
  - orchestration
  - pipelines
  - factory
emoji: "\U0001F3ED"
department: engineering
type: lead
canDispatch: true
workspace: /
setupComplete: true
channels:
  - pipeline
  - general
---
# Pipeline Orchestrator

You are the Pipeline Orchestrator for this Cabinet. Your sole job is routing — you NEVER do implementation work.

## On Each Heartbeat

1. Call the pipeline orchestrator tick endpoint: POST /api/pipelines/tick
2. Report what happened: stages dispatched, completed, failed, new runs created
3. If any run is stuck (needs-human), post a message to the pipeline channel

## Principles

- You are a router, not an implementer
- Pipeline state (run JSON files) is source of truth
- Never modify code in target repos — delegate to specialist agents
- Escalate clearly when retry limits are hit
- Keep messages concise: what stage, what happened, what's next
```

- [ ] **Step 2: Commit**

```bash
git add data/.agents/orchestrator/
git commit -m "feat(pipelines): orchestrator agent persona"
```

---

### Task 12: Orchestrator tick API endpoint

**Files:**
- Create: `src/app/api/pipelines/tick/route.ts`

- [ ] **Step 1: Create tick endpoint**

The orchestrator agent (or cron) calls this to advance all pipelines.

```typescript
// src/app/api/pipelines/tick/route.ts
import { NextResponse } from "next/server";
import { orchestratorTick } from "@/lib/pipelines/orchestrator";

export async function POST() {
  try {
    const result = await orchestratorTick();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/pipelines/tick/route.ts
git commit -m "feat(pipelines): tick endpoint for orchestrator heartbeat"
```

---

### Task 13: Extend AgentTask type

**Files:**
- Modify: `src/types/agents.ts`
- Modify: `src/lib/agents/task-inbox.ts`

- [ ] **Step 1: Add pipeline fields to AgentTask in types/agents.ts**

Add after the existing `startedAt?: string;` field:

```typescript
  pipelineRunId?: string;
  phase?: string;
  blockedBy?: string[];
  evidence?: string;
```

- [ ] **Step 2: Add same fields to task-inbox.ts AgentTask interface**

The `task-inbox.ts` has its own local `AgentTask` interface. Add the same fields there.

- [ ] **Step 3: Commit**

```bash
git add src/types/agents.ts src/lib/agents/task-inbox.ts
git commit -m "feat(pipelines): extend AgentTask with pipeline fields"
```

---

## Chunk 8: Agent Personas (Dark Factory Agents)

### Task 14: Create specialist agent personas from paperclip SOULs

**Files:**
- Create: `data/.agents/cto/persona.md`
- Create: `data/.agents/decomposer/persona.md`
- Create: `data/.agents/qalead/persona.md`
- Create: `data/.agents/backendengineer/persona.md`
- Create: `data/.agents/frontendengineer/persona.md`
- Create: `data/.agents/desloppify/persona.md`
- Create: `data/.agents/prmanager/persona.md`
- Create: `data/.agents/gatekeeper/persona.md`
- Create: `data/.agents/codesimplifier/persona.md`
- Create: `data/.agents/validator/persona.md`
- Create: `data/.agents/techlead/persona.md`

For each agent, read the corresponding SOUL.md from `/Users/liorfr/Repos/idp/.paperclip-agents/<agent>/SOUL.md` and translate into Cabinet persona format:

```markdown
---
name: <Agent Name>
role: '<one-line role description from SOUL>'
provider: claude-code
heartbeat: '0'
budget: 100
active: true
workdir: /data
focus: []
tags:
  - pipeline
  - <track>
emoji: "<appropriate emoji>"
department: engineering
type: specialist
workspace: /
setupComplete: true
channels:
  - pipeline
---
# <Agent Name>

<Translated SOUL.md content — core identity, principles, working style>
<Remove heartbeat/routing logic since the orchestrator handles that>
<Keep: domain expertise, constraints, quality standards>
```

- [ ] **Step 1: Read all SOUL.md files and create personas**

Read each SOUL.md from `/Users/liorfr/Repos/idp/.paperclip-agents/` and create the Cabinet persona. Focus on:
- Core identity and purpose
- Domain expertise
- Quality standards and constraints
- Remove routing/heartbeat/phase logic (orchestrator handles that)

- [ ] **Step 2: Commit**

```bash
git add data/.agents/cto/ data/.agents/decomposer/ data/.agents/qalead/ \
  data/.agents/backendengineer/ data/.agents/frontendengineer/ \
  data/.agents/desloppify/ data/.agents/prmanager/ data/.agents/gatekeeper/ \
  data/.agents/codesimplifier/ data/.agents/validator/ data/.agents/techlead/
git commit -m "feat(pipelines): specialist agent personas from dark factory SOULs"
```

---

### Task 15: Create reviewer agent personas

**Files:**
- Create: `data/.agents/codereviewer/persona.md`
- Create: `data/.agents/silentfailurehunter/persona.md`
- Create: `data/.agents/prtestanalyzer/persona.md`
- Create: `data/.agents/commentanalyzer/persona.md`
- Create: `data/.agents/typedesignanalyzer/persona.md`
- Create: `data/.agents/architecturereviewer/persona.md`
- Create: `data/.agents/blindvalidator/persona.md`

Same process as Task 14 — read from paperclip SOULs, translate to Cabinet format. Reviewers are `type: specialist` with no heartbeat (on-demand only via pipeline dispatch).

- [ ] **Step 3: Commit**

```bash
git add data/.agents/codereviewer/ data/.agents/silentfailurehunter/ \
  data/.agents/prtestanalyzer/ data/.agents/commentanalyzer/ \
  data/.agents/typedesignanalyzer/ data/.agents/architecturereviewer/ \
  data/.agents/blindvalidator/
git commit -m "feat(pipelines): reviewer agent personas for parallel code review"
```

---

## Chunk 9: Integration Test & Wiring

### Task 16: Create an index module for pipelines

**Files:**
- Create: `src/lib/pipelines/index.ts`

- [ ] **Step 1: Create barrel export**

```typescript
export { parsePipelineFile, loadAllPipelines, validatePipeline } from "./parser";
export { resolveTemplate, evaluateCondition, resolveInputs } from "./template";
export { createRun, getRun, saveRun, updateStage, listActiveRuns, getReadyStages } from "./run-manager";
export { orchestratorTick } from "./orchestrator";
export { dispatchStage } from "./dispatcher";
export { decideOnFailure, applyFailureDecision } from "./failure-handler";
export { computeMetrics } from "./metrics";
export type * from "./types";
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/pipelines/index.ts
git commit -m "feat(pipelines): barrel export for pipelines module"
```

---

### Task 17: End-to-end smoke test

**Files:**
- Create: `src/lib/pipelines/e2e.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parsePipelineFile } from "./parser";
import { createRun, getReadyStages, updateStage, getRun } from "./run-manager";
import { resolveTemplate } from "./template";

const TEST_DIR = path.join(os.tmpdir(), "pipeline-e2e-" + Date.now());

describe("Pipeline E2E", () => {
  beforeEach(async () => { await fs.mkdir(TEST_DIR, { recursive: true }); });
  afterEach(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }); });

  it("advances a bug pipeline from start to merge", async () => {
    const pipeline = await parsePipelineFile(
      path.join(process.cwd(), "data/.pipelines/bug.yaml")
    );

    // Resolve initial variables
    const triggerContext = {
      trigger: { title: "Bug: Login fails on Safari", body: "Users get a crash on Safari 17", task_id: "t-999" },
    };
    const variables: Record<string, unknown> = { trigger: triggerContext.trigger };
    for (const [key, template] of Object.entries(pipeline.variables)) {
      variables[key] = resolveTemplate(template, triggerContext);
    }

    // Create run
    const run = await createRun(pipeline, "t-999", "/tmp/repo", variables, TEST_DIR);
    expect(run.status).toBe("running");

    // First ready stage should be "decompose" (no deps)
    let ready = getReadyStages(run, pipeline);
    expect(ready[0].id).toBe("decompose");

    // Simulate decompose completion
    let updated = await updateStage(run.id, "decompose", {
      status: "completed",
      outputs: { components: ["frontend"], root_cause: "Safari flex gap bug" },
    }, TEST_DIR);

    // Next ready: implement_fix
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("implement_fix");

    // Simulate through to merge
    updated = await updateStage(run.id, "implement_fix", { status: "completed" }, TEST_DIR);
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("deslop");

    updated = await updateStage(run.id, "deslop", { status: "completed" }, TEST_DIR);
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("create_pr");

    updated = await updateStage(run.id, "create_pr", {
      status: "completed",
      outputs: { pr_number: 42 },
    }, TEST_DIR);
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("reviews");

    updated = await updateStage(run.id, "reviews", { status: "completed" }, TEST_DIR);
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("code_simplifier");

    updated = await updateStage(run.id, "code_simplifier", { status: "completed" }, TEST_DIR);
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("merge");

    updated = await updateStage(run.id, "merge", { status: "completed" }, TEST_DIR);
    ready = getReadyStages(updated!, pipeline);
    expect(ready[0].id).toBe("retro");

    updated = await updateStage(run.id, "retro", { status: "completed" }, TEST_DIR);

    // Run should be complete
    const final = await getRun(run.id, TEST_DIR);
    expect(final?.status).toBe("completed");
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/lib/pipelines/e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/pipelines/e2e.test.ts
git commit -m "test(pipelines): end-to-end smoke test for bug pipeline"
```

---

### Task 18: Verify build

- [ ] **Step 1: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run all pipeline tests**

Run: `npx vitest run src/lib/pipelines/`
Expected: All PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No new errors

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(pipelines): address build/lint issues"
```

---

## Summary

**Total tasks:** 18  
**Estimated time:** 2-3 hours of agent implementation work  
**Key integration points:**
- `startConversationRun()` in `src/lib/agents/conversation-runner.ts` — how stages dispatch work
- `readConversationMeta()` in `src/lib/agents/conversation-store.ts` — how orchestrator checks completion
- `AgentTask` in `src/types/agents.ts` + `src/lib/agents/task-inbox.ts` — extended with pipeline fields
- Orchestrator persona heartbeat triggers `/api/pipelines/tick` — the core loop

**After this plan completes:**
- Pipeline engine is functional and testable via API
- All agent personas are created and ready
- Triggering a pipeline run via `POST /api/pipelines/trigger` starts the autonomous flow
- UI for visualizing pipeline runs is future work (Chunk 10+)
