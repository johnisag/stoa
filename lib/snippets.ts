// Reusable prompt snippets — saved text the user can insert into a terminal.
// Backed by a single localStorage key so every surface (mobile toolbar, desktop
// tab bar) reads and writes the SAME list. Pure + testable: every helper takes
// an injected Storage-like object so the browser's localStorage is the only
// impure caller (the components that read these at render time).

export interface Snippet {
  id: string;
  name: string;
  content: string;
}

/** The slice of the DOM Storage interface we use (localStorage at runtime). */
export interface SnippetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// One shared key across all surfaces — do not fork this or the surfaces diverge.
export const SNIPPETS_STORAGE_KEY = "terminal-snippets";

export const DEFAULT_SNIPPETS: Snippet[] = [
  // Git shortcuts
  { id: "default-1", name: "Git status", content: "git status" },
  { id: "default-2", name: "Git diff", content: "git diff" },
  { id: "default-3", name: "Git add all", content: "git add -A" },
  { id: "default-4", name: "Git commit", content: 'git commit -m ""' },
  { id: "default-5", name: "Git push", content: "git push" },
  { id: "default-6", name: "Git pull", content: "git pull" },
  // Claude Code prompts
  { id: "default-7", name: "Continue", content: "continue" },
  { id: "default-8", name: "Yes", content: "yes" },
  { id: "default-9", name: "No", content: "no" },
  {
    id: "default-10",
    name: "Explain this",
    content: "explain what this code does",
  },
  { id: "default-11", name: "Fix errors", content: "fix the errors" },
  {
    id: "default-12",
    name: "Run tests",
    content: "run the tests and fix any failures",
  },
  {
    id: "default-13",
    name: "Commit changes",
    content: "commit these changes with a descriptive message",
  },
  // Common commands
  { id: "default-14", name: "List files", content: "ls -la" },
  { id: "default-15", name: "NPM dev", content: "npm run dev" },
  { id: "default-16", name: "NPM install", content: "npm install" },
];

// Defend against a hand-edited / legacy value of the wrong shape.
function isSnippet(value: unknown): value is Snippet {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.content === "string"
  );
}

/**
 * Read the saved snippets. On the very first read (no stored value) this seeds
 * the defaults and persists them so the list is stable across reloads. A corrupt
 * or wrong-shaped value falls back to the defaults without throwing.
 */
export function getStoredSnippets(storage: SnippetStorage): Snippet[] {
  try {
    const raw = storage.getItem(SNIPPETS_STORAGE_KEY);
    if (!raw) {
      // First time — seed the defaults so both surfaces share one starting list.
      saveSnippets(storage, DEFAULT_SNIPPETS);
      return DEFAULT_SNIPPETS;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SNIPPETS;
    return parsed.filter(isSnippet);
  } catch {
    return DEFAULT_SNIPPETS;
  }
}

/** Persist the full snippet list. Write failures are swallowed (private mode / quota). */
export function saveSnippets(
  storage: SnippetStorage,
  snippets: Snippet[]
): void {
  try {
    storage.setItem(SNIPPETS_STORAGE_KEY, JSON.stringify(snippets));
  } catch {
    // localStorage might be unavailable or over quota — keep the in-memory list.
  }
}

/**
 * Append a snippet (trimming name + content) and persist. Returns the new full
 * list so a caller can update React state without a second read. A blank name
 * or content is rejected — the list is returned unchanged.
 */
export function addSnippet(
  storage: SnippetStorage,
  snippets: Snippet[],
  name: string,
  content: string
): Snippet[] {
  const trimmedName = name.trim();
  const trimmedContent = content.trim();
  if (!trimmedName || !trimmedContent) return snippets;
  const next = [
    ...snippets,
    { id: Date.now().toString(), name: trimmedName, content: trimmedContent },
  ];
  saveSnippets(storage, next);
  return next;
}

/**
 * Remove a snippet by id and persist. Returns the new full list so a caller can
 * update React state without a second read.
 */
export function removeSnippet(
  storage: SnippetStorage,
  snippets: Snippet[],
  id: string
): Snippet[] {
  const next = snippets.filter((s) => s.id !== id);
  saveSnippets(storage, next);
  return next;
}
