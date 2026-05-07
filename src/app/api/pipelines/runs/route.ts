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
    runs.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return NextResponse.json({ runs });
  } catch {
    return NextResponse.json({ runs: [] });
  }
}
