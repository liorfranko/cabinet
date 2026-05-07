import type { PipelineRun, StageDefinition, PipelineDefinition } from "./types";
import { saveRun } from "./run-manager";

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
  error?: string,
): FailureDecision {
  const state = run.stages[stageDef.id];
  const maxAttempts = pipeline.defaults.retry.max_attempts;

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
  baseDir?: string,
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
