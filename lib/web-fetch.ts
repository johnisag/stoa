/**
 * Pure helpers for the "attach a URL as context" feature: validate that a URL is
 * a plain http/https web address, and reduce a fetched HTML page to readable
 * plain text. No I/O here — the route does the bounded fetch and the temp write;
 * these stay pure so they can be unit-tested without a network.
 */

/**
 * True only for an absolute http(s) URL. Rejects every other scheme
 * (file:, data:, javascript:, ftp:, ...) and anything that doesn't parse as a
 * URL. The scheme half of the SSRF guard; the host half is isPrivateAddress,
 * applied to every RESOLVED address in the route (incl. redirect hops).
 */
export function isHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Is `ip` a loopback / private / link-local / unspecified / CGNAT address? The
 * SSRF host guard: the route rejects a fetch when ANY resolved address is one of
 * these, so a user-supplied URL can't reach the Stoa host's own services, the
 * LAN, or cloud instance metadata (169.254.169.254). Pure + unit-tested.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  if (!addr) return true; // treat an unresolvable/empty address as unsafe

  // IPv4-mapped IPv6, DOTTED form (::ffff:1.2.3.4) → check the embedded v4.
  const mappedDotted = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isPrivateAddress(mappedDotted[1]);
  // IPv4-mapped IPv6, HEX form (::ffff:a9fe:a9fe) — the canonical spelling that
  // `new URL()` and dns.lookup actually emit. Rebuild the dotted quad from the
  // two 16-bit groups and recurse, else 169.254.169.254 et al. slip through.
  const mappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateAddress(dotted);
  }

  // IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const [a, b] = addr.split(".").map((n) => parseInt(n, 10));
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }

  // IPv6
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  return false;
}

/**
 * Reduce an HTML document to readable plain text: drop the contents of
 * <script>/<style>/<noscript> (markup, not prose), turn block-level tags into
 * line breaks so paragraphs don't run together, strip every remaining tag,
 * decode the handful of named/numeric entities a page actually leans on, and
 * collapse runs of whitespace. Pure string work — no DOM. Control chars are
 * NOT stripped here; the route runs the result through
 * formatTerminalTextForAgent before it reaches the agent.
 */
export function htmlToText(html: string): string {
  if (!html) return "";

  let text = html;

  // Drop elements whose contents are code/markup, not readable prose. [\s\S]
  // matches across newlines without the dotAll flag.
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
  // HTML comments.
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Block-level boundaries → newlines so paragraphs/list items stay separated
  // once the tags are gone. <br> → a single newline.
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(
    /<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|blockquote)\s*>/gi,
    "\n"
  );

  // Strip every remaining tag.
  text = text.replace(/<[^>]+>/g, "");

  // Decode the common entities a typical page relies on (named + numeric).
  text = decodeEntities(text);

  // Collapse whitespace: trim each line, drop runs of blank lines, trim ends.
  text = text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");

  return text;
}

/** Decode the named + numeric HTML entities a fetched page commonly uses. */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    "#39": "'",
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower[0] === "#") {
      const code =
        lower[1] === "x"
          ? parseInt(lower.slice(2), 16)
          : parseInt(lower.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return Object.prototype.hasOwnProperty.call(named, lower)
      ? named[lower]
      : match;
  });
}
