"use client";

import { useState, useEffect, useCallback } from "react";
import { FolderOpen, RefreshCw, Loader2, AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { FileTree } from "./FileTree";
import { FileTabs } from "./FileTabs";
import { FileEditor } from "./FileEditor";
import { useFileEditor } from "@/hooks/useFileEditor";
import { useConfirm } from "@/components/ConfirmProvider";
import { useDrawerAnimation } from "@/hooks/useDrawerAnimation";
import { baseName } from "@/lib/path-display";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/file-utils";

interface FileExplorerDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workingDirectory: string;
}

/**
 * The file explorer as a right-docked drawer (shares the Git drawer's slot —
 * only one shows at a time). Tree-only browsing with right-click "Copy path"
 * (via FileTree); clicking a file opens it in a modal editor, mirroring how the
 * Git drawer opens a changed file. Lets you grab paths to paste into an agent
 * without leaving the terminal. Desktop only.
 */
export function FileExplorerDrawer({
  open,
  onOpenChange,
  workingDirectory,
}: FileExplorerDrawerProps) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isAnimatingIn = useDrawerAnimation(open);
  const confirm = useConfirm();

  const fileEditor = useFileEditor();
  const {
    openFiles,
    activeFilePath,
    loading: fileLoading,
    openFile,
    closeFile,
    setActiveFile,
    updateContent,
    saveFile,
    isDirty,
    hasUnsavedChanges,
    getFile,
    reset,
  } = fileEditor;

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/files?path=${encodeURIComponent(workingDirectory)}`
      );
      const data = await res.json();
      if (data.error) setError(data.error);
      else setFiles(data.files || []);
    } catch {
      setError("Failed to load directory");
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    if (open) loadFiles();
  }, [open, loadFiles]);

  const activeFile = activeFilePath ? getFile(activeFilePath) : undefined;

  const handleCloseFile = useCallback(
    async (path: string) => {
      if (
        isDirty(path) &&
        !(await confirm({
          title: "Discard unsaved changes?",
          description: `Your edits to ${baseName(path)} will be lost.`,
          confirmLabel: "Discard",
        }))
      )
        return;
      closeFile(path);
    },
    [isDirty, confirm, closeFile]
  );

  // Close the whole modal (Esc / overlay), confirming if anything is dirty.
  const handleModalOpenChange = useCallback(
    async (next: boolean) => {
      if (next) return;
      if (
        hasUnsavedChanges &&
        !(await confirm({
          title: "Discard unsaved changes?",
          description: "Your edits will be lost.",
          confirmLabel: "Discard",
        }))
      )
        return;
      reset();
    },
    [hasUnsavedChanges, confirm, reset]
  );

  const handleSave = useCallback(
    async (path: string) => {
      await saveFile(path);
    },
    [saveFile]
  );

  if (!open) return null;

  return (
    <>
      <div
        className={cn(
          "bg-muted/30 flex h-full flex-col transition-all duration-200 ease-out",
          isAnimatingIn
            ? "translate-x-0 opacity-100"
            : "translate-x-4 opacity-0"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="text-muted-foreground h-4 w-4" />
            <span className="text-sm font-medium">Files</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={loadFiles}
              disabled={loading}
              className="h-7 w-7"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", loading && "animate-spin")}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
              className="h-7 w-7"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <AlertCircle className="h-8 w-8 text-red-500" />
              <p className="text-muted-foreground text-sm">{error}</p>
              <Button variant="outline" size="sm" onClick={loadFiles}>
                Retry
              </Button>
            </div>
          ) : files.length === 0 ? (
            <div className="text-muted-foreground flex items-center justify-center py-8 text-sm">
              Empty directory
            </div>
          ) : (
            <FileTree
              nodes={files}
              basePath={workingDirectory}
              onFileClick={openFile}
            />
          )}
        </div>
      </div>

      {/* File viewer modal (mirrors the Git drawer opening a file) */}
      <Dialog open={!!activeFilePath} onOpenChange={handleModalOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[95vh] w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <DialogTitle className="sr-only">
            {activeFilePath ? baseName(activeFilePath) : "File viewer"}
          </DialogTitle>
          <FileTabs
            files={openFiles}
            activeFilePath={activeFilePath}
            onSelect={setActiveFile}
            onClose={handleCloseFile}
            isDirty={isDirty}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {fileLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
              </div>
            ) : activeFile ? (
              <FileEditor
                content={activeFile.currentContent}
                language={activeFile.language}
                isBinary={activeFile.isBinary}
                onChange={(content) => updateContent(activeFile.path, content)}
                onSave={() => handleSave(activeFile.path)}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
