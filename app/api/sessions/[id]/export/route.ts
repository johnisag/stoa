import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session, type Message } from "@/lib/db";
import { buildExport, type ExportFormat } from "@/lib/export";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/sessions/[id]/export?format=md|json
// Streams the conversation transcript as a downloadable Markdown or JSON file.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();

    const session = queries.getSession(db).get(id) as Session | undefined;
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const formatParam = new URL(request.url).searchParams.get("format");
    const format: ExportFormat = formatParam === "json" ? "json" : "md";

    const messages = queries.getSessionMessages(db).all(id) as Message[];
    const { body, contentType, filename } = buildExport(
      session,
      messages,
      format
    );

    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        // filename is an [a-z0-9-] slug + extension (see exportFileStem), so the
        // quoted form is injection-safe; the RFC 5987 filename* is belt-and-
        // suspenders against any future relaxation of the slugifier.
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Error exporting conversation:", error);
    return NextResponse.json(
      { error: "Failed to export conversation" },
      { status: 500 }
    );
  }
}
