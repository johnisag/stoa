// @vitest-environment jsdom
/**
 * #33 round-2 regression: snippet inserts from the MOBILE toolbar must route
 * through the bracketed-paste injector (`onPaste`), NEVER char-by-char
 * `onKeyPress` — per-char sending turns every newline in a multi-line snippet
 * into an Enter keystroke, auto-executing lines the user never confirmed
 * (desktop's Pane already inserts via terminalRef.paste; this locks the mobile
 * surface to the same semantics).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { TerminalToolbar } from "@/components/Terminal/TerminalToolbar";
import { SNIPPETS_STORAGE_KEY, type Snippet } from "@/lib/snippets";

const MULTILINE: Snippet = {
  id: "s1",
  name: "Deploy",
  content: "for i in 1 2 3; do\necho $i\ndone",
};
const TEMPLATED: Snippet = {
  id: "s2",
  name: "Greet",
  content: "echo {{name}}\necho done",
};

function seedSnippets(snippets: Snippet[]) {
  window.localStorage.setItem(SNIPPETS_STORAGE_KEY, JSON.stringify(snippets));
}

describe("mobile snippet insert path (#33)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("chip tap sends a multi-line snippet as ONE paste, zero keypresses", () => {
    seedSnippets([MULTILINE]);
    const onKeyPress = vi.fn();
    const onPaste = vi.fn();
    const { getByText } = render(
      <TerminalToolbar onKeyPress={onKeyPress} onPaste={onPaste} />
    );

    fireEvent.click(getByText("Deploy"));

    expect(onPaste).toHaveBeenCalledTimes(1);
    // Newlines PRESERVED inside the single paste payload (bracketed paste is
    // what keeps them from executing) — and never sent as keystrokes.
    expect(onPaste).toHaveBeenCalledWith("for i in 1 2 3; do\necho $i\ndone");
    expect(onKeyPress).not.toHaveBeenCalled();
  });

  it("fill-in dialog insert also routes through the single paste", () => {
    seedSnippets([TEMPLATED]);
    const onKeyPress = vi.fn();
    const onPaste = vi.fn();
    const { getByText, getByPlaceholderText } = render(
      <TerminalToolbar onKeyPress={onKeyPress} onPaste={onPaste} />
    );

    fireEvent.click(getByText("Greet")); // opens the fill-in dialog
    fireEvent.change(getByPlaceholderText("Leave blank to keep {{name}}"), {
      target: { value: "world" },
    });
    fireEvent.click(getByText("Insert"));

    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledWith("echo world\necho done");
    expect(onKeyPress).not.toHaveBeenCalled();
  });

  it("SnippetsModal mount also inserts via the single paste (second surface)", () => {
    seedSnippets([MULTILINE]);
    const onKeyPress = vi.fn();
    const onPaste = vi.fn();
    const { getByLabelText, getByText } = render(
      <TerminalToolbar onKeyPress={onKeyPress} onPaste={onPaste} />
    );

    fireEvent.click(getByLabelText("Insert snippet")); // opens the modal
    // Select by the content PREVIEW — only the modal row renders the body as
    // text (the chip shows it in a title attribute), so this cannot
    // accidentally exercise the chip path.
    fireEvent.click(getByText(/for i in 1 2 3/));

    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledWith("for i in 1 2 3; do\necho $i\ndone");
    expect(onKeyPress).not.toHaveBeenCalled();
  });

  it("falls back to char-by-char sending when no onPaste is wired", () => {
    seedSnippets([{ id: "s3", name: "Status", content: "git status" }]);
    const onKeyPress = vi.fn();
    const { getByText } = render(<TerminalToolbar onKeyPress={onKeyPress} />);

    fireEvent.click(getByText("Status"));

    // Single-line content is safe on the legacy path; it must still arrive.
    expect(onKeyPress.mock.calls.map((c) => c[0]).join("")).toBe("git status");
  });
});
