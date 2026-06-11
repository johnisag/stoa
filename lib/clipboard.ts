/**
 * Copy text to the clipboard, with a fallback for the contexts where the async
 * Clipboard API is unavailable — notably **non-HTTPS LAN access from a phone**,
 * which is a normal Stoa deployment (navigator.clipboard is undefined there).
 * Falls back to a hidden <textarea> + document.execCommand("copy"). Returns true
 * on success. Client-only (touches document); guard the call site for SSR.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand path (permissions / insecure context).
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
