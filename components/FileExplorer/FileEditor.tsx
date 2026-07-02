"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";
import { FileCode, Eye, Code2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { HtmlRenderer } from "./HtmlRenderer";

interface FileEditorProps {
  content: string;
  language: string;
  isBinary: boolean;
  readOnly?: boolean;
  onChange: (content: string) => void;
  onSave?: () => void;
  /** #23 jump-to-line: scroll/select this 1-based line. `token` re-fires the
   *  jump even when the line repeats (each click is a fresh token). */
  jumpToLine?: { line: number; token: number } | null;
}

// Theme that uses CSS variables from the app
const editorTheme = EditorView.theme({
  "&": {
    fontSize: "13px",
    height: "100%",
    backgroundColor: "hsl(var(--background))",
    color: "hsl(var(--foreground))",
  },
  ".cm-content": {
    fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
    padding: "8px 0",
    caretColor: "hsl(var(--primary))",
  },
  ".cm-gutters": {
    backgroundColor: "hsl(var(--background))",
    borderRight: "none",
    color: "hsl(var(--muted-foreground))",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 16px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "hsl(var(--accent))",
  },
  ".cm-activeLine": {
    backgroundColor: "hsl(var(--accent) / 0.5)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "hsl(var(--primary) / 0.3) !important",
    },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "hsl(var(--primary))",
    borderLeftWidth: "2px",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
  ".cm-foldGutter": {
    color: "hsl(var(--muted-foreground))",
  },
  ".cm-tooltip": {
    backgroundColor: "hsl(var(--popover))",
    boxShadow: "0 4px 12px hsl(var(--foreground) / 0.15)",
    color: "hsl(var(--popover-foreground))",
  },
  ".cm-tooltip-autocomplete": {
    "& > ul > li[aria-selected]": {
      backgroundColor: "hsl(var(--accent))",
      color: "hsl(var(--accent-foreground))",
    },
  },
  ".cm-panels": {
    backgroundColor: "hsl(var(--muted))",
  },
  ".cm-searchMatch": {
    backgroundColor: "hsl(var(--primary) / 0.2)",
    outline: "1px solid hsl(var(--primary) / 0.4)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "hsl(var(--primary) / 0.4)",
  },
});

// Syntax highlighting that adapts to both light and dark themes
const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "hsl(var(--primary))" },
  {
    tag: [t.name, t.deleted, t.character, t.macroName],
    color: "hsl(var(--foreground))",
  },
  { tag: [t.propertyName], color: "#7dd3fc" }, // sky-300
  { tag: [t.function(t.variableName), t.labelName], color: "#c4b5fd" }, // violet-300
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#fcd34d" }, // amber-300
  { tag: [t.definition(t.name), t.separator], color: "hsl(var(--foreground))" },
  {
    tag: [
      t.typeName,
      t.className,
      t.number,
      t.changed,
      t.annotation,
      t.modifier,
      t.self,
      t.namespace,
    ],
    color: "#f9a8d4", // pink-300
  },
  {
    tag: [
      t.operator,
      t.operatorKeyword,
      t.url,
      t.escape,
      t.regexp,
      t.special(t.string),
    ],
    color: "#67e8f9", // cyan-300
  },
  {
    tag: [t.meta, t.comment],
    color: "hsl(var(--muted-foreground))",
    fontStyle: "italic",
  },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "#67e8f9", textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: "hsl(var(--primary))" },
  { tag: [t.atom, t.bool], color: "#f9a8d4" }, // pink-300
  { tag: [t.processingInstruction, t.string, t.inserted], color: "#86efac" }, // green-300
  { tag: t.invalid, color: "#fca5a5" }, // red-300
]);

function getLanguageExtension(language: string): Extension | null {
  switch (language) {
    case "javascript":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ jsx: true, typescript: true });
    case "python":
      return python();
    case "json":
      return json();
    case "css":
    case "scss":
      return css();
    case "html":
    case "xml":
      return html();
    case "markdown":
      return markdown();
    default:
      return null;
  }
}

export function FileEditor({
  content,
  language,
  isBinary,
  readOnly = false,
  onChange,
  onSave,
  jumpToLine,
}: FileEditorProps) {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [previewMode, setPreviewMode] = useState(false);
  const isMarkdown = language === "markdown";
  const isHtml = language === "html";
  const hasPreview = isMarkdown || isHtml;

  // Keep the latest onSave in a ref so the extensions effect doesn't re-run
  // (and recreate the keymap) when the parent passes a fresh arrow each render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // #23 jump-to-line: the view may not exist yet when the jump arrives (fresh
  // open — CodeMirror mounts after the fetch), so stash the pending jump and
  // apply it from BOTH the effect (view already live) and onCreateEditor
  // (view arrives later). Clamped to the document, cursor placed on the line.
  const viewRef = useRef<EditorView | null>(null);
  const pendingJumpRef = useRef<{ line: number; token: number } | null>(null);
  const appliedTokenRef = useRef<number>(0);
  const applyJump = useCallback((view: EditorView) => {
    const jump = pendingJumpRef.current;
    if (!jump || appliedTokenRef.current === jump.token) return;
    appliedTokenRef.current = jump.token;
    const ln = Math.min(Math.max(1, jump.line), view.state.doc.lines);
    const pos = view.state.doc.line(ln).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
  }, []);
  useEffect(() => {
    if (!jumpToLine) return;
    pendingJumpRef.current = jumpToLine;
    if (viewRef.current) applyJump(viewRef.current);
  }, [jumpToLine, applyJump]);

  useEffect(() => {
    const langExt = getLanguageExtension(language);
    const baseExtensions: Extension[] = [
      editorTheme,
      syntaxHighlighting(highlightStyle),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            const save = onSaveRef.current;
            if (!save) return false;
            save();
            return true;
          },
        },
      ]),
    ];

    if (langExt) {
      baseExtensions.push(langExt);
    }

    setExtensions(baseExtensions);
  }, [language]);

  useEffect(() => {
    if (!hasPreview) setPreviewMode(false);
  }, [hasPreview]);

  if (isBinary) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center p-8">
        <FileCode className="mb-4 h-12 w-12 opacity-50" />
        <p className="text-center text-sm">Binary file cannot be displayed</p>
      </div>
    );
  }

  return (
    <div className="bg-background flex h-full w-full flex-col overflow-hidden">
      {hasPreview && (
        <div className="bg-muted/30 flex items-center justify-end px-2 py-1 shadow-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPreviewMode(!previewMode)}
            title={previewMode ? "Show source" : "Preview"}
          >
            {previewMode ? (
              <Code2 className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {previewMode && isMarkdown ? (
          <MarkdownRenderer content={content} />
        ) : previewMode && isHtml ? (
          <HtmlRenderer content={content} />
        ) : (
          <CodeMirror
            value={content}
            height="100%"
            theme="none"
            extensions={extensions}
            onChange={onChange}
            onCreateEditor={(view) => {
              viewRef.current = view;
              applyJump(view);
            }}
            readOnly={readOnly}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              highlightActiveLine: true,
              foldGutter: true,
              dropCursor: true,
              allowMultipleSelections: true,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              rectangularSelection: true,
              crosshairCursor: false,
              highlightSelectionMatches: true,
              searchKeymap: true,
            }}
            className="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:!overflow-auto"
          />
        )}
      </div>
    </div>
  );
}
