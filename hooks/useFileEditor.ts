import { useState, useCallback, useRef } from "react";
import { getLanguageFromExtension } from "@/lib/file-utils";

export interface OpenFile {
  path: string;
  content: string;
  currentContent: string;
  isBinary: boolean;
  language: string;
}

/** #23 jump-to-line request: applied by FileEditor when its file is active.
 *  `token` makes repeated jumps to the SAME line re-fire (effect key). */
export interface JumpToLine {
  path: string;
  line: number;
  token: number;
}

export interface UseFileEditorReturn {
  openFiles: OpenFile[];
  activeFilePath: string | null;
  loading: boolean;
  saving: boolean;
  /** #23: the pending jump-to-line for `jump.path`, or null. */
  jump: JumpToLine | null;
  openFile: (path: string, line?: number) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<{ success: boolean; error?: string }>;
  saveAllFiles: () => Promise<void>;
  isDirty: (path: string) => boolean;
  hasUnsavedChanges: boolean;
  getFile: (path: string) => OpenFile | undefined;
  reset: () => void;
}

export function useFileEditor(): UseFileEditorReturn {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [jump, setJump] = useState<JumpToLine | null>(null);
  // Monotonic token so every jump — even two clicks on the SAME line in the
  // same millisecond — re-fires the FileEditor effect.
  const jumpSeqRef = useRef(0);
  // Guards against superseded openFile requests: if the user clicks file A then
  // file B, whichever fetch resolves last must not clobber state.
  const openGenerationRef = useRef(0);
  // closeFile is memoized with an empty deps array, so read the latest active
  // path AND the latest open files through refs instead of capturing the
  // first-render values or a value mutated inside a state updater.
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;

  const getFile = useCallback(
    (path: string) => openFiles.find((f) => f.path === path),
    [openFiles]
  );

  const isDirty = useCallback(
    (path: string) => {
      const file = openFiles.find((f) => f.path === path);
      return file ? file.content !== file.currentContent : false;
    },
    [openFiles]
  );

  const hasUnsavedChanges = openFiles.some(
    (f) => f.content !== f.currentContent
  );

  const openFile = useCallback(
    async (path: string, line?: number) => {
      // Check if file is already open
      const existing = openFiles.find((f) => f.path === path);
      if (existing) {
        setActiveFilePath(path);
        if (line != null && line >= 1) {
          setJump({ path, line, token: ++jumpSeqRef.current });
        }
        return;
      }

      const generation = ++openGenerationRef.current;
      setLoading(true);
      try {
        const res = await fetch(
          `/api/files/content?path=${encodeURIComponent(path)}`
        );
        const data = await res.json();

        // Ignore stale responses so a fast second click wins.
        if (generation !== openGenerationRef.current) return;

        if (data.error) {
          console.error("Failed to open file:", data.error);
          return;
        }

        const ext = path.split(".").pop() || "";
        const newFile: OpenFile = {
          path: data.path,
          content: data.content,
          currentContent: data.content,
          isBinary: data.isBinary,
          language: getLanguageFromExtension(ext),
        };

        setOpenFiles((prev) => [...prev, newFile]);
        setActiveFilePath(data.path);
        // Keyed to the SERVER's canonical path (data.path) — that's what the
        // open-files list and activeFilePath hold.
        if (line != null && line >= 1) {
          setJump({ path: data.path, line, token: ++jumpSeqRef.current });
        }
      } catch (error) {
        console.error("Failed to open file:", error);
      } finally {
        if (generation === openGenerationRef.current) {
          setLoading(false);
        }
      }
    },
    [openFiles]
  );

  const closeFile = useCallback((path: string) => {
    // Functional update so rapid successive closes compose correctly.
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));

    // Only move the active tab when we closed the ACTIVE one. Compute the next
    // active path synchronously from the latest committed list via the ref —
    // NOT from a variable assigned inside the updater above (React runs the
    // updater during the later render, so that value would still be stale here).
    if (activeFilePathRef.current !== path) return;
    const prev = openFilesRef.current;
    const closedIndex = prev.findIndex((f) => f.path === path);
    const newFiles = prev.filter((f) => f.path !== path);
    let nextActive: string | null = null;
    if (newFiles.length > 0) {
      nextActive =
        closedIndex >= newFiles.length
          ? newFiles[newFiles.length - 1].path
          : newFiles[closedIndex].path;
    }
    setActiveFilePath(nextActive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateContent = useCallback((path: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, currentContent: content } : f))
    );
  }, []);

  const saveFile = useCallback(
    async (path: string): Promise<{ success: boolean; error?: string }> => {
      const file = openFiles.find((f) => f.path === path);
      if (!file) return { success: false, error: "File not found" };
      if (file.isBinary)
        return { success: false, error: "Cannot save binary files" };

      setSaving(true);
      try {
        const res = await fetch("/api/files/content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, content: file.currentContent }),
        });
        const data = await res.json();

        if (data.error) {
          return { success: false, error: data.error };
        }

        // Update the saved content to match current
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === path ? { ...f, content: f.currentContent } : f
          )
        );

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to save",
        };
      } finally {
        setSaving(false);
      }
    },
    [openFiles]
  );

  const saveAllFiles = useCallback(async () => {
    const dirtyFiles = openFiles.filter((f) => f.content !== f.currentContent);
    for (const file of dirtyFiles) {
      await saveFile(file.path);
    }
  }, [openFiles, saveFile]);

  const reset = useCallback(() => {
    setOpenFiles([]);
    setActiveFilePath(null);
    setJump(null);
    openGenerationRef.current = 0;
  }, []);

  return {
    openFiles,
    activeFilePath,
    loading,
    saving,
    jump,
    openFile,
    closeFile,
    setActiveFile: setActiveFilePath,
    updateContent,
    saveFile,
    saveAllFiles,
    isDirty,
    hasUnsavedChanges,
    getFile,
    reset,
  };
}
