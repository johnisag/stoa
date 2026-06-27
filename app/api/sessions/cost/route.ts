import { NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { computeSessionCosts } from "@/lib/session-cost";
import { persistCostSamples } from "@/lib/cost-history";
import { getBudgetConfig, evaluateBudget } from "@/lib/budget";

export type { SessionCost } from "@/lib/session-cost";

// GET /api/sessions/cost — estimated token cost per session + a fleet total,
// plus the active budget caps and each session's level vs them. Claude-only
// today (other agents report supported:false). Best-effort: a session with no
// readable transcript contributes zero. Not on the hot poll path.
export async function GET() {
  try {
    const db = getDb();
    const sessions = queries.getAllSessions(db).all() as Session[];
    const costs = await computeSessionCosts(sessions);

    // Persist today's samples so analytics has HISTORY (#15) — a side effect of a
    // computation we already did, idempotent per (session, UTC day), and isolated
    // so a write failure never fails the cost read.
    try {
      persistCostSamples(db, sessions, costs);
    } catch (err) {
      console.warn("cost route: persisting samples failed (non-fatal):", err);
    }

    const budget = getBudgetConfig();
    const totalUsd = Object.values(costs).reduce(
      (sum, c) => sum + (c.costUsd ?? 0),
      0
    );
    const levels: Record<string, "ok" | "soft" | "hard"> = {};
    for (const [id, c] of Object.entries(costs))
      levels[id] = evaluateBudget(c.costUsd, budget);

    return NextResponse.json({ sessions: costs, totalUsd, budget, levels });
  } catch (error) {
    console.error("cost route failed:", error);
    return NextResponse.json(
      { error: "Failed to compute cost" },
      { status: 500 }
    );
  }
}
