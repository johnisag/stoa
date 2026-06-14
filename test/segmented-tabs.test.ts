// @vitest-environment jsdom
/**
 * Unit coverage for the shared <SegmentedTabs> primitive: it renders one button
 * per tab, fires onChange with the clicked key, marks the active tab via
 * aria-selected (the tablist a11y baseline), renders both badge forms, and
 * implements roving tabindex + arrow/Home/End keyboard navigation.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";

afterEach(cleanup);

type Key = "a" | "b" | "c";

const TABS = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta", badge: { count: 3 } },
  { key: "c", label: "Gamma", badge: { count: 0 } },
] as const;

function renderTabs(value: Key, onChange = vi.fn()) {
  render(
    createElement(SegmentedTabs<Key>, {
      ariaLabel: "Example",
      value,
      onChange,
      tabs: TABS,
    })
  );
  return onChange;
}

describe("SegmentedTabs", () => {
  it("renders a tablist with one tab button per entry", () => {
    renderTabs("a");
    expect(screen.getByRole("tablist", { name: "Example" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Alpha", "Beta3", "Gamma"]);
  });

  it("marks only the active tab aria-selected", () => {
    renderTabs("b");
    expect(
      screen.getByRole("tab", { name: /Alpha/ }).getAttribute("aria-selected")
    ).toBe("false");
    expect(
      screen.getByRole("tab", { name: /Beta/ }).getAttribute("aria-selected")
    ).toBe("true");
  });

  it("fires onChange with the clicked tab key (even the active one)", () => {
    const onChange = renderTabs("a");
    fireEvent.click(screen.getByRole("tab", { name: /Beta/ }));
    expect(onChange).toHaveBeenCalledWith("b");
    // A click on the already-active tab still fires — callers guard if needed.
    fireEvent.click(screen.getByRole("tab", { name: /Alpha/ }));
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("renders a {count} badge only when count > 0", () => {
    renderTabs("a");
    // Beta has count 3 → pill shows "3"; Gamma has count 0 → no pill.
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("applies a custom badge className to the count pill", () => {
    render(
      createElement(SegmentedTabs<Key>, {
        ariaLabel: "Coded",
        value: "a",
        onChange: vi.fn(),
        tabs: [
          { key: "a", label: "Alpha" },
          {
            key: "b",
            label: "Beta",
            badge: { count: 2, className: "bg-red-500/20 text-red-400" },
          },
        ],
      })
    );
    const pill = screen.getByText("2");
    expect(pill.className).toContain("bg-red-500/20");
    expect(pill.className).toContain("text-red-400");
    // The shared pill shape is always present.
    expect(pill.className).toContain("rounded-full");
  });

  it("renders a ReactNode badge as-is", () => {
    render(
      createElement(SegmentedTabs<Key>, {
        ariaLabel: "Node badge",
        value: "a",
        onChange: vi.fn(),
        tabs: [
          {
            key: "a",
            label: "Alpha",
            badge: createElement("span", { "data-testid": "custom" }, "NEW"),
          },
        ],
      })
    );
    expect(screen.getByTestId("custom").textContent).toBe("NEW");
  });

  it("disables every tab button when disabled", () => {
    render(
      createElement(SegmentedTabs<Key>, {
        ariaLabel: "Disabled",
        value: "a",
        onChange: vi.fn(),
        disabled: true,
        tabs: [
          { key: "a", label: "Alpha" },
          { key: "b", label: "Beta" },
        ],
      })
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect((tab as HTMLButtonElement).disabled).toBe(true);
    }
  });

  describe("keyboard navigation", () => {
    it("uses roving tabindex (active tab is tabbable)", () => {
      renderTabs("b");
      const tabs = screen.getAllByRole("tab");
      expect(tabs[0].tabIndex).toBe(-1);
      expect(tabs[1].tabIndex).toBe(0);
      expect(tabs[2].tabIndex).toBe(-1);
    });

    it("ArrowRight moves focus/value to the next tab", () => {
      const onChange = renderTabs("a");
      const list = screen.getByRole("tablist");
      fireEvent.keyDown(list, { key: "ArrowRight" });
      expect(onChange).toHaveBeenCalledWith("b");
    });

    it("ArrowRight wraps from the last tab to the first", () => {
      const onChange = renderTabs("c");
      const list = screen.getByRole("tablist");
      fireEvent.keyDown(list, { key: "ArrowRight" });
      expect(onChange).toHaveBeenCalledWith("a");
    });

    it("ArrowLeft moves focus/value to the previous tab", () => {
      const onChange = renderTabs("b");
      const list = screen.getByRole("tablist");
      fireEvent.keyDown(list, { key: "ArrowLeft" });
      expect(onChange).toHaveBeenCalledWith("a");
    });

    it("ArrowLeft wraps from the first tab to the last", () => {
      const onChange = renderTabs("a");
      const list = screen.getByRole("tablist");
      fireEvent.keyDown(list, { key: "ArrowLeft" });
      expect(onChange).toHaveBeenCalledWith("c");
    });

    it("Home jumps to the first tab", () => {
      const onChange = renderTabs("c");
      const list = screen.getByRole("tablist");
      fireEvent.keyDown(list, { key: "Home" });
      expect(onChange).toHaveBeenCalledWith("a");
    });

    it("End jumps to the last tab", () => {
      const onChange = renderTabs("a");
      const list = screen.getByRole("tablist");
      fireEvent.keyDown(list, { key: "End" });
      expect(onChange).toHaveBeenCalledWith("c");
    });

    it("does not navigate when disabled", () => {
      const onChange = vi.fn();
      render(
        createElement(SegmentedTabs<Key>, {
          ariaLabel: "Disabled",
          value: "a",
          onChange,
          disabled: true,
          tabs: TABS,
        })
      );
      const list = screen.getByRole("tablist");
      fireEvent.keyDown(list, { key: "ArrowRight" });
      expect(onChange).not.toHaveBeenCalled();
    });

    it("links a tab to its panel via aria-controls when provided", () => {
      render(
        createElement(SegmentedTabs<Key>, {
          ariaLabel: "Panels",
          value: "a",
          onChange: vi.fn(),
          tabs: [
            { key: "a", label: "Alpha", panelId: "panel-a" },
            { key: "b", label: "Beta", panelId: "panel-b" },
          ],
        })
      );
      expect(
        screen.getByRole("tab", { name: /Alpha/ }).getAttribute("aria-controls")
      ).toBe("panel-a");
      expect(
        screen.getByRole("tab", { name: /Beta/ }).getAttribute("aria-controls")
      ).toBe("panel-b");
    });
  });
});
