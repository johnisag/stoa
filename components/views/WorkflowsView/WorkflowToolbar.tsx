"use client";

import {
  Check,
  ClipboardPaste,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  Fullscreen,
  HelpCircle,
  Plus,
  Redo2,
  Save,
  StickyNote,
  Trash2,
  Undo2,
  Upload,
  Wand2,
} from "lucide-react";
import type {
  BuilderDoc,
  HistorySnapshot,
  SavedWorkflow,
} from "@/lib/pipeline/builder-model";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatSnapshotTime } from "./builder-helpers";

/**
 * The workflow builder's action toolbar: undo/redo/center/shortcuts, the "Saved"
 * dropdown (save / save-copy / delete / tidy / new / example / import / paste /
 * export / copy-json + the saved-workflows and history lists), the hidden import
 * file input, add-step / add-note, and the multi-select duplicate/delete actions.
 *
 * Extracted VERBATIM from WorkflowBuilder — same markup, same disabled logic,
 * same handlers wired through props — so behavior is byte-identical. Purely
 * presentational: it owns no state; every action is a callback from the builder.
 */
export function WorkflowToolbar({
  doc,
  canUndo,
  canRedo,
  dirty,
  savedId,
  savedList,
  currentSaved,
  createPending,
  updatePending,
  selectedIds,
  fileRef,
  onUndo,
  onRedo,
  onFitAll,
  onShowShortcuts,
  onSave,
  onSaveCopy,
  onDeleteSaved,
  onTidy,
  onNewWorkflow,
  onLoadExample,
  onImportClick,
  onPasteOpen,
  onExport,
  onCopyJson,
  onLoadDoc,
  onLoadSnapshot,
  onImportFile,
  onAdd,
  onAddNote,
  onDuplicate,
  onDeleteSelected,
}: {
  doc: BuilderDoc;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  savedId: string | null;
  savedList: { data?: SavedWorkflow[] };
  currentSaved: SavedWorkflow | null;
  createPending: boolean;
  updatePending: boolean;
  selectedIds: Set<string>;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onUndo: () => void;
  onRedo: () => void;
  onFitAll: () => void;
  onShowShortcuts: () => void;
  onSave: () => void;
  onSaveCopy: () => void;
  onDeleteSaved: () => void;
  onTidy: () => void;
  onNewWorkflow: () => void;
  onLoadExample: () => void;
  onImportClick: () => void;
  onPasteOpen: () => void;
  onExport: () => void;
  onCopyJson: () => void;
  onLoadDoc: (doc: BuilderDoc, id: string) => void;
  onLoadSnapshot: (snapshot: HistorySnapshot) => void;
  onImportFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAdd: () => void;
  onAddNote: () => void;
  onDuplicate: () => void;
  onDeleteSelected: () => void;
}) {
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Undo"
        title="Undo"
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Redo"
        title="Redo"
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Center all items"
        title="Center all items"
        disabled={doc.nodes.length === 0 && doc.notes.length === 0}
        onClick={onFitAll}
      >
        <Fullscreen className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        onClick={onShowShortcuts}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" /> Saved
            {dirty && (
              <span
                className="ml-1 inline-block h-2 w-2 rounded-full bg-amber-500"
                title="Unsaved changes"
                aria-label="Unsaved changes"
              />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-80 w-56 overflow-y-auto"
        >
          {/* Save stays ENABLED even when not ready — handleSave's toast then
              teaches why (a disabled item gives a phone tap no feedback). */}
          <DropdownMenuItem
            onSelect={onSave}
            disabled={createPending || updatePending}
          >
            <Save className="mr-2 h-3.5 w-3.5" />
            {savedId ? "Save" : "Save as new"}
          </DropdownMenuItem>
          {savedId && (
            <DropdownMenuItem onSelect={onSaveCopy} disabled={createPending}>
              <Copy className="mr-2 h-3.5 w-3.5" /> Save a copy
            </DropdownMenuItem>
          )}
          {savedId && (
            <DropdownMenuItem
              onSelect={onDeleteSaved}
              className="text-red-600 dark:text-red-400"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete current
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onTidy} disabled={doc.nodes.length === 0}>
            <Wand2 className="mr-2 h-3.5 w-3.5" /> Tidy layout
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewWorkflow}>
            <Plus className="mr-2 h-3.5 w-3.5" /> New workflow
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onLoadExample}>
            <FileJson className="mr-2 h-3.5 w-3.5" /> Load example
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onImportClick}>
            <Upload className="mr-2 h-3.5 w-3.5" /> Import workflow…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onPasteOpen}>
            <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> Paste JSON
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onExport}
            disabled={doc.nodes.length === 0 && doc.notes.length === 0}
          >
            <Download className="mr-2 h-3.5 w-3.5" /> Export workflow
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onCopyJson}
            disabled={doc.nodes.length === 0 && doc.notes.length === 0}
          >
            <Copy className="mr-2 h-3.5 w-3.5" /> Copy JSON
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Saved workflows</DropdownMenuLabel>
          {savedList.data && savedList.data.length > 0 ? (
            savedList.data.map((wf) => (
              <DropdownMenuItem
                key={wf.id}
                onSelect={() => onLoadDoc(wf.doc, wf.id)}
                className="flex items-center gap-2"
              >
                <Check
                  className={cn(
                    "h-3.5 w-3.5 flex-shrink-0",
                    wf.id === savedId ? "opacity-100" : "opacity-0"
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{wf.name}</span>
                <span className="text-muted-foreground flex-shrink-0 text-[10px]">
                  {wf.doc.nodes.length} step
                  {wf.doc.nodes.length === 1 ? "" : "s"}
                </span>
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem disabled>No saved workflows yet</DropdownMenuItem>
          )}
          {currentSaved && currentSaved.history.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>History</DropdownMenuLabel>
              {currentSaved.history.map((snapshot) => (
                <DropdownMenuItem
                  key={snapshot.id}
                  onSelect={() => onLoadSnapshot(snapshot)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="truncate text-xs">{snapshot.name}</span>
                  <span className="text-muted-foreground text-[10px]">
                    {formatSnapshotTime(snapshot.createdAt)}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onImportFile}
      />
      <Button type="button" variant="outline" size="sm" onClick={onAdd}>
        <Plus className="mr-1.5 h-3.5 w-3.5" /> Add step
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onAddNote}>
        <StickyNote className="mr-1.5 h-3.5 w-3.5" /> Add note
      </Button>
      {selectedIds.size > 0 && (
        <>
          <span className="text-muted-foreground text-xs">
            {selectedIds.size} selected
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              ![...selectedIds].some((id) =>
                doc.nodes.some((n) => n.step.id === id)
              )
            }
            onClick={onDuplicate}
          >
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Duplicate
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDeleteSelected}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
          </Button>
        </>
      )}
    </div>
  );
}
