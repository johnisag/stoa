/**
 * Bounded, same-handle reads for Fleet-owned artifact files.
 *
 * Agent-authored files are untrusted input. Callers must not use readFile()
 * directly: a FIFO can block the reconciler, a symlink can escape the owned
 * attempt directory, and an unbounded file can exhaust memory. This helper
 * rejects those cases before returning bytes.
 */
import { constants } from "fs";
import { lstat, open } from "fs/promises";

export type FleetArtifactReadResult =
  | { ok: true; text: string; bytes: number }
  | { ok: false; error: string; missing?: boolean };

export async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  label = "fleet artifact"
): Promise<FleetArtifactReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const noFollow =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock =
    typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let handle;
  try {
    const pathInfo = await lstat(filePath);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
      return { ok: false, error: `${label} is not a regular file` };
    }
    if (pathInfo.size > maxBytes) {
      return {
        ok: false,
        error: `${label} exceeds the ${maxBytes}-byte safety limit`,
      };
    }

    handle = await open(filePath, constants.O_RDONLY | noFollow | nonBlock);
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      (pathInfo.ino !== 0 &&
        openedInfo.ino !== 0 &&
        (pathInfo.dev !== openedInfo.dev || pathInfo.ino !== openedInfo.ino))
    ) {
      return {
        ok: false,
        error: `${label} changed before it could be read safely`,
      };
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      return {
        ok: false,
        error: `${label} exceeds the ${maxBytes}-byte safety limit`,
      };
    }

    const afterRead = await handle.stat();
    if (
      !afterRead.isFile() ||
      afterRead.size !== openedInfo.size ||
      afterRead.mtimeMs !== openedInfo.mtimeMs
    ) {
      return {
        ok: false,
        error: `${label} changed while it was being read`,
      };
    }

    return {
      ok: true,
      text: buffer.subarray(0, offset).toString("utf8"),
      bytes: offset,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: `${label} does not exist`, missing: true };
    }
    if (code === "ELOOP") {
      return { ok: false, error: `${label} is not a regular file` };
    }
    return { ok: false, error: `${label} could not be read safely` };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
