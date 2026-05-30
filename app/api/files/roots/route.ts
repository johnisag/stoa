import { NextResponse } from "next/server";
import { existsSync } from "fs";
import path from "path";
import { isWindows } from "@/lib/platform";

/**
 * GET /api/files/roots
 *
 * Returns the filesystem roots and the OS path separator so the client picker
 * can navigate without hardcoding "/". On Windows the roots are the available
 * drive letters (e.g. ["C:\\", "D:\\"]); on POSIX it is a single ["/"].
 */
export async function GET() {
  const separator = path.sep;

  if (!isWindows) {
    return NextResponse.json({ roots: ["/"], separator });
  }

  // Probe A: through Z: and keep the drives that actually exist.
  const roots: string[] = [];
  for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (existsSync(drive)) {
      roots.push(drive);
    }
  }

  // Fall back to the system drive if probing somehow found nothing.
  if (roots.length === 0) {
    roots.push((process.env.SystemDrive || "C:") + "\\");
  }

  return NextResponse.json({ roots, separator });
}
