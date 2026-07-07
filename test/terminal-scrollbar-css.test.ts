import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

describe("terminal scrollbar CSS", () => {
  it("keeps the xterm v6 vertical scrollbar visible on desktop", () => {
    expect(css).toContain("@media (pointer: fine), (min-width: 768px)");
    expect(css).toContain("@media (pointer: coarse) and (max-width: 767.98px)");
    expect(css).not.toContain("@media (pointer: coarse) {");
    expect(css).toContain(
      ".xterm .xterm-scrollable-element > .scrollbar.vertical"
    );
    expect(css).toContain("visibility: visible !important;");
    expect(css).toContain("opacity: 1 !important;");
    expect(css).toContain("pointer-events: auto !important;");
    expect(css).toContain(
      ".xterm .xterm-scrollable-element > .scrollbar.vertical > .slider"
    );
  });
});
