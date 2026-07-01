import { ChevronRight } from "lucide-react";
import type { AgentType } from "@/lib/providers";
import { getProviderDefinition } from "@/lib/providers";

interface AdvancedSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentType: AgentType;
  useTmux: boolean;
  onUseTmuxChange: (checked: boolean) => void;
  skipPermissions: boolean;
  onSkipPermissionsChange: (checked: boolean) => void;
  enableOrchestration: boolean;
  onEnableOrchestrationChange: (checked: boolean) => void;
  /** #21: lifetime USD budget cap ("" = no budget). */
  budgetUsd: string;
  onBudgetUsdChange: (value: string) => void;
}

export function AdvancedSettings({
  open,
  onOpenChange,
  agentType,
  useTmux,
  onUseTmuxChange,
  skipPermissions,
  onSkipPermissionsChange,
  enableOrchestration,
  onEnableOrchestrationChange,
  budgetUsd,
  onBudgetUsdChange,
}: AdvancedSettingsProps) {
  const provider = getProviderDefinition(agentType);
  const supportsAutoApprove = Boolean(provider.autoApproveFlag);
  const supportsOrchestration = Boolean(provider.supportsOrchestration);

  return (
    <div className="border-border rounded-lg border">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
      >
        <ChevronRight
          className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
        />
        Advanced Settings
      </button>
      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="useTmux"
              checked={useTmux}
              onChange={(e) => onUseTmuxChange(e.target.checked)}
              className="border-border bg-background accent-primary h-4 w-4 rounded"
            />
            <label htmlFor="useTmux" className="cursor-pointer text-sm">
              Use tmux session
              <span className="text-muted-foreground ml-1">
                (enables detach/attach)
              </span>
            </label>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="skipPermissions"
                checked={skipPermissions}
                disabled={!supportsAutoApprove}
                onChange={(e) => onSkipPermissionsChange(e.target.checked)}
                className="border-border bg-background accent-primary h-4 w-4 rounded disabled:cursor-not-allowed disabled:opacity-50"
              />
              <label
                htmlFor="skipPermissions"
                className="cursor-pointer text-sm"
              >
                Auto-approve tool calls
                <span className="text-muted-foreground ml-1">
                  {supportsAutoApprove
                    ? `(${provider.autoApproveFlag})`
                    : "(not supported)"}
                </span>
              </label>
            </div>
            {skipPermissions && supportsAutoApprove && (
              // Plain-language consequence, shown only once it's enabled — so the
              // choice is informed without a wall of text by default.
              <p className="text-destructive mt-1 ml-6 text-xs">
                The agent will edit files and run shell commands without asking
                you first — enable only for code and machines you trust.
              </p>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="enableOrchestration"
                checked={supportsOrchestration && enableOrchestration}
                disabled={!supportsOrchestration}
                onChange={(e) => onEnableOrchestrationChange(e.target.checked)}
                className="border-border bg-background accent-primary h-4 w-4 rounded disabled:cursor-not-allowed disabled:opacity-50"
              />
              <label
                htmlFor="enableOrchestration"
                className="cursor-pointer text-sm"
              >
                Enable orchestration
                <span className="text-muted-foreground ml-1">
                  {supportsOrchestration
                    ? "(conductor — can spawn worker sessions via spawn_worker)"
                    : "(Claude only for now)"}
                </span>
              </label>
            </div>
            {supportsOrchestration && enableOrchestration && (
              // The workers a conductor spawns ALWAYS run auto-approve — surface
              // that here too, so enabling orchestration is informed consent.
              <p className="text-destructive mt-1 ml-6 text-xs">
                Worker sessions always run with auto-approve — they edit files
                and run commands without asking.
              </p>
            )}
          </div>
          {/* #21 per-session budget cap */}
          <div>
            <label htmlFor="budgetUsd" className="text-sm">
              Budget (USD)
            </label>
            <input
              type="number"
              id="budgetUsd"
              min="0"
              step="0.01"
              value={budgetUsd}
              onChange={(e) => onBudgetUsdChange(e.target.value)}
              placeholder="no budget"
              className="border-border bg-background mt-1 block h-8 w-32 rounded border px-2 text-sm"
            />
            <p className="text-muted-foreground mt-1 text-xs">
              Push alert at 80% and 100% of this session&apos;s spend. With
              STOA_BUDGET_PARK=1 the session is parked at the cap (Stoa stops
              feeding it queued work; you can still type). Blank = no budget.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
