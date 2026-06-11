/**
 * Pure helper for the terminal's image-paste path (see useTerminalConnection):
 * detect image items off a DataTransfer-like list. Side-effect-free so it's
 * unit-testable without a real clipboard / xterm. (Path formatting is shared with
 * the file picker + drop paths via lib/path-display's formatPathsForAgent.)
 */

/** Minimal shape of a DataTransferItem we read (subset of the DOM type). */
export interface ClipboardImageItem {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/**
 * Extract the image File(s) from a clipboard items list. Mirrors the file
 * picker's paste handler (kind === "file"), but additionally requires an
 * image/* MIME type so a non-image file paste falls through to normal handling.
 */
export function imageFilesFromClipboard(
  items: ArrayLike<ClipboardImageItem> | null | undefined
): File[] {
  if (!items) return [];
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}
