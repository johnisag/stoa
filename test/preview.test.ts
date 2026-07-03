import { describe, it, expect } from "vitest";
import { previewUrlFromPorts, DEVICE_PRESETS } from "@/lib/preview";

describe("previewUrlFromPorts (#28 URL derivation)", () => {
  it("builds a localhost URL from the first valid port", () => {
    expect(previewUrlFromPorts([3000])).toBe("http://localhost:3000");
    expect(previewUrlFromPorts([null, undefined, 5173])).toBe(
      "http://localhost:5173"
    );
  });

  it("returns null when no valid port is configured", () => {
    expect(previewUrlFromPorts([])).toBeNull();
    expect(previewUrlFromPorts([null, undefined])).toBeNull();
    expect(previewUrlFromPorts([0, -1, 70000, 1.5])).toBeNull();
  });
});

describe("DEVICE_PRESETS (#28 device selector)", () => {
  it("has phone/tablet/desktop widths plus a full (null-width) option", () => {
    const ids = DEVICE_PRESETS.map((d) => d.id);
    expect(ids).toEqual(["phone", "tablet", "desktop", "full"]);
    const phone = DEVICE_PRESETS.find((d) => d.id === "phone")!;
    const full = DEVICE_PRESETS.find((d) => d.id === "full")!;
    expect(phone.width).toBe(390);
    expect(full.width).toBeNull();
  });
});
