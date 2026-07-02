import { NextRequest, NextResponse } from "next/server";
import { collectReadiness } from "@/lib/readiness-server";
import { requireLocalhost } from "@/lib/api-security";

// GET /api/readiness — first-run onboarding probes (#30): which agent CLIs
// resolve on PATH, GitHub CLI presence, and best-effort sign-in evidence.
// Fetched once by the OnboardingChecklist when the app is in its empty state
// (no sessions yet) — not a polling path. Project/session existence is NOT
// probed here on purpose: the shell already has both lists as props.
// LOCALHOST-GATED: installed-CLI + signed-in status is recon data on a
// tunneled/shared instance (a local tunnel makes remote users look like
// trusted loopback — the same trap `stoa share` closes), and the checklist
// only renders for the local first-run operator anyway.
export async function GET(request: NextRequest) {
  const auth = requireLocalhost(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json(collectReadiness());
}
