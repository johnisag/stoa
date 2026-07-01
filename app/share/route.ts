import { NextRequest, NextResponse } from "next/server";
import { buildSharePrompt, shareRedirectPath } from "@/lib/share-intake";

/**
 * Web Share Target endpoint (#17). The OS share sheet POSTs
 * application/x-www-form-urlencoded title/text/url here (per manifest.json
 * share_target); iOS/other fallbacks may arrive as a GET with the same fields as
 * query params. Either way: compose a prompt and 303-redirect into the app shell
 * (`/?action=new-session&prompt=…`), where the mount reader opens the New Session
 * dialog pre-seeded. Stateless by design — nothing is stored here, so an
 * unauthenticated share can't write anything; the redirect target is the normal
 * app page behind the normal auth.
 */

function redirectIntoApp(payload: {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}): NextResponse {
  const prompt = buildSharePrompt(payload);
  // 303: turn the share-sheet POST into a GET navigation of the app shell. The
  // Location is RELATIVE (RFC 7231 allows it) — never derived from request.url,
  // so a spoofed Host header can't steer the redirect anywhere, and it keeps
  // working on every host Stoa serves from (localhost, LAN IP, Tailscale).
  return new NextResponse(null, {
    status: 303,
    headers: { Location: shareRedirectPath(prompt) },
  });
}

export async function POST(request: NextRequest) {
  let payload: { title?: string; text?: string; url?: string } = {};
  try {
    const form = await request.formData();
    payload = {
      title: form.get("title")?.toString(),
      text: form.get("text")?.toString(),
      url: form.get("url")?.toString(),
    };
  } catch {
    // Malformed/absent body — fall through to a plain app open.
  }
  return redirectIntoApp(payload);
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  return redirectIntoApp({
    title: q.get("title"),
    text: q.get("text"),
    url: q.get("url"),
  });
}
