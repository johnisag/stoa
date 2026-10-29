// @vitest-environment jsdom
/**
 * FileExplorer root switch (the live cwd moves the root). The clear-listing
 * effect must run BEFORE the load effect: declared after it, its requestSeq
 * bump superseded the fresh load, whose response was then discarded and whose
 * `finally` never cleared the spinner — a dead spinner with Refresh disabled
 * until the next 5s poll.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { UseFileEditorReturn } from "@/hooks/useFileEditor";
import type { FileNode } from "@/lib/file-utils";

vi.mock("@/hooks/useViewport", () => ({
  useViewport: () => ({ isMobile: false, isHydrated: true }),
}));
vi.mock("@/components/FileExplorer/FileTree", () => ({
  FileTree: ({ nodes }: { nodes: FileNode[] }) => (
    <ul>
      {nodes.map((n) => (
        <li key={n.path}>{n.path}</li>
      ))}
    </ul>
  ),
}));
vi.mock("@/components/FileExplorer/FileEditor", () => ({
  FileEditor: () => null,
}));
vi.mock("@/components/FileExplorer/FileTabs", () => ({
  FileTabs: () => null,
}));

import { FileExplorer } from "@/components/FileExplorer";

const fileEditor = {
  openFiles: [],
  activeFilePath: null,
  loading: false,
  saving: false,
  jump: null,
  openFile: vi.fn(),
  closeFile: vi.fn(),
  setActiveFile: vi.fn(),
  updateContent: vi.fn(),
  saveFile: vi.fn(),
  isDirty: () => false,
  getFile: () => undefined,
} as unknown as UseFileEditorReturn;

// One pending response per requested directory, resolved by the test.
const pending = new Map<string, () => void>();
vi.stubGlobal(
  "fetch",
  vi.fn((url: string) => {
    const dir = new URL(url, "http://stoa.local").searchParams.get("path")!;
    return new Promise((resolve) => {
      pending.set(dir, () =>
        resolve({
          ok: true,
          json: async () => ({
            files: [{ name: "f.ts", path: `${dir}/f.ts`, type: "file" }],
          }),
        })
      );
    });
  })
);

async function respond(dir: string) {
  await act(async () => {
    pending.get(dir)!();
  });
}

afterEach(() => {
  cleanup();
  pending.clear();
});

describe("FileExplorer — root switch", () => {
  it("commits the NEW root's listing and clears the spinner", async () => {
    const { rerender } = render(
      <FileExplorer workingDirectory="/A" fileEditor={fileEditor} />
    );
    await respond("/A");
    expect(screen.getByText("/A/f.ts")).toBeTruthy();

    rerender(<FileExplorer workingDirectory="/B" fileEditor={fileEditor} />);
    await respond("/B");

    expect(await screen.findByText("/B/f.ts")).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh files" });
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
  });

  it("drops the OLD root's in-flight listing when the root moves while hidden", async () => {
    const { rerender } = render(
      <FileExplorer workingDirectory="/A" fileEditor={fileEditor} />
    );
    // The root moves while the view is hidden: no load of its own runs, so
    // only the clear effect's seq bump stops /A's late response committing.
    rerender(
      <FileExplorer
        workingDirectory="/B"
        fileEditor={fileEditor}
        active={false}
      />
    );
    await respond("/A");
    expect(screen.queryByText("/A/f.ts")).toBeNull();

    rerender(<FileExplorer workingDirectory="/B" fileEditor={fileEditor} />);
    await respond("/B");
    expect(await screen.findByText("/B/f.ts")).toBeTruthy();
  });
});
