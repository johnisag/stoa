"use client";

import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { getTerminalThemeForApp } from "../constants";
import { loadRenderer } from "./terminal-renderer";
import { extractFileLineLinks } from "@/lib/terminal-links";

export interface TerminalInstance {
  term: XTerm;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  cleanup: () => void;
}

/** Clicked file:line link (#23): the path as written, the 1-based line, and
 *  the exact matched text (for mobile prompt insertion). */
export type FileLinkHandler = (
  path: string,
  line: number,
  matchedText: string
) => void;

export function createTerminal(
  container: HTMLElement,
  isMobile: boolean,
  theme: string,
  onFileLink?: FileLinkHandler
): TerminalInstance {
  const fontSize = isMobile ? 11 : 14;
  const terminalTheme = getTerminalThemeForApp(theme || "dark");

  const term = new XTerm({
    cursorBlink: true,
    fontSize,
    fontFamily:
      '"JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace',
    fontWeight: "400",
    fontWeightBold: "600",
    letterSpacing: 0,
    lineHeight: isMobile ? 1.15 : 1.2,
    scrollback: 15000,
    scrollSensitivity: isMobile ? 3 : 1,
    fastScrollSensitivity: 5,
    smoothScrollDuration: 100,
    cursorStyle: "bar",
    cursorWidth: 2,
    allowProposedApi: true,
    // Agent TUIs (Claude Code, Hermes, …) enable mouse tracking, which makes
    // xterm forward drags to the app instead of selecting text. Option+drag
    // forces a local selection on macOS so users can still select to copy.
    macOptionClickForcesSelection: true,
    theme: terminalTheme,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.loadAddon(searchAddon);
  term.open(container);
  // GPU renderer (WebGL, with canvas/DOM fallback) — must load after open().
  loadRenderer(term);

  // #23 file:line jump-to-error links. A custom provider over the PURE
  // extractor (lib/terminal-links.ts) — WebLinksAddon above only handles URLs.
  // Runs per rendered buffer row on hover; xterm's y is 1-based, and link
  // ranges are 1-based inclusive columns.
  let fileLinkDisposable: { dispose(): void } | undefined;
  if (onFileLink) {
    fileLinkDisposable = term.registerLinkProvider({
      provideLinks(y, callback) {
        const bufferLine = term.buffer.active.getLine(y - 1);
        if (!bufferLine) return callback(undefined);
        const text = bufferLine.translateToString(true);
        const links = extractFileLineLinks(text).map((l) => ({
          range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
          text: text.slice(l.start, l.end),
          activate: () =>
            onFileLink(l.path, l.line, text.slice(l.start, l.end)),
        }));
        callback(links.length > 0 ? links : undefined);
      },
    });
  }

  // On mobile, the soft keyboard auto-capitalizes/corrects/spellchecks the
  // hidden xterm input by default, silently corrupting shell commands
  // (`git status` → `Git status`). Turn that off on the helper textarea xterm
  // creates during open(). Desktop is untouched (the attrs only affect virtual
  // keyboards), but gate on isMobile to keep the desktop path byte-identical.
  if (isMobile) {
    const textarea = container.querySelector(
      ".xterm-helper-textarea"
    ) as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.setAttribute("autocapitalize", "off");
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("spellcheck", "false");
      textarea.setAttribute("enterkeyhint", "send");
    }
  }

  fitAddon.fit();

  // Helper to copy text to clipboard with fallback
  const copyToClipboard = (text: string) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        // Fallback if clipboard API fails
        execCommandCopy(text);
      });
    } else {
      // Fallback for non-secure contexts
      execCommandCopy(text);
    }
  };

  const execCommandCopy = (text: string) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  };

  // Handle Cmd+A and Cmd+C via document event listener (more reliable than attachCustomKeyEventHandler)
  const handleKeyDown = (event: KeyboardEvent) => {
    // Only handle when terminal is focused (xterm creates its textarea inside the container)
    if (!container.contains(document.activeElement)) return;

    const key = event.key.toLowerCase();

    // Cmd+A (macOS) / Ctrl+A for select all
    if ((event.metaKey || event.ctrlKey) && key === "a") {
      event.preventDefault();
      event.stopPropagation();
      term.selectAll();
      return;
    }

    // Cmd+C (macOS) / Ctrl+C for copy when text is selected
    if ((event.metaKey || event.ctrlKey) && key === "c") {
      const selection = term.getSelection();
      if (selection) {
        event.preventDefault();
        event.stopPropagation();
        copyToClipboard(selection);
      }
    }
  };

  // Use capture phase to intercept before browser default
  document.addEventListener("keydown", handleKeyDown, true);

  const cleanup = () => {
    document.removeEventListener("keydown", handleKeyDown, true);
    fileLinkDisposable?.dispose();
  };

  return { term, fitAddon, searchAddon, cleanup };
}

export function updateTerminalForMobile(
  term: XTerm,
  fitAddon: FitAddon,
  isMobile: boolean,
  sendResize: (cols: number, rows: number) => void
): void {
  const newFontSize = isMobile ? 11 : 14;
  const newLineHeight = isMobile ? 1.15 : 1.2;

  if (term.options.fontSize !== newFontSize) {
    term.options.fontSize = newFontSize;
    term.options.lineHeight = newLineHeight;
    term.refresh(0, term.rows - 1);
    fitAddon.fit();
    sendResize(term.cols, term.rows);
  }
}

export function updateTerminalTheme(term: XTerm, theme: string): void {
  const terminalTheme = getTerminalThemeForApp(theme || "dark");
  term.options.theme = terminalTheme;
}
