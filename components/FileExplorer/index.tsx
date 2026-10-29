"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { FileTree } from "./FileTree";
import { FileEditor } from "./FileEditor";
import { FileTabs } from "./FileTabs";
import type { UseFileEditorReturn } from "@/hooks/useFileEditor";
import { useViewport } from "@/hooks/useViewport";
import {
  Loader2,
  AlertCircle,
  ArrowLeft,
  Folder,
  Save,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { baseName } from "@/lib/path-display";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/file-utils";
import type { OpenFile, JumpToLine } from "@/hooks/useFileEditor";

interface FileExplorerProps {
  workingDirectory: string;
  fileEditor: UseFileEditorReturn;
  /** Inject a file/folder path into the active agent's prompt (tree right-click
   *  → "Add to agent"). Omitted disables the menu item. */
  onAddToAgent?: (path: string) => void;
  /** Whether the Files view is on screen. The pane keeps this component
   *  mounted (CSS-hidden) across view switches, so the auto-refresh poll only
   *  runs while true. Default true. */
  active?: boolean;
}

export function FileExplorer({
  workingDirectory,
  fileEditor,
  onAddToAgent,
  active = true,
}: FileExplorerProps) {
  const { isMobile, isHydrated } = useViewport();
  const [files, setFiles] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const {
    openFiles,
    activeFilePath,
    loading: fileLoading,
    saving,
    jump,
    openFile,
    closeFile,
    setActiveFile,
    updateContent,
    saveFile,
    isDirty,
    getFile,
  } = fileEditor;

  // Load directory contents. `silent` skips the spinner (background poll) so
  // the tree doesn't flash every tick. `requestSeq` serializes commits: only
  // the LATEST request may write state, so a slow silent fetch for a previous
  // workingDirectory can't clobber the fresh listing after a dir switch.
  // Resolves true when a fresh listing was committed (poll gates refreshKey
  // bumps on this — a failed tick must not trigger tree refetches).
  const requestSeq = useRef(0);
  const loadFiles = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      const seq = ++requestSeq.current;
      if (!opts?.silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await fetch(
          `/api/files?path=${encodeURIComponent(workingDirectory)}`
        );
        const data = await res.json();
        if (seq !== requestSeq.current) return false;
        if (!res.ok || data.error) {
          if (!opts?.silent) setError(data.error || "Failed to load directory");
          return false;
        }
        setFiles(data.files || []);
        setError(null);
        return true;
      } catch {
        if (seq === requestSeq.current && !opts?.silent)
          setError("Failed to load directory");
        return false;
      } finally {
        // The LATEST request always clears the spinner, silent or not —
        // otherwise a non-silent load superseded by a silent poll leaves
        // `loading` stuck true (tree replaced by spinner, refresh button
        // disabled, no self-recovery).
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [workingDirectory]
  );

  // Clear the previous directory's listing on a workingDirectory switch.
  // Without this a FAILED load leaves the old dir's tree rendered under the
  // new path indefinitely (the spinner/error gates only apply when no
  // listing exists). Refreshes for the SAME directory never touch this.
  // Declared BEFORE the load effect: effects run in declaration order, and
  // the seq bump below must precede the load's own — after it, it would
  // supersede the fresh load, whose `finally` then never clears the spinner.
  const prevDirRef = useRef(workingDirectory);
  useEffect(() => {
    if (prevDirRef.current === workingDirectory) return;
    prevDirRef.current = workingDirectory;
    // Invalidate any in-flight fetch for the OLD directory: the load effect is
    // gated on `active`, so a root switch while hidden bumps no requestSeq of
    // its own — without this, that fetch still holds the latest seq and would
    // commit the old dir's listing AFTER the clear below.
    requestSeq.current++;
    setFiles([]);
  }, [workingDirectory]);

  useEffect(() => {
    // Load on mount and whenever the root changes (the live cwd can move it).
    // Gated on `active` like the auto-refresh below: a hidden Files view must
    // not refetch on every root oscillation — the prevDirRef switch already
    // cleared the stale listing, and this effect re-runs when the view
    // becomes active again.
    if (!active) return;
    void loadFiles();
  }, [loadFiles, active]);

  // Auto-refresh every 5s (ConductorPanel precedent) so files the agent
  // creates/edits show up without a manual reload. Silent + paused while the
  // Files view is CSS-hidden or the tab is in the background. refreshKey bumps
  // only after a SUCCESSFUL root fetch, so a failed tick never triggers a
  // tree-wide refetch storm.
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void (async () => {
        const ok = await loadFiles({ silent: true });
        if (ok) setRefreshKey((k) => k + 1);
      })();
    }, 5000);
    return () => clearInterval(interval);
  }, [active, loadFiles]);

  const handleRefresh = useCallback(() => {
    void loadFiles();
    setRefreshKey((k) => k + 1);
  }, [loadFiles]);

  const handleFileClick = useCallback(
    (path: string) => {
      openFile(path);
    },
    [openFile]
  );

  const handleCloseFile = useCallback(
    (path: string) => {
      if (isDirty(path)) {
        setPendingClose(path);
      } else {
        closeFile(path);
      }
    },
    [isDirty, closeFile]
  );

  const handleConfirmClose = useCallback(async () => {
    if (!pendingClose) return;
    closeFile(pendingClose);
    setPendingClose(null);
  }, [pendingClose, closeFile]);

  const handleSaveAndClose = useCallback(async () => {
    if (!pendingClose) return;
    await saveFile(pendingClose);
    closeFile(pendingClose);
    setPendingClose(null);
  }, [pendingClose, saveFile, closeFile]);

  const handleSave = useCallback(async () => {
    if (activeFilePath) {
      await saveFile(activeFilePath);
    }
  }, [activeFilePath, saveFile]);

  const activeFile = activeFilePath ? getFile(activeFilePath) : undefined;

  // Loading state before hydration
  if (!isHydrated) {
    return (
      <div className="bg-background flex h-full w-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  // Mobile layout: full-screen tree OR full-screen editor
  if (isMobile) {
    return (
      <MobileFileExplorer
        files={files}
        loading={loading}
        error={error}
        fileLoading={fileLoading}
        workingDirectory={workingDirectory}
        openFiles={openFiles}
        activeFilePath={activeFilePath}
        activeFile={activeFile}
        saving={saving}
        refreshKey={refreshKey}
        onRefresh={handleRefresh}
        onFileClick={handleFileClick}
        onAddToAgent={onAddToAgent}
        onSelectTab={setActiveFile}
        onCloseTab={handleCloseFile}
        onSave={handleSave}
        onBack={() => setActiveFile(null as unknown as string)}
        jump={jump}
        isDirty={isDirty}
        updateContent={updateContent}
        pendingClose={pendingClose}
        onCancelClose={() => setPendingClose(null)}
        onConfirmClose={handleConfirmClose}
        onSaveAndClose={handleSaveAndClose}
      />
    );
  }

  // Desktop layout: side-by-side tree + editor
  return (
    <DesktopFileExplorer
      files={files}
      loading={loading}
      error={error}
      fileLoading={fileLoading}
      workingDirectory={workingDirectory}
      openFiles={openFiles}
      activeFilePath={activeFilePath}
      activeFile={activeFile}
      saving={saving}
      refreshKey={refreshKey}
      onRefresh={handleRefresh}
      onFileClick={handleFileClick}
      onAddToAgent={onAddToAgent}
      onSelectTab={setActiveFile}
      onCloseTab={handleCloseFile}
      onSave={handleSave}
      jump={jump}
      isDirty={isDirty}
      updateContent={updateContent}
      pendingClose={pendingClose}
      onCancelClose={() => setPendingClose(null)}
      onConfirmClose={handleConfirmClose}
      onSaveAndClose={handleSaveAndClose}
    />
  );
}

// Desktop: Side-by-side tree + editor
interface DesktopFileExplorerProps {
  files: FileNode[];
  loading: boolean;
  error: string | null;
  fileLoading: boolean;
  workingDirectory: string;
  openFiles: OpenFile[];
  activeFilePath: string | null;
  activeFile: OpenFile | undefined;
  saving: boolean;
  /** Tree refresh signal + manual refresh handler (header button). */
  refreshKey: number;
  onRefresh: () => void;
  onFileClick: (path: string) => void;
  onAddToAgent?: (path: string) => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onSave: () => void;
  /** #23 pending jump-to-line (terminal links / code search). */
  jump: JumpToLine | null;
  isDirty: (path: string) => boolean;
  updateContent: (path: string, content: string) => void;
  pendingClose: string | null;
  onCancelClose: () => void;
  onConfirmClose: () => void;
  onSaveAndClose: () => void;
}

function DesktopFileExplorer({
  files,
  loading,
  error,
  fileLoading,
  workingDirectory,
  openFiles,
  activeFilePath,
  activeFile,
  saving,
  refreshKey,
  onRefresh,
  onFileClick,
  onAddToAgent,
  onSelectTab,
  onCloseTab,
  onSave,
  jump,
  isDirty,
  updateContent,
  pendingClose,
  onCancelClose,
  onConfirmClose,
  onSaveAndClose,
}: DesktopFileExplorerProps) {
  const [treeWidth, setTreeWidth] = useState(280);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const newWidth = e.clientX - containerRect.left;
      setTreeWidth(Math.max(200, Math.min(500, newWidth)));
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  return (
    <div ref={containerRef} className="bg-background flex h-full w-full">
      {/* File tree panel */}
      <div className="flex h-full flex-col" style={{ width: treeWidth }}>
        <div className="flex items-center gap-2 p-3">
          <FolderOpen className="text-muted-foreground h-4 w-4 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">Files</p>
            {/* Show WHICH directory the tree is rooted at — it can move (the
                view follows the terminal's live cwd), so the root must be
                visible, not implied. rtl truncates from the START: the tail
                (the distinguishing, changing part) stays visible. The ltr
                <bdi> keeps a leading "/" or "~" from jumping to the end. */}
            <p
              className="text-muted-foreground truncate text-left text-xs [direction:rtl]"
              title={workingDirectory}
            >
              <bdi dir="ltr">{workingDirectory}</bdi>
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh files"
            className="h-7 w-7 flex-shrink-0"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && files.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : error && files.length === 0 ? (
            <div className="text-muted-foreground flex h-32 flex-col items-center justify-center p-4">
              <AlertCircle className="mb-2 h-8 w-8" />
              <p className="text-center text-sm">{error}</p>
            </div>
          ) : files.length === 0 ? (
            <div className="text-muted-foreground flex h-32 items-center justify-center">
              <p className="text-sm">Empty directory</p>
            </div>
          ) : (
            <FileTree
              key={workingDirectory}
              nodes={files}
              basePath={workingDirectory}
              onFileClick={onFileClick}
              onAddToAgent={onAddToAgent}
              refreshKey={refreshKey}
            />
          )}
        </div>
      </div>

      {/* Resize handle */}
      <div
        className="bg-muted/50 hover:bg-primary/50 active:bg-primary w-1 flex-shrink-0 cursor-col-resize transition-colors"
        onMouseDown={handleMouseDown}
      />

      {/* Editor panel */}
      <div className="bg-muted/20 flex h-full min-w-0 flex-1 flex-col">
        {/* Tabs */}
        {openFiles.length > 0 && (
          <div className="bg-background/50">
            <FileTabs
              files={openFiles}
              activeFilePath={activeFilePath}
              onSelect={onSelectTab}
              onClose={onCloseTab}
              isDirty={isDirty}
            />
          </div>
        )}

        {/* Editor or empty state */}
        <div className="flex-1 overflow-hidden">
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
              onSave={onSave}
              jumpToLine={jump && jump.path === activeFile.path ? jump : null}
            />
          ) : (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center">
              <Folder className="mb-4 h-12 w-12 opacity-50" />
              <p className="text-sm">Select a file to edit</p>
            </div>
          )}
        </div>
      </div>

      {/* Unsaved changes dialog */}
      <UnsavedChangesDialog
        open={!!pendingClose}
        fileName={pendingClose ? baseName(pendingClose) : ""}
        onCancel={onCancelClose}
        onDiscard={onConfirmClose}
        onSave={onSaveAndClose}
      />
    </div>
  );
}

