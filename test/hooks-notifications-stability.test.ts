// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNotifications } from "@/hooks/useNotifications";

// Provide the minimal browser APIs the hook touches on first render.
beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn() },
  });
});

describe("useNotifications", () => {
  it("keeps checkStateChanges stable across settings and callback changes", () => {
    const onSessionClick1 = vi.fn();
    const onSeeChanges1 = vi.fn();

    const { result, rerender } = renderHook(
      ({
        onSessionClick,
        onSeeChanges,
      }: {
        onSessionClick: (id: string) => void;
        onSeeChanges: (id: string) => void;
      }) => useNotifications({ onSessionClick, onSeeChanges }),
      {
        initialProps: {
          onSessionClick: onSessionClick1,
          onSeeChanges: onSeeChanges1,
        },
      }
    );

    const firstCheck = result.current.checkStateChanges;

    rerender({
      onSessionClick: vi.fn(),
      onSeeChanges: vi.fn(),
    });

    expect(result.current.checkStateChanges).toBe(firstCheck);
  });
});
