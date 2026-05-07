import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { getRun } from "@/lib/pipelines/run-manager";
import { computeMetrics } from "@/lib/pipelines/metrics";

const RUNS_DIR = path.join(DATA_DIR, ".agents/.pipelines/runs");

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = await getRun(id, RUNS_DIR);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const metrics = computeMetrics(run);
  return NextResponse.json({ run, metrics });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
