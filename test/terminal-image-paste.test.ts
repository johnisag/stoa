/**
 * Locks the pure helper behind the terminal's image-paste path
 * (terminal-image-paste.ts): pull image File(s) off a clipboard items list. The
 * detector must IGNORE plain text / non-image files so a text paste falls
 * through to xterm's normal (bracketed) paste handling. (Path formatting is
 * shared via lib/path-display's formatPathsForAgent, tested there.)
 */
import { describe, it, expect } from "vitest";
import {
  imageFilesFromClipboard,
  type ClipboardImageItem,
} from "@/components/Terminal/hooks/terminal-image-paste";

function item(
  kind: string,
  type: string,
  file: File | null
): ClipboardImageItem {
  return { kind, type, getAsFile: () => file };
}

const png = new File([new Uint8Array([1, 2, 3])], "shot.png", {
  type: "image/png",
});
const jpg = new File([new Uint8Array([4, 5, 6])], "shot.jpg", {
  type: "image/jpeg",
});

describe("imageFilesFromClipboard", () => {
  it("returns the image file when the clipboard holds an image", () => {
    const files = imageFilesFromClipboard([item("file", "image/png", png)]);
    expect(files).toEqual([png]);
  });

  it("returns every image when multiple are pasted", () => {
    const files = imageFilesFromClipboard([
      item("file", "image/png", png),
      item("file", "image/jpeg", jpg),
    ]);
    expect(files).toEqual([png, jpg]);
  });

  it("ignores plain-text clipboard items (text paste stays unchanged)", () => {
    expect(
      imageFilesFromClipboard([item("string", "text/plain", null)])
    ).toEqual([]);
  });

  it("ignores non-image files so they don't hijack the paste", () => {
    const pdf = new File([new Uint8Array([0])], "doc.pdf", {
      type: "application/pdf",
    });
    expect(
      imageFilesFromClipboard([item("file", "application/pdf", pdf)])
    ).toEqual([]);
  });

  it("skips an image item whose getAsFile() yields null", () => {
    expect(imageFilesFromClipboard([item("file", "image/png", null)])).toEqual(
      []
    );
  });

  it("returns [] for null/undefined items (no clipboardData)", () => {
    expect(imageFilesFromClipboard(null)).toEqual([]);
    expect(imageFilesFromClipboard(undefined)).toEqual([]);
  });
});
