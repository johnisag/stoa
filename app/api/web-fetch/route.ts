import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { lookup } from "dns/promises";
import { Agent } from "undici";
import { tmpDir } from "@/lib/platform";
import { isHttpUrl, htmlToText, isPrivateAddress } from "@/lib/web-fetch";
import { formatTerminalTextForAgent } from "@/lib/path-display";
import {
  parseJsonBody,
  checkRateLimit,
  clampInteger,
} from "@/lib/api-security";

// Bounds so a fetched page can't hang the request or blow up memory: abort the
// fetch after TIMEOUT_MS and stop reading once we've pulled MAX_BYTES. clampInteger
// guards a non-numeric/garbage env value (a bare parseInt → NaN would make the
// AbortController fire at 0ms and time out every fetch).
const TIMEOUT_MS = clampInteger(
  process.env.STOA_WEB_FETCH_TIMEOUT_MS,
  1,
  600_000,
  15_000
);
const MAX_REDIRECTS = 5;

type VettedAddr = { address: string; family: number };

/**
 * SSRF host guard: resolve the URL's host and reject if ANY address is loopback /
 * private / link-local / metadata. Returns the VETTED addresses so the caller can
 * PIN the connection to them — closing the DNS-rebinding TOCTOU where a second,
 * independent resolution by `fetch` could return a private IP after this check
 * passed. Throws on an unsafe or unresolvable host.
 */
async function resolveVettedHost(u: URL): Promise<VettedAddr[]> {
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  let addrs: VettedAddr[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("Could not resolve the URL's host");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error("That host isn't allowed (private/loopback address)");
  }
  return addrs;
}

/**
 * An undici dispatcher whose DNS lookup is PINNED to the pre-vetted addresses —
 * so the actual socket connects only to an IP we already verified is public, and
 * cannot re-resolve to a rebound private IP. The original hostname is still used
 * for the TLS SNI / Host header (undici only takes the IP from `lookup`).
 */
function pinnedDispatcher(vetted: VettedAddr[]): Agent {
  return new Agent({
    connect: {
      lookup: (
        _hostname: string,
        options: { all?: boolean },
        cb: (
          err: NodeJS.ErrnoException | null,
          address: string | VettedAddr[],
          family?: number
        ) => void
      ) => {
        if (options?.all) cb(null, vetted);
        else cb(null, vetted[0].address, vetted[0].family);
      },
    },
  });
}

/**
 * Fetch, following redirects MANUALLY and re-validating + IP-pinning the host at
 * every hop — so an allowed public URL can't 302 to a private one, AND a rebinding
 * host can't resolve public for the check then private for the connection. Returns
 * the final response together with its dispatcher (the caller closes it after the
 * body is read; intermediate redirect dispatchers are closed here).
 */
async function safeFetch(
  start: string,
  signal: AbortSignal
): Promise<{ res: Response; dispatcher: Agent }> {
  let url = start;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!isHttpUrl(url)) throw new Error("Only http(s) URLs are allowed");
    const vetted = await resolveVettedHost(new URL(url));
    const dispatcher = pinnedDispatcher(vetted);
    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        redirect: "manual",
        headers: { "User-Agent": "Stoa-WebFetch/1.0" },
        // Node's fetch reads `dispatcher`; it isn't in the DOM RequestInit type.
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
    } catch (err) {
      await dispatcher.close().catch(() => {});
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      // Redirect response body is never consumed — close this hop's dispatcher.
      await dispatcher.close().catch(() => {});
      if (!loc) throw new Error("Redirect without a location");
      url = new URL(loc, url).toString(); // resolve a relative redirect
      continue;
    }
    return { res, dispatcher };
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
  const rateLimit = checkRateLimit(
    request as import("next/server").NextRequest
  );
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfter: rateLimit.retryAfter },
      {
        status: 429,
        headers: rateLimit.retryAfter
          ? { "Retry-After": String(rateLimit.retryAfter) }
          : {},
      }
    );
  }

  const parsed = await parseJsonBody<{ url?: string }>(request);
  if (!parsed.ok) return parsed.response;

  const { url } = parsed.data;

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
  let dispatcher: Agent | undefined;
  try {
    ({ res, dispatcher } = await safeFetch(url, controller.signal));
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
    // Close the pinned dispatcher now the body is fully read (or we errored).
    if (dispatcher) await dispatcher.close().catch(() => {});
  }

  // Reduce → strip → write. Each step can throw (htmlToText on pathological
  // input, fs.mkdirSync/writeFileSync on EACCES/ENOSPC), so guard the whole tail
  // and return a structured 500 instead of letting it escape as an opaque error.
  try {
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
    const message =
      error instanceof Error ? error.message : "Failed to save fetched page";
    console.error("web-fetch save error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
