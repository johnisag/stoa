import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { lookup } from "dns/promises";
import { tmpDir } from "@/lib/platform";
import { isHttpUrl, htmlToText, isPrivateAddress } from "@/lib/web-fetch";
import { formatTerminalTextForAgent } from "@/lib/path-display";

// Bounds so a fetched page can't hang the request or blow up memory: abort the
// fetch after TIMEOUT_MS and stop reading once we've pulled MAX_BYTES.
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/**
 * SSRF host guard: reject when the URL's host resolves to ANY loopback /
 * private / link-local / metadata address. Throws on an unsafe or unresolvable
 * host. (Server-side fetch can reach things the phone driving the UI can't —
 * localhost, the LAN, 169.254.169.254 — so this is enforced, not waved through.)
 */
async function assertPublicHost(u: URL): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("Could not resolve the URL's host");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error("That host isn't allowed (private/loopback address)");
  }
}

/**
 * Fetch, following redirects MANUALLY and re-validating the host at every hop —
 * so an allowed public URL can't 302 to a private one (the SSRF bypass that
 * `redirect: "follow"` would permit). Returns the final response.
 */
async function safeFetch(
  start: string,
  signal: AbortSignal
): Promise<Response> {
  let url = start;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!isHttpUrl(url)) throw new Error("Only http(s) URLs are allowed");
    await assertPublicHost(new URL(url));
    const res = await fetch(url, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": "Stoa-WebFetch/1.0" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("Redirect without a location");
      url = new URL(loc, url).toString(); // resolve a relative redirect
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}
const MAX_BYTES = 5 * 1024 * 1024; // 5MB of raw HTML — plenty for an issue/doc.

/** Build a readable temp-file name from the URL's host + path (display only). */
function tempNameForUrl(url: string): string {
  let stem = "page";
  try {
    const u = new URL(url);
    const raw = `${u.hostname}${u.pathname}`.replace(/\/+$/, "");
    stem = raw.replace(/[^a-zA-Z0-9.-]/g, "_").replace(/_+/g, "_") || "page";
  } catch {
    // isHttpUrl already vetted the URL; keep the fallback for safety.
  }
  return `${Date.now()}-${stem.slice(0, 80)}.txt`;
}

/**
 * Read a fetch Response body up to MAX_BYTES, then stop. Returns the decoded
 * text. Caps memory regardless of Content-Length (which a server can lie about
 * or omit) by counting bytes as they stream in.
 */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No stream (shouldn't happen on Node's fetch) — fall back to text() but
    // still bound it afterward.
    const text = await res.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString("utf-8").slice(0, MAX_BYTES);
}

// POST /api/web-fetch - Fetch a web page, reduce it to readable text, strip
// control chars, write it to a temp file, and return { path }. The FilePicker
// injects that path into the agent's prompt exactly like an uploaded file.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { url } = body as { url?: string };

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }
    // Scheme guard: only plain http/https web addresses (reject file:, data:,
    // javascript:, ftp:, ...).
    if (!isHttpUrl(url)) {
      return NextResponse.json(
        { error: "Only http(s) URLs are allowed" },
        { status: 400 }
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    let raw: string;
    try {
      res = await safeFetch(url, controller.signal);
      if (!res.ok) {
        return NextResponse.json(
          { error: `Fetch failed with status ${res.status}` },
          { status: 502 }
        );
      }
      raw = await readCapped(res);
    } catch (err) {
      const aborted =
        err instanceof Error &&
        (err.name === "AbortError" || controller.signal.aborted);
      // Surface the specific reason (timeout / blocked host / unresolvable /
      // redirect) so the user can tell a typo from a slow network.
      const message = aborted
        ? "Fetch timed out"
        : err instanceof Error
          ? err.message
          : "Could not fetch the URL";
      return NextResponse.json({ error: message }, { status: 502 });
    } finally {
      clearTimeout(timer);
    }

    // Reduce HTML to readable text. Trust the content-type; only sniff when it's
    // ABSENT (and then only on a document-level signal), so a raw .md/.txt that
    // merely contains a tag-like token (e.g. `vec<i32>`) rides through unmangled.
    const contentType = res.headers.get("content-type") || "";
    const looksHtml = contentType
      ? contentType.includes("text/html")
      : /^\s*(<!doctype html|<html[\s>])/i.test(raw);
    const reduced = looksHtml ? htmlToText(raw) : raw;

    // Strip C0 controls + DEL before this text can reach the agent's pty
    // (keystroke-injection guard); keeps tab/newline so the layout survives.
    const text = formatTerminalTextForAgent(reduced);
    if (!text) {
      return NextResponse.json(
        { error: "No readable text found at that URL" },
        { status: 422 }
      );
    }

    // Write to a temp file and return its path — the FilePicker injects the
    // path like any attached file. Header records the source URL for the agent.
    const tempDir = path.join(tmpDir(), "stoa-web-fetch");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const filePath = path.join(tempDir, tempNameForUrl(url));
    const header = formatTerminalTextForAgent(`Source: ${url}`);
    fs.writeFileSync(filePath, `${header}\n\n${text}\n`, "utf-8");

    return NextResponse.json({ path: filePath });
  } catch (error) {
    console.error("web-fetch error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
