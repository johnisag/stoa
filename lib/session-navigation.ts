import type { Session } from "@/lib/db";

/**
 * The single source of truth for "next/previous session" order, shared by the
 * three switch paths (Alt+arrows, mobile chevrons, pane swipe) so they all agree
 * with what the sidebar shows.
 *
 * Returns the ids of the **switchable** sessions — i.e. excluding conductor
 * workers (`conductor_session_id` set), which are nested rows in the sidebar and
 * never standalone switch targets — in the order they're laid out:
 *
 *  - Projects view (any projects exist): project order, then each project's
 *    sessions in list order (matching `ProjectsSection`). `project_id` of null
 *    buckets under the "uncategorized" project.
 *  - Group view (no projects): grouped by `group_path` in first-appearance
 *    order. (The full group hierarchy lives only in the sidebar; this is a
 *    faithful-enough flattening for a list with no projects.)
 *
 * Any switchable session not captured by the grouping (e.g. an orphan
 * `project_id` that matches no project) is appended at the end, so every
 * switchable session stays reachable. Pure + dependency-light for unit testing.
 */
export function getSwitchableSessionOrder(
  sessions: Session[],
  projects: readonly { id: string }[]
): string[] {
  const navigable = sessions.filter((s) => !s.conductor_session_id);

  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  if (projects.length > 0) {
    // Projects view: iterate projects in order, then their sessions in list order.
    for (const project of projects) {
      for (const s of navigable) {
        if ((s.project_id || "uncategorized") === project.id) push(s.id);
      }
    }
  } else {
    // Group view: bucket by group_path, groups in first-appearance order.
    const groupOrder: string[] = [];
    const seenGroup = new Set<string>();
    for (const s of navigable) {
      const g = s.group_path || "sessions";
      if (!seenGroup.has(g)) {
        seenGroup.add(g);
        groupOrder.push(g);
      }
    }
    for (const g of groupOrder) {
      for (const s of navigable) {
        if ((s.group_path || "sessions") === g) push(s.id);
      }
    }
  }

  // Safety net: any switchable session the grouping missed stays reachable.
  for (const s of navigable) push(s.id);

  return ids;
}
