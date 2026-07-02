// @vitest-environment jsdom
/**
 * #33 round-2 regression (SnippetsModal): Undo must re-sync the modal's list
 * through getVisibleSnippets — NOT a raw storage read. Storage isn't written
 * until an undo window elapses, so with TWO deletes pending, undoing one via
 * a raw read would resurrect the OTHER (still-pending) delete in the modal
 * while the chip bar correctly keeps hiding it — the surfaces the feature
 * promises agree would visibly disagree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { SnippetsModal } from "@/components/Terminal/SnippetsModal";
import { SNIPPETS_STORAGE_KEY, type Snippet } from "@/lib/snippets";

// Capture toast calls so the test can press each delete's Undo action —
// no <Toaster/> is mounted in jsdom.
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: toastMock }));

const A: Snippet = { id: "undo-a", name: "Alpha", content: "echo a" };
const B: Snippet = { id: "undo-b", name: "Bravo", content: "echo b" };

describe("SnippetsModal undo re-sync (#33)", () => {
  beforeEach(() => {
    vi.useFakeTimers(); // keep every undo window pending
    toastMock.mockClear();
    window.localStorage.setItem(SNIPPETS_STORAGE_KEY, JSON.stringify([A, B]));
  });

  afterEach(() => {
    cleanup();
    // Let pending deletes fire and drain so the module-scoped runner carries
    // no state into other tests, then restore real timers.
    vi.runAllTimers();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("undoing one delete does not resurrect another still-pending delete", () => {
    const { getAllByRole, queryByText, getByText } = render(
      <SnippetsModal open onClose={() => {}} onInsert={() => {}} />
    );

    // Delete BOTH (each row's trailing button is its delete).
    const deleteButtons = () =>
      getAllByRole("button").filter((b) =>
        b.querySelector("svg.lucide-trash-2")
      );
    fireEvent.click(deleteButtons()[0]); // deletes Alpha
    fireEvent.click(deleteButtons()[0]); // deletes Bravo (now first)
    expect(queryByText("Alpha")).toBeNull();
    expect(queryByText("Bravo")).toBeNull();

    // Undo ALPHA only — Bravo's delete is still inside its undo window.
    const alphaToast = toastMock.mock.calls.find(
      (c) => c[0] === 'Deleted "Alpha"'
    );
    expect(alphaToast).toBeDefined();
    // The toast action runs outside React's event system — flush via act.
    act(() => {
      alphaToast![1].action.onClick();
    });

    // Alpha is back; Bravo must STAY hidden (raw-storage re-sync would
    // resurrect it here — the regression this test locks out).
    expect(getByText("Alpha")).toBeTruthy();
    expect(queryByText("Bravo")).toBeNull();
  });
});
