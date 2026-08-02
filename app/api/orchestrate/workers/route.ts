import { NextResponse } from "next/server";
import {
  getWorkers,
  getWorkersSummary,
  WorkerSessionAccessError,
} from "@/lib/orchestration";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const conductorId = searchParams.get("conductorId");
    const summaryOnly = searchParams.get("summary") === "true";

    if (!conductorId) {
      return NextResponse.json(
        { error: "Missing conductorId parameter" },
        { status: 400 }
      );
    }

    if (summaryOnly) {
      const summary = await getWorkersSummary(conductorId);
      return NextResponse.json({ summary });
    }

    const workers = await getWorkers(conductorId);
    return NextResponse.json({ workers });
  } catch (error) {
    if (error instanceof WorkerSessionAccessError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error("Failed to get workers:", error);
    return NextResponse.json(
      { error: "Failed to get workers" },
      { status: 500 }
    );
  }
}
