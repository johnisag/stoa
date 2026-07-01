import type Database from "better-sqlite3";
import { queries } from "./db";
import {
  buildKnowledgeBlock,
  rowToPlaybook,
  type PlaybookRow,
} from "./playbooks";

/**
 * Resolve a project's auto-recalled KNOWLEDGE block (its pinned playbooks) + a
 * SELECTED recipe's body (#13), for feeding composeLaunchPrompt. Server-only (touches
 * the DB). Best-effort: a bad/foreign playbook id or a DB hiccup just skips that part
 * — it never blocks a launch. A project-scoped recipe must belong to `projectId` (or
 * be global) to be used, so a prompt-injected id can't pull another project's recipe.
 */
export function resolvePlaybookParts(
  db: Database.Database,
  projectId: string | null | undefined,
  playbookId?: string | null
): { pinnedKnowledge: string; playbook?: string } {
  let pinnedKnowledge = "";
  let playbook: string | undefined;
  try {
    if (projectId) {
      const pinned = queries
        .listPinnedPlaybooks(db)
        .all(projectId) as PlaybookRow[];
      pinnedKnowledge = buildKnowledgeBlock(pinned.map(rowToPlaybook));
    }
    if (playbookId) {
      const pb = queries.getPlaybook(db).get(playbookId) as
        PlaybookRow | undefined;
      if (pb && (pb.project_id === null || pb.project_id === projectId)) {
        playbook = pb.body;
      }
    }
  } catch (err) {
    console.error("playbook resolution failed (skipping):", err);
  }
  return { pinnedKnowledge, playbook };
}
