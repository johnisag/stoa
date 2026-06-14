import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import {
  parseJsonBody,
  validateUploadMimeType,
  UPLOAD_TEMP_MAX_BYTES,
} from "@/lib/api-security";

export async function POST(request: Request) {
  const parsed = await parseJsonBody<{
    filename?: string;
    base64?: string;
    mimeType?: string;
  }>(request);
  if (!parsed.ok) return parsed.response;

  const { filename, base64, mimeType } = parsed.data;

  if (!base64 || typeof base64 !== "string") {
    return NextResponse.json({ error: "No image data" }, { status: 400 });
  }

  const mimeCheck = validateUploadMimeType(mimeType);
  if (!mimeCheck.ok) {
    return NextResponse.json({ error: mimeCheck.reason }, { status: 400 });
  }

  // Decode base64 and bound the decoded size before writing.
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > UPLOAD_TEMP_MAX_BYTES) {
    return NextResponse.json(
      {
        error: `Upload exceeds maximum size of ${UPLOAD_TEMP_MAX_BYTES} bytes`,
      },
      { status: 413 }
    );
  }

  try {
    // Create temp directory for screenshots if it doesn't exist
    const tempDir = path.join(os.tmpdir(), "stoa-screenshots");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Generate unique filename using the allowlisted extension.
    const ext = mimeCheck.ext;
    const safeName =
      typeof filename === "string" && filename
        ? filename.replace(/[^a-zA-Z0-9.-]/g, "_")
        : "screenshot";
    const uniqueName = `${Date.now()}-${safeName}`;
    const finalName = uniqueName.endsWith(`.${ext}`)
      ? uniqueName
      : `${uniqueName}.${ext}`;
    const filePath = path.join(tempDir, finalName);

    fs.writeFileSync(filePath, buffer);

    return NextResponse.json({ path: filePath });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Failed to save image" },
      { status: 500 }
    );
  }
}
