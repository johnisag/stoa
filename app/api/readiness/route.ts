import { NextResponse } from "next/server";
import { collectReadiness } from "@/lib/readiness-server";

// GET /api/readiness — first-run onboarding probes (#30): which agent CLIs
// resolve on PATH, GitHub CLI presence, and best-effort sign-in evidence.
// Fetched once by the OnboardingChecklist when the app is in its empty state
// (no sessions yet) — not a polling path. Project/session existence is NOT
// probed here on purpose: the shell already has both lists as props.
export async function GET() {
  return NextResponse.json(collectReadiness());
}