// Mobile: Full-screen tree OR full-screen editor
interface MobileFileExplorerProps extends DesktopFileExplorerProps {
  onBack: () => void;
}

function MobileFileExplorer({
  files,
  loading,
  error,
  fileLoading,
  workingDirectory,
  openFiles,
  activeFilePath,
  activeFile,
  saving,
  refreshKey,
  onRefresh,
  onFileClick,
  onAddToAgent,
  onSelectTab,
  onCloseTab,
  onSave,
  onBack,
  jump,
  isDirty,
  updateContent,
  pendingClose,
  onCancelClose,
  onConfirmClose,
  onSaveAndClose,
}: MobileFileExplorerProps) {
  // Show editor when a file is active
  if (activeFile) {
    const isCurrentDirty = activeFilePath ? isDirty(activeFilePath) : false;

    return (
      <div className="bg-background flex h-full w-full flex-col">
        {/* Header */}
        <div className="bg-muted/30 flex items-center gap-2 p-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <FileTabs
              files={openFiles}
              activeFilePath={activeFilePath}
              onSelect={onSelectTab}
              onClose={onCloseTab}
              isDirty={isDirty}
            />
          </div>
          {isCurrentDirty && (
            <Button
              variant="default"
              size="sm"
              onClick={onSave}
              disabled={saving}
              className="flex-shrink-0"
            >
              <Save className="mr-1 h-4 w-4" />
              Save
            </Button>
          )}
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-hidden">
          {fileLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : (
            <FileEditor
              content={activeFile.currentContent}
              language={activeFile.language}
              isBinary={activeFile.isBinary}
              onChange={(content) => updateContent(activeFile.path, content)}
              onSave={onSave}
              jumpToLine={jump && jump.path === activeFile.path ? jump : null}
            />
          )}
        </div>

        {/* Unsaved changes dialog */}
        <UnsavedChangesDialog
          open={!!pendingClose}
          fileName={pendingClose ? baseName(pendingClose) : ""}
          onCancel={onCancelClose}
          onDiscard={onConfirmClose}
          onSave={onSaveAndClose}
        />
      </div>
    );
  }

  // Show file tree
  return (
    <div className="bg-background flex h-full w-full flex-col">
      <div className="flex items-center gap-2 p-3">
        <Folder className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Files</p>
          {/* Start-truncated like the desktop panel: the tail is the
              distinguishing, changing part of a live root. */}
          <p
            className="text-muted-foreground truncate text-left text-xs [direction:rtl]"
            title={workingDirectory}
          >
            <bdi dir="ltr">{workingDirectory}</bdi>
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh files"
          className="h-7 w-7 flex-shrink-0"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Gate on EMPTY data, not `loading` alone: unmounting FileTree on a
            refresh would wipe its expanded-dir state (the keyed remount is
            only for working-directory switches). */}
        {loading && files.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
          </div>
        ) : error && files.length === 0 ? (
          <div className="text-muted-foreground flex h-32 flex-col items-center justify-center p-4">
            <AlertCircle className="mb-2 h-8 w-8" />
            <p className="text-center text-sm">{error}</p>
          </div>
        ) : files.length === 0 ? (
          <div className="text-muted-foreground flex h-32 items-center justify-center">
            <p className="text-sm">Empty directory</p>
          </div>
        ) : (
          <FileTree
            key={workingDirectory}
            nodes={files}
            basePath={workingDirectory}
            onFileClick={onFileClick}
            onAddToAgent={onAddToAgent}
            refreshKey={refreshKey}
          />
        )}
      </div>

      {fileLoading && (
        <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
          <Loader2 className="text-primary h-8 w-8 animate-spin" />
        </div>
      )}
    </div>
  );
}

// Unsaved changes confirmation dialog
interface UnsavedChangesDialogProps {
  open: boolean;
  fileName: string;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

function UnsavedChangesDialog({
  open,
  fileName,
  onCancel,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen: boolean) => !isOpen && onCancel()}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            {fileName} has unsaved changes. What would you like to do?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onDiscard}>
            Discard
          </Button>
          <Button onClick={onSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
