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
  const {
    pipeline: pipelineName,
    taskId,
    title,
    description,
    targetRepo,
  } = body;

  if (!pipelineName || !title) {
    return NextResponse.json(
      { error: "pipeline and title required" },
      { status: 400 },
    );
  }

  try {
    const def = await parsePipelineFile(
      path.join(PIPELINES_DIR, `${pipelineName}.yaml`),
    );

    const context = {
      trigger: {
        title,
        body: description || "",
        task_id: taskId || `manual-${Date.now()}`,
      },
    };
    const variables: Record<string, unknown> = { trigger: context.trigger };
    for (const [key, template] of Object.entries(def.variables)) {
      variables[key] = resolveTemplate(template, context);
    }

    const repo = targetRepo || "/Users/liorfr/Repos/idp";
    const run = await createRun(
      def,
      taskId || `manual-${Date.now()}`,
      repo,
      variables,
      RUNS_DIR,
    );

    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
