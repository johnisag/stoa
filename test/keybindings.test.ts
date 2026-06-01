import { describe, it, expect } from "vitest";
import {
  eventToChord,
  isEditableTarget,
  resolveShortcut,
  formatChord,
  type Keybinding,
} from "@/lib/keybindings";

describe("eventToChord", () => {
  it("maps `mod` to Cmd on mac and Ctrl elsewhere", () => {
    expect(eventToChord({ key: "k", metaKey: true }, true)).toBe("mod+k");
    expect(eventToChord({ key: "k", ctrlKey: true }, false)).toBe("mod+k");
    // The non-primary modifier does not count as `mod`.
    expect(eventToChord({ key: "k", ctrlKey: true }, true)).toBe("k");
    expect(eventToChord({ key: "k", metaKey: true }, false)).toBe("k");
  });

  it("orders modifiers mod, alt, shift and lowercases the key", () => {
    expect(
      eventToChord(
        { key: "K", metaKey: true, altKey: true, shiftKey: true },
        true
      )
    ).toBe("mod+alt+shift+k");
  });

  it("normalizes space and keeps arrow names", () => {
    expect(eventToChord({ key: " " }, false)).toBe("space");
    expect(eventToChord({ key: "ArrowDown", altKey: true }, false)).toBe(
      "alt+arrowdown"
    );
  });

  it("does not double a bare modifier keypress into a redundant token", () => {
    expect(eventToChord({ key: "Shift", shiftKey: true }, false)).toBe("shift");
    expect(eventToChord({ key: "Control", ctrlKey: true }, false)).toBe("mod");
    expect(eventToChord({ key: "Meta", metaKey: true }, true)).toBe("mod");
  });
});

describe("isEditableTarget", () => {
  it("flags input/textarea/select and contenteditable", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true
    );
  });

  it("flags anything inside the xterm terminal", () => {
    expect(
      isEditableTarget({
        tagName: "DIV",
        closest: (s) => (s === ".xterm" ? {} : null),
      })
    ).toBe(true);
  });

  it("does not flag ordinary elements or null", () => {
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget({ tagName: "DIV", closest: () => null })).toBe(
      false
    );
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe("resolveShortcut", () => {
  const bindings: Keybinding[] = [
    { chord: "mod+k", action: "open-switcher", allowInInput: true },
    { chord: "alt+arrowdown", action: "next-session" },
  ];

  it("matches a binding by chord", () => {
    const hit = resolveShortcut({ key: "k", metaKey: true }, bindings, true);
    expect(hit?.action).toBe("open-switcher");
  });

  it("returns null when no binding matches", () => {
    expect(
      resolveShortcut({ key: "x", metaKey: true }, bindings, true)
    ).toBeNull();
  });

  it("ignores OS auto-repeat (held key) even for a matching chord", () => {
    expect(
      resolveShortcut({ key: "k", metaKey: true, repeat: true }, bindings, true)
    ).toBeNull();
  });

  it("suppresses non-allowInInput shortcuts when focus is in a text field", () => {
    const inInput = {
      key: "ArrowDown",
      altKey: true,
      target: { tagName: "INPUT" },
    };
    expect(resolveShortcut(inInput, bindings, true)).toBeNull();
    // ...but the same key works outside a text field.
    expect(
      resolveShortcut(
        { key: "ArrowDown", altKey: true, target: { tagName: "DIV" } },
        bindings,
        true
      )?.action
    ).toBe("next-session");
  });

  it("still fires allowInInput shortcuts inside a text field", () => {
    const hit = resolveShortcut(
      { key: "k", metaKey: true, target: { tagName: "INPUT" } },
      bindings,
      true
    );
    expect(hit?.action).toBe("open-switcher");
  });

  it("suppresses a terminal-conflicting chord when focus is inside the xterm terminal", () => {
    // ⌘/Ctrl+B (tmux prefix) and ⌘/Ctrl+\ (SIGQUIT) must NOT be allowInInput:
    // the .xterm guard has to let those keystrokes reach the terminal.
    const paneBindings: Keybinding[] = [
      { chord: "mod+b", action: "toggle-sidebar" },
      { chord: "mod+\\", action: "split-pane" },
    ];
    const inTerminal = (key: string) => ({
      key,
      ctrlKey: true,
      target: {
        tagName: "TEXTAREA",
        closest: (s: string) => (s === ".xterm" ? {} : null),
      },
    });
    expect(resolveShortcut(inTerminal("b"), paneBindings, false)).toBeNull();
    expect(resolveShortcut(inTerminal("\\"), paneBindings, false)).toBeNull();
    // ...but they still fire from app chrome (not a text/terminal surface).
    expect(
      resolveShortcut(
        { key: "b", ctrlKey: true, target: { tagName: "DIV" } },
        paneBindings,
        false
      )?.action
    ).toBe("toggle-sidebar");
  });
});

describe("formatChord", () => {
  it("uses mac glyphs concatenated, platform words joined with + elsewhere", () => {
    expect(formatChord("mod+k", true)).toBe("⌘K");
    expect(formatChord("mod+k", false)).toBe("Ctrl+K");
  });

  it("renders arrow keys as glyphs", () => {
    expect(formatChord("alt+arrowdown", true)).toBe("⌥↓");
    expect(formatChord("alt+arrowdown", false)).toBe("Alt+↓");
  });

  it("keeps single-character keys (uppercased) and punctuation", () => {
    expect(formatChord("shift+?", false)).toBe("Shift+?");
    expect(formatChord("shift+?", true)).toBe("⇧?");
    expect(formatChord("mod+/", false)).toBe("Ctrl+/");
  });
});
