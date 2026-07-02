import { describe, it, expect } from "vitest";
import {
  canInjectPicker,
  parsePickerMessage,
  buildPickerScript,
  previewUrlFromPorts,
  PICKER_MESSAGE_TYPE,
  DEVICE_PRESETS,
} from "@/lib/preview-picker";

describe("canInjectPicker (#28 cross-origin gate)", () => {
  it("allows a same-origin preview", () => {
    expect(
      canInjectPicker("http://localhost:3011/proxy", "http://localhost:3011")
    ).toBe(true);
    // Different path, same origin — still allowed.
    expect(
      canInjectPicker("http://localhost:3011/", "http://localhost:3011")
    ).toBe(true);
  });

  it("rejects a different-port (cross-origin) preview", () => {
    expect(
      canInjectPicker("http://localhost:3000/", "http://localhost:3011")
    ).toBe(false);
  });

  it("rejects a different-host or different-scheme preview", () => {
    expect(
      canInjectPicker("http://127.0.0.1:3011/", "http://localhost:3011")
    ).toBe(false);
    expect(
      canInjectPicker("https://localhost:3011/", "http://localhost:3011")
    ).toBe(false);
  });

  it("fails closed (false) on a malformed url", () => {
    expect(canInjectPicker("not a url", "http://localhost:3011")).toBe(false);
    expect(canInjectPicker("http://localhost:3011", "also bad")).toBe(false);
  });
});

describe("parsePickerMessage (#28 postMessage envelope)", () => {
  it("accepts a well-formed envelope and copies only known string fields", () => {
    const msg = parsePickerMessage({
      type: PICKER_MESSAGE_TYPE,
      locator: {
        tag: "button",
        id: "go",
        testId: "submit",
        text: "Click",
        domPath: "main > button",
        url: "http://x/",
        evil: "<script>", // extra field ignored
      },
    });
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe(PICKER_MESSAGE_TYPE);
    expect(msg!.locator.tag).toBe("button");
    expect(msg!.locator.testId).toBe("submit");
    expect((msg!.locator as Record<string, unknown>).evil).toBeUndefined();
  });

  it("drops non-string locator fields to undefined", () => {
    const msg = parsePickerMessage({
      type: PICKER_MESSAGE_TYPE,
      locator: { tag: "a", id: 42, text: { nested: true } },
    });
    expect(msg!.locator.tag).toBe("a");
    expect(msg!.locator.id).toBeUndefined();
    expect(msg!.locator.text).toBeUndefined();
  });

  it("rejects a foreign / malformed envelope", () => {
    expect(parsePickerMessage(null)).toBeNull();
    expect(parsePickerMessage("hello")).toBeNull();
    expect(parsePickerMessage({ type: "other", locator: {} })).toBeNull();
    expect(parsePickerMessage({ type: PICKER_MESSAGE_TYPE })).toBeNull();
    expect(
      parsePickerMessage({ type: PICKER_MESSAGE_TYPE, locator: "x" })
    ).toBeNull();
  });
});

describe("buildPickerScript (#28 injected picker)", () => {
  it("bakes the target origin and message type as safe JSON literals", () => {
    const src = buildPickerScript("http://localhost:3011");
    expect(src).toContain('var TARGET = "http://localhost:3011"');
    expect(src).toContain(`var TYPE = ${JSON.stringify(PICKER_MESSAGE_TYPE)}`);
    // posts back to the parent with the explicit target origin (not "*").
    expect(src).toContain("window.parent.postMessage");
    expect(src).toContain("TARGET");
    expect(src).not.toContain('postMessage(loc, "*")');
  });

  it("escapes a hostile origin so it cannot break out of the string literal", () => {
    const src = buildPickerScript('http://x"/</script>');
    // JSON.stringify escapes the quote; no raw `"http://x"` break-out.
    expect(src).toContain(JSON.stringify('http://x"/</script>'));
  });

  it("is a self-invoking IIFE (runs on injection)", () => {
    const src = buildPickerScript("http://localhost:3011");
    expect(src.trimStart().startsWith("(function ()")).toBe(true);
    expect(src.trimEnd().endsWith("})();")).toBe(true);
  });
});

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
