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
