import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { GitBranch, Loader2, FolderOpen, AlertTriangle } from "lucide-react";
import type { GitInfo } from "./NewSessionDialog.types";

interface WorkingDirectoryInputProps {
  value: string;
  onChange: (value: string) => void;
  gitInfo: GitInfo | null;
  checkingGit: boolean;
  onBrowse: () => void;
}

export function WorkingDirectoryInput({
  value,
  onChange,
  gitInfo,
  checkingGit,
  onBrowse,
}: WorkingDirectoryInputProps) {
  // Secrets guard (#36): debounced shallow name-scan of the picked directory.
  // Advisory only — any error / 403 simply clears the warning, never blocks.
  const [secretFindings, setSecretFindings] = useState<string[]>([]);

  useEffect(() => {
    if (!value || value === "~") {
      setSecretFindings([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/secret-scan?path=${encodeURIComponent(value)}`,
          { signal: controller.signal }
        );
        const data = res.ok ? await res.json() : null;
        if (controller.signal.aborted) return;
        setSecretFindings(Array.isArray(data?.findings) ? data.findings : []);
      } catch {
        if (!controller.signal.aborted) setSecretFindings([]);
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Working Directory</label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="~/projects/my-app"
          />
          {checkingGit && (
            <div className="absolute top-1/2 right-3 -translate-y-1/2">
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onBrowse}
          title="Browse directories"
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>
      {gitInfo?.isGitRepo && (
        <p className="text-muted-foreground flex items-center gap-1 text-xs">
          <GitBranch className="h-3 w-3" />
          Git repo on {gitInfo.currentBranch}
        </p>
      )}
      {secretFindings.length > 0 && (
        <p className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>
            Contains {secretFindings.join(", ")} — agents launched here can read
            these files.
          </span>
        </p>
      )}
    </div>
  );
}
