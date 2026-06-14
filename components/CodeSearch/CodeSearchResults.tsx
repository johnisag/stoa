"use client";

import { useCodeSearch } from "@/data/code-search";
import { Loader2, FileCode, Search } from "lucide-react";
import { useState, useEffect } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";

// Register ONLY the languages getLanguageFromPath maps (PrismLight bundles no
// grammars by default) — drops the 625KB full-refractor chunk to <100KB. Any
// other extension falls back to "text" (renders plain, which is correct).
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("html", markup); // Prism models HTML as markup
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("ruby", ruby);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("rust", rust);
import { cn } from "@/lib/utils";
import { baseName, dirName } from "@/lib/path-display";
import type { FormattedMatch } from "@/lib/code-search";

interface CodeSearchResultsProps {
  workingDirectory: string;
  query: string;
  onSelectFile: (file: string, line: number) => void;
}

export function CodeSearchResults({
  workingDirectory,
  query,
  onSelectFile,
}: CodeSearchResultsProps) {
  const { data, isLoading, isError, error } = useCodeSearch(
    workingDirectory,
    query,
    query.length > 2
  );

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset the highlighted row when the query changes — otherwise a stale index
  // from a longer previous result set can point past a new, shorter list (no row
  // selected, Enter targets nothing/the wrong row).
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!data?.results.length) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, data.results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const result = data.results[selectedIndex];
        if (result) {
          onSelectFile(result.file, result.line);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [data, selectedIndex, onSelectFile]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-destructive p-4 text-sm">
        {error instanceof Error ? error.message : "Failed to search code"}
      </div>
    );
  }

  if (query.length < 3) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center p-8">
        <Search className="mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">Type at least 3 characters to search</p>
      </div>
    );
  }

  if (!data?.results.length) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center p-8">
        <FileCode className="mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">No matches found for &quot;{query}&quot;</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y">
      {data.results.map((result, index) => (
        <SearchResultItem
          key={`${result.file}:${result.line}`}
          result={result}
          isSelected={index === selectedIndex}
          onClick={() => onSelectFile(result.file, result.line)}
        />
      ))}
    </div>
  );
}

interface SearchResultItemProps {
  result: FormattedMatch;
  isSelected: boolean;
  onClick: () => void;
}

function SearchResultItem({
  result,
  isSelected,
  onClick,
}: SearchResultItemProps) {
  const language = getLanguageFromPath(result.file);
  const fileName = baseName(result.file);
  const filePath = /[\\/]/.test(result.file) ? dirName(result.file) : "";

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex min-h-[44px] flex-col gap-2 p-3 text-left transition-colors",
        "hover:bg-accent",
        isSelected && "bg-accent"
      )}
    >
      <div className="flex items-center gap-2">
        <FileCode className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <span className="font-medium">{fileName}</span>
          {filePath && (
            <span className="text-muted-foreground text-xs"> · {filePath}</span>
          )}
          <span className="text-muted-foreground text-xs">
            {" "}
            · Line {result.line}
          </span>
        </div>
      </div>

      <div className="bg-muted/50 rounded p-2 font-mono text-xs">
        <SyntaxHighlighter
          language={language}
          style={vscDarkPlus}
          customStyle={{
            background: "transparent",
            padding: 0,
            margin: 0,
          }}
          wrapLines
          showLineNumbers={false}
        >
          {result.lineText}
        </SyntaxHighlighter>
      </div>
    </button>
  );
}

function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
  };
  return map[ext] || "text";
}
