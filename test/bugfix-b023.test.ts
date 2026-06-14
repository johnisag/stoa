// @vitest-environment jsdom
/**
 * Regression for B023: FileEditor must keep its CodeMirror `extensions` stable
 * across parent re-renders that only change the `onSave` identity.
 *
 * The bug: the extensions-building effect depended on [language, onSave].
 * FileExplorerDrawer (and any caller) passes a fresh arrow `onSave` on every
 * render, so the effect re-ran setExtensions on every parent render while the
 * user was editing — recreating the editor theme + keymap each time.
 *
 * The fix stores onSave in a ref and depends only on [language], reading the
 * latest onSave from the ref inside the Mod-s keymap run handler. So the
 * extensions array must NOT be rebuilt when only onSave changes, yet the keymap
 * must still call the *latest* onSave.
 *
 * This renders FileEditor (with CodeMirror mocked to capture the `extensions`
 * prop) and re-renders it with a fresh onSave arrow each time. Before the fix
 * the captured extensions reference changed on every render; after the fix it
 * is stable. It also drives the captured Mod-s keymap and asserts it invokes
 * the most recent onSave.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, act } from "@testing-library/react";

// Capture the `extensions` prop CodeMirror receives on each render.
const captured: { extensions?: unknown }[] = [];
vi.mock("@uiw/react-codemirror", () => ({
  default: (props: { extensions?: unknown }) => {
    captured.push({ extensions: props.extensions });
    return null;
  },
}));
// Preview renderers are unused for plain-text language but keep imports clean.
vi.mock("@/components/FileExplorer/MarkdownRenderer", () => ({
  MarkdownRenderer: () => null,
}));
vi.mock("@/components/FileExplorer/HtmlRenderer", () => ({
  HtmlRenderer: () => null,
}));

import { FileEditor } from "@/components/FileExplorer/FileEditor";

function lastExtensions(): unknown {
  return captured[captured.length - 1]?.extensions;
}

// Walk the captured extensions and pull the run() handler bound to "Mod-s"
// (the keymap.of([...]) facet nests the binding a couple levels deep).
function findModSRun(
  node: unknown,
  seen = new Set<unknown>()
): (() => boolean) | null {
  if (node == null || typeof node !== "object") return null;
  if (seen.has(node)) return null;
  seen.add(node);
  const obj = node as Record<string, unknown>;
  if (obj.key === "Mod-s" && typeof obj.run === "function") {
    return obj.run as () => boolean;
  }
  for (const value of Object.values(obj)) {
    const found = findModSRun(value, seen);
    if (found) return found;
  }
  return null;
}

describe("FileEditor — B023 stable extensions across parent renders", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("does not rebuild extensions when only onSave identity changes", () => {
    let container: ReturnType<typeof render>;
    act(() => {
      container = render(
        React.createElement(FileEditor, {
          content: "hello",
          language: "javascript",
          isBinary: false,
          onChange: () => {},
          // fresh arrow every render, like FileExplorerDrawer
          onSave: () => {},
        })
      );
    });

    const first = lastExtensions();
    expect(first).toBeTruthy();

    // Re-render twice with a brand-new onSave arrow each time.
    act(() => {
      container!.rerender(
        React.createElement(FileEditor, {
          content: "hello",
          language: "javascript",
          isBinary: false,
          onChange: () => {},
          onSave: () => {},
        })
      );
    });
    const second = lastExtensions();

    act(() => {
      container!.rerender(
        React.createElement(FileEditor, {
          content: "hello",
          language: "javascript",
          isBinary: false,
          onChange: () => {},
          onSave: () => {},
        })
      );
    });
    const third = lastExtensions();

    // Same array reference => the effect did not re-run / keymap not recreated.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("Mod-s keymap invokes the latest onSave after a re-render", () => {
    const firstSave = vi.fn();
    let container: ReturnType<typeof render>;
    act(() => {
      container = render(
        React.createElement(FileEditor, {
          content: "x",
          language: "json",
          isBinary: false,
          onChange: () => {},
          onSave: firstSave,
        })
      );
    });

    // Extract the Mod-s run() handler from the (stable) captured extensions.
    const exts0 = lastExtensions();
    const run = findModSRun(exts0);
    expect(run).toBeTruthy();

    expect(run!()).toBe(true);
    expect(firstSave).toHaveBeenCalledTimes(1);

    // Swap in a new onSave; the SAME extensions array (proven stable above)
    // must now route to the latest onSave via the ref.
    const secondSave = vi.fn();
    act(() => {
      container!.rerender(
        React.createElement(FileEditor, {
          content: "x",
          language: "json",
          isBinary: false,
          onChange: () => {},
          onSave: secondSave,
        })
      );
    });

    // The run handler is the same closure (extensions unchanged) but reads the
    // latest onSave from the ref.
    expect(lastExtensions()).toBe(exts0);
    expect(run!()).toBe(true);
    expect(secondSave).toHaveBeenCalledTimes(1);
    expect(firstSave).toHaveBeenCalledTimes(1);
  });
});
