import path from "path";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { loadAllPipelines } from "./parser";
import {
  listActiveRuns,
  getRun,
  getReadyStages,
  updateStage,
  createRun,
} from "./run-manager";
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
        await updateStage(
          run.id,
          stage.id,
          {
            status: "completed",
            completedAt: new Date().toISOString(),
          },
          RUNS_DIR,
        );
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
          await updateStage(
            updatedRun.id,
            stage.id,
            { status: "skipped" },
            RUNS_DIR,
          );
          continue;
        }
      }

      // Dispatch
      try {
        const results = await dispatchStage(stage, updatedRun, pipeline);
        const conversationIds = results.map((r) => r.conversationId);

        await updateStage(
          updatedRun.id,
          stage.id,
          {
            status: "in_progress",
            startedAt: new Date().toISOString(),
            conversationId: conversationIds[0],
            conversationIds:
              conversationIds.length > 1 ? conversationIds : undefined,
          },
          RUNS_DIR,
        );

        stats.dispatched++;
      } catch (err) {
        await updateStage(
          updatedRun.id,
          stage.id,
          {
            status: "failed",
            error: String(err),
          },
          RUNS_DIR,
        );
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
  state: {
    conversationId?: string;
    conversationIds?: string[];
    error?: string;
  },
  _run: PipelineRun,
): Promise<"completed" | "failed" | "running"> {
  const ids =
    state.conversationIds ||
    (state.conversationId ? [state.conversationId] : []);
  if (ids.length === 0) return "running";

  let allDone = true;
  let anyFailed = false;

  for (const convId of ids) {
    try {
      const meta = await readConversationMeta(convId);
      if (!meta) {
        allDone = false;
        continue;
      }
      if (meta.status === "completed") continue;
      if (meta.status === "failed" || meta.status === "cancelled") {
        anyFailed = true;
        continue;
      }
      allDone = false;
    } catch {
      allDone = false;
    }
  }

  if (!allDone) return "running";
  if (anyFailed) return "failed";
  return "completed";
}

async function checkForNewTriggers(
  pipelines: PipelineDefinition[],
): Promise<number> {
  let newRuns = 0;

  try {
    const tasks = await getAllTasks("pending");

    for (const task of tasks) {
      for (const pipeline of pipelines) {
        if (matchesTrigger(task, pipeline)) {
          const variables = resolveInitialVariables(pipeline, task);
          const targetRepo =
            (variables.targetRepo as string) || "/Users/liorfr/Repos/idp";
          await createRun(pipeline, task.id, targetRepo, variables, RUNS_DIR);
          newRuns++;
          break;
        }
      }
    }
  } catch {
    /* no tasks */
  }

  return newRuns;
}

function matchesTrigger(
  task: {
    title: string;
    description: string;
    fromAgent: string;
    status: string;
  },
  pipeline: PipelineDefinition,
): boolean {
  const trigger = pipeline.trigger;
  if (
    trigger.conditions.assignee &&
    task.fromAgent !== trigger.conditions.assignee
  )
    return false;
  if (trigger.conditions.body_contains) {
    const text = `${task.title} ${task.description}`.toLowerCase();
    return trigger.conditions.body_contains.some((kw) =>
      text.includes(kw.toLowerCase()),
    );
  }
  return false;
}

function resolveInitialVariables(
  pipeline: PipelineDefinition,
  task: { id: string; title: string; description: string },
): Record<string, unknown> {
  const context = {
    trigger: {
      title: task.title,
      body: task.description,
      task_id: task.id,
    },
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
