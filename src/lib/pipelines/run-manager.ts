import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import type {
  PipelineDefinition,
  PipelineRun,
  StageRunState,
  StageDefinition,
} from "./types";

function runsDir(baseDir?: string): string {
  if (baseDir) return baseDir;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DATA_DIR } = require("@/lib/storage/path-utils") as {
    DATA_DIR: string;
  };
  return path.join(DATA_DIR, ".agents/.pipelines/runs");
}

export async function createRun(
  pipeline: PipelineDefinition,
  triggerTaskId: string,
  targetRepo: string,
  resolvedVariables: Record<string, unknown>,
  baseDir?: string,
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

  await fs.writeFile(
    path.join(dir, `${run.id}.json`),
    JSON.stringify(run, null, 2),
  );
  return run;
}

export async function getRun(
  runId: string,
  baseDir?: string,
): Promise<PipelineRun | null> {
  const filePath = path.join(runsDir(baseDir), `${runId}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveRun(
  run: PipelineRun,
  baseDir?: string,
): Promise<void> {
  const dir = runsDir(baseDir);
  await fs.mkdir(dir, { recursive: true });
  run.updatedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(dir, `${run.id}.json`),
    JSON.stringify(run, null, 2),
  );
}

export async function updateStage(
  runId: string,
  stageId: string,
  updates: Partial<StageRunState>,
  baseDir?: string,
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
          return (
            depState &&
            (depState.status === "completed" || depState.status === "skipped")
          );
        });
        if (allDepsResolved) {
          run.stages[id].status = "ready";
        }
      }
    }
  }

  // Check if run is done
  const allStages = Object.values(run.stages);
  const allDone = allStages.every(
    (s) =>
      s.status === "completed" ||
      s.status === "skipped" ||
      s.status === "failed",
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
      } catch {
        /* skip */
      }
    }
    return runs;
  } catch {
    return [];
  }
}

export function getReadyStages(
  run: PipelineRun,
  pipeline: PipelineDefinition,
): StageDefinition[] {
  return pipeline.stages.filter((stage) => {
    const state = run.stages[stage.id];
    return state && state.status === "ready";
  });
}
