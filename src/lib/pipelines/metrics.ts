import type { PipelineRun } from "./types";

export interface PipelineMetricsSummary {
  runId: string;
  pipeline: string;
  status: string;
  totalDuration?: number; // ms
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
      stageDurations[id] =
        new Date(state.completedAt).getTime() -
        new Date(state.startedAt).getTime();
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
