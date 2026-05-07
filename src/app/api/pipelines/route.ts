import { NextResponse } from "next/server";
import path from "path";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { loadAllPipelines } from "@/lib/pipelines/parser";

const PIPELINES_DIR = path.join(DATA_DIR, ".pipelines");

export async function GET() {
  try {
    const pipelines = await loadAllPipelines(PIPELINES_DIR);
    return NextResponse.json({
      pipelines: pipelines.map((p) => ({
        name: p.name,
        description: p.description,
        stageCount: p.stages.length,
      })),
    });
  } catch {
    return NextResponse.json({ pipelines: [] });
  }
}
