import { startConversationRun } from "@/lib/agents/conversation-runner";
import { resolveInputs, resolveTemplate } from "./template";
import type { StageDefinition, PipelineRun, PipelineDefinition } from "./types";

export interface DispatchResult {
  conversationId: string;
  agentSlug: string;
}

function buildStagePrompt(
  stageDef: StageDefinition,
  resolvedInputs: Record<string, string>,
  run: PipelineRun,
): string {
  const lines: string[] = [];
  lines.push(`# Task: ${stageDef.name}`);
  lines.push("");
  lines.push(
    `Pipeline: ${run.pipeline} | Run: ${run.id} | Stage: ${stageDef.id}`,
  );
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
  lines.push(
    "When done, emit a structured outputs block at the end of your response:",
  );
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
  _pipeline: PipelineDefinition,
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
