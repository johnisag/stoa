import type { FleetPlanReviewLens, FleetReviewEvidenceRow } from "./types";

export const FLEET_PLAN_REVIEW_LENSES: readonly FleetPlanReviewLens[] = [
  "correctness_security",
  "conventions_cross_platform",
  "simplicity_ux",
  "adversarial_red_team",
];

export interface FleetPlanReviewBinding {
  planHash: string;
  policyHash: string;
  executionHash: string;
  baseSha: string;
}

/** Exact four-lane evidence shared by manual and automatic approval paths. */
export function hasFourIndependentCleanPlanReviews(
  reviews: readonly FleetReviewEvidenceRow[],
  binding: FleetPlanReviewBinding
): boolean {
  const cleanByLens = new Map<FleetPlanReviewLens, string>();
  for (const review of reviews) {
    if (
      review.subject_hash !== binding.planHash ||
      review.policy_hash !== binding.policyHash ||
      review.execution_hash !== binding.executionHash ||
      review.base_sha !== binding.baseSha ||
      review.verdict !== "clean" ||
      (review.state != null && review.state !== "clean") ||
      !review.reviewer_session_id.trim()
    ) {
      continue;
    }
    cleanByLens.set(review.lens, review.reviewer_session_id);
  }
  return (
    FLEET_PLAN_REVIEW_LENSES.every((lens) => cleanByLens.has(lens)) &&
    new Set(cleanByLens.values()).size === FLEET_PLAN_REVIEW_LENSES.length
  );
}
