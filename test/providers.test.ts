import { describe, it, expect } from "vitest";
import {
  getProvider,
  getAllProviders,
  isValidAgentType,
  buildAgentArgs,
} from "@/lib/providers";
import {
  PROVIDER_IDS,
  getAllProviderDefinitions,
  getProviderDefinition,
  getManagedSessionPattern,
  getProviderIdFromSessionName,
  getSessionIdFromName,
  isValidProviderId,
  sessionKey,
} from "@/lib/providers/registry";
import { AGENT_OPTIONS } from "@/components/NewSessionDialog/NewSessionDialog.types";

describe("Hermes provider wiring", () => {
  it("has the expected registry definition", () => {
    const def = getProviderDefinition("hermes");
    expect(def.cli).toBe("hermes");
    expect(def.autoApproveFlag).toBe("--yolo");
    expect(def.resumeFlag).toBe("--resume");
    expect(def.supportsResume).toBe(true); // resume on via banner session-id capture
    expect(def.supportsFork).toBe(false); // Hermes has no --fork-session
    expect(def.modelFlag).toBe("-m"); // dynamic models passed as free-text via -m
  });

  it("has a provider object whose buildFlags emits --yolo only on auto-approve", () => {
    const p = getProvider("hermes");
    expect(p.command).toBe("hermes");
    expect(p.supportsResume).toBe(true); // lockstep with the registry definition
    expect(p.buildFlags({})).toEqual([]);
    expect(p.buildFlags({ autoApprove: true })).toEqual(["--yolo"]);
    expect(p.buildFlags({ skipPermissions: true })).toEqual(["--yolo"]);
  });

  it("builds argv with --yolo + free-text model via -m; prompt still not wired", () => {
    const { binary, args } = buildAgentArgs("hermes", {
      autoApprove: true,
      model: "anthropic/claude-opus-4.8",
      initialPrompt: "hi", // still ignored (initialPromptFlag unset)
    });
    expect(binary).toBe("hermes");
    expect(args).toEqual(["--yolo", "-m", "anthropic/claude-opus-4.8"]);
  });

  it("is a valid agent type and appears in the New Session picker", () => {
    expect(isValidProviderId("hermes")).toBe(true);
    expect(isValidAgentType("hermes")).toBe(true);
    expect(AGENT_OPTIONS.some((o) => o.value === "hermes")).toBe(true);
  });

  it("is matched by the managed-session name pattern", () => {
    const re = getManagedSessionPattern();
    expect(re.test("hermes-12345678-1234-1234-1234-123456789abc")).toBe(true);
  });
});

// Guards against half-wiring a provider (registry entry without a provider
// object, a picker option for a non-existent id, etc.).
describe("provider registry integrity", () => {
  it("every registry id has a matching provider object and definition", () => {
    for (const id of PROVIDER_IDS) {
      expect(getProvider(id).id).toBe(id);
      expect(getProviderDefinition(id).id).toBe(id);
    }
    expect(getAllProviders()).toHaveLength(PROVIDER_IDS.length);
    expect(getAllProviderDefinitions()).toHaveLength(PROVIDER_IDS.length);
  });

  it("every agent-picker option maps to a real provider id", () => {
    for (const opt of AGENT_OPTIONS) {
      expect(isValidProviderId(opt.value)).toBe(true);
    }
  });

  it("buildAgentArgs uses each provider's cli as the spawn binary", () => {
    for (const id of PROVIDER_IDS) {
      expect(buildAgentArgs(id, {}).binary).toBe(getProviderDefinition(id).cli);
    }
  });
});

// sessionKey() is the single constructor for the `{provider}-{id}` namespace;
// these lock its format and that it stays the exact inverse of the parsers so
// the migration from 13 hand-built sites is byte-identical.
describe("sessionKey() — centralized session-name construction", () => {
  const UUID = "12345678-1234-1234-1234-123456789abc";

  it("builds the canonical {provider}-{id} for each provider (format lock)", () => {
    expect(sessionKey({ kind: "agent", provider: "claude", id: "abc" })).toBe(
      "claude-abc"
    );
    expect(sessionKey({ kind: "agent", provider: "codex", id: "abc" })).toBe(
      "codex-abc"
    );
    expect(sessionKey({ kind: "agent", provider: "hermes", id: "abc" })).toBe(
      "hermes-abc"
    );
    expect(sessionKey({ kind: "agent", provider: "shell", id: "abc" })).toBe(
      "shell-abc"
    );
  });

  it("shell sugar equals the explicit shell-provider form", () => {
    expect(sessionKey({ kind: "shell", id: UUID })).toBe(
      sessionKey({ kind: "agent", provider: "shell", id: UUID })
    );
    expect(sessionKey({ kind: "shell", id: UUID })).toBe(`shell-${UUID}`);
  });

  it("round-trips through the parsers + managed pattern for every provider", () => {
    for (const id of PROVIDER_IDS) {
      const key = sessionKey({ kind: "agent", provider: id, id: UUID });
      expect(getProviderIdFromSessionName(key)).toBe(id);
      expect(getSessionIdFromName(key)).toBe(UUID);
      expect(getManagedSessionPattern().test(key)).toBe(true);
    }
  });

  it("no provider id prefixes another (keeps getProviderIdFromSessionName unambiguous)", () => {
    for (const a of PROVIDER_IDS) {
      for (const b of PROVIDER_IDS) {
        if (a !== b) expect(`${a}-`.startsWith(`${b}-`)).toBe(false);
      }
    }
  });
});
