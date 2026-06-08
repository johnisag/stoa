import { describe, it, expect } from "vitest";
import { taskkillArgs } from "@/lib/dev-servers";

describe("dev server process ownership", () => {
  it("builds a Windows process-tree kill command", () => {
    expect(taskkillArgs(1234)).toEqual(["/PID", "1234", "/T", "/F"]);
  });
});
