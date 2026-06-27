"use client";

import { useState, useEffect } from "react";
import { Loader2, MessagesSquare, ScanSearch } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useOutputSearch,
  type OutputSearchSessionResult,
} from "@/data/output-search";

interface OutputSearchResultsProps {
  query: string;
  onSelectSession: (sessionId: string) => void;
}

/**
 * Cross-session output search results: each Claude session whose transcript
 * matches the query, ranked by match count, with role-labelled snippets. Reading
 * the agent's own transcript turns (not the raw scrollback) means the matches are
 * clean text; selecting a session opens it. Owns its own keyboard nav (↑↓/Enter)
 * the way CodeSearchResults does.
 */
export function OutputSearchResults({
  query,
  onSelectSession,
}: OutputSearchResultsProps) {
  const trimmed = query.trim();
  const enabled = trimmed.length > 1;
  const { data, isFetching, isError, error } = useOutputSearch(
    trimmed,
    enabled
  );
  const results = data?.results ?? [];

  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => setSelectedIndex(0), [trimmed]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!results.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const r = results[selectedIndex];
        if (r) onSelectSession(r.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [results, selectedIndex, onSelectSession]);

  if (!enabled) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center p-8">
        <ScanSearch className="mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">
          Search agent output across your Claude sessions
        </p>
        <p className="text-xs opacity-70">
          Type at least 2 characters · Claude transcripts only
        </p>
      </div>
    );
  }

  if (isFetching && !data) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-destructive p-4 text-sm">
        {error instanceof Error ? error.message : "Failed to search output"}
      </div>
    );
  }

  if (!results.length) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center p-8">
        <MessagesSquare className="mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">No output matches for &quot;{trimmed}&quot;</p>
        <p className="text-xs opacity-70">
          Searches Claude session transcripts
        </p>
      </div>
    );
  }

  const count = data?.count ?? results.length;
  return (
    <div className="flex flex-col divide-y">
      {results.map((result, index) => (
        <OutputResultItem
          key={result.id}
          result={result}
          query={trimmed}
          isSelected={index === selectedIndex}
          onClick={() => onSelectSession(result.id)}
        />
      ))}
      {count > results.length && (
        <div className="text-muted-foreground px-3 py-2 text-center text-xs">
          Showing top {results.length} of {count} matching sessions
        </div>
      )}
    </div>
  );
}

interface OutputResultItemProps {
  result: OutputSearchSessionResult;
  query: string;
  isSelected: boolean;
  onClick: () => void;
}

function OutputResultItem({
  result,
  query,
  isSelected,
  onClick,
}: OutputResultItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex min-h-[44px] flex-col gap-1.5 p-3 text-left transition-colors",
        "hover:bg-accent",
        isSelected && "bg-accent"
      )}
    >
      <div className="flex items-center gap-2">
        <MessagesSquare className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {result.name || "Unnamed Session"}
        </span>
        <span className="text-muted-foreground flex-shrink-0 text-xs">
          {result.total} match{result.total === 1 ? "" : "es"}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {result.hits.map((hit, i) => (
          <div
            key={i}
            className="bg-muted/50 text-muted-foreground rounded px-2 py-1 font-mono text-xs"
          >
            <span className="text-foreground/60 mr-1 capitalize">
              {hit.role}:
            </span>
            {highlight(hit.snippet, query)}
          </div>
        ))}
      </div>
    </button>
  );
}

/** Wrap each case-insensitive occurrence of `query` in the snippet with a <mark>.
 * Uses indexOf (never a RegExp built from user input) so a query like `a(b` or
 * `.*` is matched literally and can't throw or ReDoS. */
function highlight(snippet: string, query: string): React.ReactNode {
  const q = query.toLowerCase();
  if (!q) return snippet;
  const lower = snippet.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const at = lower.indexOf(q, i);
    if (at === -1) {
      parts.push(snippet.slice(i));
      break;
    }
    if (at > i) parts.push(snippet.slice(i, at));
    parts.push(
      <mark key={key++} className="bg-primary/30 rounded-sm text-inherit">
        {snippet.slice(at, at + q.length)}
      </mark>
    );
    i = at + q.length;
  }
  return parts;
}
