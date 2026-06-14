// @vitest-environment jsdom
/**
 * Regression for B019: the keyboard-selection index in <CodeSearchResults> must
 * reset when the query changes. The bug: `selectedIndex` persisted across query
 * changes, so after navigating down a long result set and then typing a new
 * query that yields a SHORTER set, the stale index pointed past the new list —
 * no row was highlighted and Enter targeted nothing/the wrong row.
 *
 * The fix adds `useEffect(() => setSelectedIndex(0), [query])`. This test drives
 * ArrowDown to move off row 0 on a 3-result set, then rerenders with a new query
 * whose result set has a single row, and asserts that one row is selected (so
 * the index reset to 0). Before the fix the only row would be unselected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import type { FormattedMatch } from "@/lib/code-search";

// Controllable stand-in for the react-query hook so we can swap the result set.
const useCodeSearchMock = vi.fn();
vi.mock("@/data/code-search", () => ({
  useCodeSearch: (...args: unknown[]) => useCodeSearchMock(...args),
}));

// The real component pulls in react-syntax-highlighter (heavy ESM grammar
// chunks). Stub it (and its style/grammar imports) to a trivial passthrough so
// the render stays light and deterministic.
vi.mock("react-syntax-highlighter", () => ({
  PrismLight: Object.assign(
    ({ children }: { children: ReactNode }) =>
      createElement("span", null, children),
    { registerLanguage: vi.fn() }
  ),
}));
vi.mock("react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus", () => ({
  default: {},
}));
// One explicit vi.mock per grammar chunk. vi.mock is hoisted to the top of the
// module, so it cannot be driven by a runtime `for` loop (the loop variable
// wouldn't exist yet) — list them out instead.
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/typescript", () => ({
  default: {},
}));
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/javascript", () => ({
  default: {},
}));
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/json", () => ({
  default: {},
}));
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/markdown", () => ({
  default: {},
}));
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/css", () => ({
  default: {},
}));
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/markup", () => ({
  default: {},
}));
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/python", () => ({
  default: {},
}));
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/ruby", () => ({
  default: {},
}));
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/go", () => ({
  default: {},
}));
vi.mock("react-syntax-highlighter/dist/esm/languages/prism/rust", () => ({
  default: {},
}));

import { CodeSearchResults } from "@/components/CodeSearch/CodeSearchResults";

afterEach(cleanup);

function match(file: string, line: number): FormattedMatch {
  return { file, line, column: 0, matchText: "x", lineText: `line ${line}` };
}

function mockResults(results: FormattedMatch[]) {
  useCodeSearchMock.mockReturnValue({
    data: { results },
    isLoading: false,
    isError: false,
    error: null,
  });
}

describe("CodeSearchResults — B019 selection resets when query changes", () => {
  beforeEach(() => useCodeSearchMock.mockReset());

  it("resets the highlighted row to 0 after the query changes to a shorter set", () => {
    mockResults([match("a.ts", 1), match("b.ts", 2), match("c.ts", 3)]);

    const { container, rerender } = render(
      createElement(CodeSearchResults, {
        workingDirectory: "/repo",
        query: "alpha",
        onSelectFile: vi.fn(),
      })
    );

    // Move the highlight off row 0 (down twice → index 2).
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    let selected = container.querySelectorAll("button.bg-accent");
    expect(selected.length).toBe(1);
    // Index 2 of the 3-row set is highlighted (the third file).
    expect(selected[0].textContent).toContain("c.ts");

    // New, shorter query: a single result. Stale index 2 would point past it.
    mockResults([match("z.ts", 9)]);
    rerender(
      createElement(CodeSearchResults, {
        workingDirectory: "/repo",
        query: "zeta",
        onSelectFile: vi.fn(),
      })
    );

    selected = container.querySelectorAll("button.bg-accent");
    // After the fix the index reset to 0 → the only row is selected.
    expect(selected.length).toBe(1);
    expect(selected[0].textContent).toContain("z.ts");
  });

  it("Enter targets the first row of the new query after a reset", () => {
    mockResults([match("a.ts", 1), match("b.ts", 2), match("c.ts", 3)]);
    const onSelectFile = vi.fn();

    const { rerender } = render(
      createElement(CodeSearchResults, {
        workingDirectory: "/repo",
        query: "alpha",
        onSelectFile,
      })
    );

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });

    mockResults([match("z.ts", 9)]);
    rerender(
      createElement(CodeSearchResults, {
        workingDirectory: "/repo",
        query: "zeta",
        onSelectFile,
      })
    );

    fireEvent.keyDown(window, { key: "Enter" });
    // Without the reset, selectedIndex (2) would miss the single-row set and
    // Enter would target nothing. After the fix it targets the first row.
    expect(onSelectFile).toHaveBeenLastCalledWith("z.ts", 9);
  });
});
