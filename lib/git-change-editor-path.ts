import { joinPath } from "@/lib/path-display";
import type { GitFile } from "@/lib/git-status";

export interface GitChangeEditorFile {
  path: string;
  status: GitFile["status"];
  repoPath?: string;
}

export function gitChangeEditorPath(
  file: GitChangeEditorFile,
  workingDirectory: string
): string | null {
  if (file.status === "deleted") return null;

  const basePath = file.repoPath || workingDirectory;
  return joinPath(basePath, file.path);
}
