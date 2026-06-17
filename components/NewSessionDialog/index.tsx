"use client";

import { useState } from "react";
import { HelpCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FolderPicker } from "@/components/FolderPicker";
import { useHomePath } from "@/hooks/useHomePath";
import { useViewport } from "@/hooks/useViewport";

import { useNewSessionForm } from "./hooks/useNewSessionForm";
import { AgentSelector } from "./AgentSelector";
import { ModelSelector } from "./ModelSelector";
import { WorkingDirectoryInput } from "./WorkingDirectoryInput";
import { WorktreeSection } from "./WorktreeSection";
import { WorkspaceSection } from "./WorkspaceSection";
import { ProjectSelector } from "./ProjectSelector";
import { AdvancedSettings } from "./AdvancedSettings";
import { CreatingOverlay } from "./CreatingOverlay";
import { NewSessionHelp } from "./NewSessionHelp";
import type { NewSessionDialogProps } from "./NewSessionDialog.types";

export function NewSessionDialog({
  open,
  projects,
  selectedProjectId,
  onClose,
  onCreated,
  onCreateProject,
}: NewSessionDialogProps) {
  const [showHelp, setShowHelp] = useState(false);
  const { toTildePath } = useHomePath();
  const { isMobile } = useViewport();
  const form = useNewSessionForm({
    open,
    projects,
    selectedProjectId,
    onCreated,
    onClose,
    onCreateProject,
  });

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => !o && !form.isLoading && form.handleClose()}
      >
        <DialogContent
          sheet={isMobile}
          className="max-h-[85vh] overflow-y-auto"
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.shiftKey && !form.isLoading) {
              e.preventDefault();
              form.handleSubmit(e as unknown as React.FormEvent);
            }
          }}
        >
          {/* Loading overlay */}
          {form.isLoading && (
            <CreatingOverlay
              isWorktree={form.useWorktree || form.isWorkspace}
              step={form.creationStep}
            />
          )}
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle>New Session</DialogTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="How sessions work"
                title="How sessions work"
                aria-pressed={showHelp}
                onClick={() => setShowHelp((v) => !v)}
              >
                <HelpCircle className="h-4 w-4" />
              </Button>
            </div>
          </DialogHeader>
          {showHelp ? (
            <NewSessionHelp onClose={() => setShowHelp(false)} />
          ) : (
            <form onSubmit={form.handleSubmit} className="space-y-4">
              <AgentSelector
                value={form.agentType}
                onChange={form.handleAgentTypeChange}
              />

              <ModelSelector
                agentType={form.agentType}
                value={form.model}
                onChange={form.setModel}
              />

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Name{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </label>
                <Input
                  value={form.name}
                  onChange={(e) => form.setName(e.target.value)}
                  placeholder="Auto-generated if empty"
                  autoFocus
                />
              </div>

              <WorkingDirectoryInput
                value={form.workingDirectory}
                onChange={form.setWorkingDirectory}
                gitInfo={form.gitInfo}
                checkingGit={form.checkingGit}
                onBrowse={() => form.setShowDirectoryPicker(true)}
              />

              {form.gitInfo?.isGitRepo && (
                <WorktreeSection
                  gitInfo={form.gitInfo}
                  useWorktree={form.useWorktree}
                  onUseWorktreeChange={form.setUseWorktree}
                  featureName={form.featureName}
                  onFeatureNameChange={form.setFeatureName}
                  baseBranch={form.baseBranch}
                  onBaseBranchChange={form.setBaseBranch}
                  worktreeMode={form.worktreeMode}
                  onWorktreeModeChange={form.setWorktreeMode}
                  existingWorktreePath={form.existingWorktreePath}
                  onExistingWorktreeChange={form.setExistingWorktree}
                />
              )}

              {form.gitInfo &&
                !form.gitInfo.isGitRepo &&
                form.subRepos.length > 0 && (
                  <WorkspaceSection
                    subRepos={form.subRepos}
                    selectedSubRepos={form.selectedSubRepos}
                    onToggleRepo={form.toggleSubRepo}
                    allSelected={form.allSubReposSelected}
                    onToggleAll={form.toggleAllSubRepos}
                    featureName={form.featureName}
                    onFeatureNameChange={form.setFeatureName}
                  />
                )}

              <ProjectSelector
                projects={projects}
                projectId={form.projectId}
                onProjectChange={form.handleProjectChange}
                workingDirectory={form.workingDirectory}
                agentType={form.agentType}
                showNewProject={form.showNewProject}
                onShowNewProjectChange={form.setShowNewProject}
                newProjectName={form.newProjectName}
                onNewProjectNameChange={form.setNewProjectName}
                creatingProject={form.creatingProject}
                onCreateProject={form.handleCreateProject}
                canCreateProject={!!onCreateProject}
              />

              {/* Initial Prompt */}
              <div className="space-y-2">
                <label htmlFor="initialPrompt" className="text-sm font-medium">
                  Initial Prompt{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </label>
                <Textarea
                  id="initialPrompt"
                  value={form.initialPrompt}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    form.setInitialPrompt(e.target.value)
                  }
                  placeholder="Enter a prompt to send when the session starts..."
                  className="min-h-[80px] resize-none text-sm"
                  rows={3}
                />
              </div>

              <AdvancedSettings
                open={form.advancedOpen}
                onOpenChange={form.setAdvancedOpen}
                agentType={form.agentType}
                useTmux={form.useTmux}
                onUseTmuxChange={form.handleUseTmuxChange}
                skipPermissions={form.skipPermissions}
                onSkipPermissionsChange={form.handleSkipPermissionsChange}
                enableOrchestration={form.enableOrchestration}
                onEnableOrchestrationChange={form.setEnableOrchestration}
              />

              {form.error && (
                <p className="text-sm text-red-500">{form.error}</p>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={form.handleClose}
                  disabled={form.isLoading}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    form.isLoading ||
                    (form.useWorktree && !form.featureName.trim()) ||
                    (form.isWorkspace && !form.featureName.trim())
                  }
                >
                  {form.isLoading ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {form.showDirectoryPicker && (
        <FolderPicker
          initialPath={form.workingDirectory || "~"}
          onSelect={(path) => {
            form.setWorkingDirectory(toTildePath(path));
            form.setShowDirectoryPicker(false);
          }}
          onClose={() => form.setShowDirectoryPicker(false)}
        />
      )}
    </>
  );
}
