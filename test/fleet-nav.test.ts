import { describe, it, expect } from "vitest";
import {
  BarChart3,
  Rocket,
  Workflow,
  Inbox,
  Columns3,
  Bell,
  Compass,
  Command,
  Sparkles,
  NotebookPen,
  LayoutGrid,
  Gauge,
  TerminalSquare,
} from "lucide-react";
import { FLEET_NAV, fleetNavEntry } from "@/components/nav/fleet-nav";

// FLEET_NAV is the single source of truth shared by the desktop header
// (DesktopView) and the sidebar footer (SidebarFooter). These assertions lock
// the descriptor so the two surfaces can't silently drift apart again.

describe("FLEET_NAV", () => {
  it("contains exactly the expected destinations, in order", () => {
    expect(FLEET_NAV.map((e) => e.id)).toEqual([
      "insight",
      "dispatch",
      "workflows",
      "verdict-inbox",
      "fleet-board",
      "live-wall",
      "agent-monitor",
      "ask-stoa",
      "notes",
      "commands",
      "notifications",
      "guide",
      "quick-switch",
    ]);
  });

  it("pairs each id with its canonical icon", () => {
    const icons = Object.fromEntries(FLEET_NAV.map((e) => [e.id, e.icon]));
    expect(icons.insight).toBe(BarChart3);
    expect(icons.dispatch).toBe(Rocket);
    expect(icons.workflows).toBe(Workflow);
    expect(icons["verdict-inbox"]).toBe(Inbox);
    expect(icons["fleet-board"]).toBe(Columns3);
    expect(icons["live-wall"]).toBe(LayoutGrid);
    expect(icons["agent-monitor"]).toBe(Gauge);
    expect(icons["ask-stoa"]).toBe(Sparkles);
    expect(icons.notes).toBe(NotebookPen);
    expect(icons.commands).toBe(TerminalSquare);
    expect(icons.notifications).toBe(Bell);
    expect(icons.guide).toBe(Compass);
    expect(icons["quick-switch"]).toBe(Command);
  });

  it("uses the descriptive aria-labels as the canonical accessible names", () => {
    const aria = Object.fromEntries(FLEET_NAV.map((e) => [e.id, e.ariaLabel]));
    expect(aria.insight).toBe("Insight (analytics over the audit ledger)");
    expect(aria.dispatch).toBe("Dispatch (GitHub issues to agents)");
    expect(aria.workflows).toBe(
      "Workflows (run an agent pipeline from a template)"
    );
    expect(aria["verdict-inbox"]).toBe(
      "Verdict Inbox (the fleet review queue)"
    );
    expect(aria["fleet-board"]).toBe(
      "Fleet Board (the fleet by lifecycle stage)"
    );
    expect(aria["live-wall"]).toBe(
      "Live Wall (read-only grid of agent terminals)"
    );
    expect(aria["agent-monitor"]).toBe(
      "Agent Monitor (per-session telemetry — model, tokens, context, cost)"
    );
    expect(aria["ask-stoa"]).toBe("Ask Stoa (chat about your fleet)");
    expect(aria.notes).toBe("Notes (shared knowledge base)");
    expect(aria.commands).toBe("Commands (author native slash commands)");
    expect(aria.notifications).toBe(
      "Notifications (sound, per-event toggles, push)"
    );
    expect(aria.guide).toBe("What Stoa can do — feature guide");
    expect(aria["quick-switch"]).toBe("Quick switch (Cmd/Ctrl+K)");
  });

  it("keeps the tooltip titles (labels) the surfaces render today", () => {
    const labels = Object.fromEntries(FLEET_NAV.map((e) => [e.id, e.label]));
    expect(labels.insight).toBe("Insight");
    expect(labels.dispatch).toBe("Dispatch");
    expect(labels.workflows).toBe("Workflows");
    expect(labels["verdict-inbox"]).toBe("Verdict Inbox");
    expect(labels["fleet-board"]).toBe("Fleet Board");
    expect(labels["live-wall"]).toBe("Live Wall");
    expect(labels["agent-monitor"]).toBe("Agent Monitor");
    expect(labels["ask-stoa"]).toBe("Ask Stoa");
    expect(labels.notes).toBe("Notes");
    expect(labels.commands).toBe("Commands");
    expect(labels.notifications).toBe("Notifications");
    expect(labels.guide).toBe("What Stoa can do");
    expect(labels["quick-switch"]).toBe("Quick switch");
  });

  it("entries with keyboard-shortcut tooltip hints have the expected chords", () => {
    expect(fleetNavEntry("quick-switch").tooltipHint).toBe("⌘K");
    expect(fleetNavEntry("ask-stoa").tooltipHint).toBe("⌘⇧C");
    for (const entry of FLEET_NAV) {
      if (entry.id !== "quick-switch" && entry.id !== "ask-stoa") {
        expect(entry.tooltipHint).toBeUndefined();
      }
    }
  });

  it("has unique ids", () => {
    const ids = FLEET_NAV.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("fleetNavEntry", () => {
  it("looks up an entry by id", () => {
    expect(fleetNavEntry("dispatch").label).toBe("Dispatch");
  });

  it("throws on an unknown id", () => {
    expect(() => fleetNavEntry("nope")).toThrow(/Unknown fleet nav entry/);
  });
});
