import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import type { AgentType } from "@/lib/providers";
import { getModelOptions, isFreeTextModelAgent } from "@/lib/model-catalog";

interface ModelSelectorProps {
  agentType: AgentType;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Per-session model picker. A dropdown of the agent's known models
 * (Claude/Codex), or a free-text field for dynamic-model agents (Hermes), where
 * blank means "use the agent's own default". Mirrors the Project dialogs.
 */
export function ModelSelector({
  agentType,
  value,
  onChange,
}: ModelSelectorProps) {
  const options = getModelOptions(agentType);
  const selectedLabel =
    options.find((o) => o.value === value)?.label || "Select a model";

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Model</label>
      {isFreeTextModelAgent(agentType) ? (
        // Dynamic-model agents (e.g. Hermes): free-text. Blank = agent default.
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. anthropic/claude-sonnet-4.6 — blank for the agent default"
        />
      ) : (
        <>
          <Select key={agentType} value={value} onValueChange={onChange}>
            <SelectTrigger>
              <SelectValue>{selectedLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            Sets the model for a new session.
            {agentType === "claude" &&
              " Resumed sessions keep the model they started with."}
          </p>
        </>
      )}
    </div>
  );
}
