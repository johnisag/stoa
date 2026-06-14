# Stoa Competitor Deep-Research Wins

Generated: 2026-06-14T15:00:32Z

This file aggregates 15 competitor-research agents' findings. Each section focuses on one app/category and lists small, KISS, high-value wins that could improve Stoa.

## Status Snapshot (2026-06-14)

The following competitive-research recommendations are partially or fully shipped as of PR #251 (`618fcf8`):

- **Workflows as a first-class pane tab** — `WorkflowsView` is now rendered inside a pane tab via the new `TabData.view` discriminator, instead of a global dialog.
- **Workflow builder polish** — the canvas fills the full pane height (the 40vh cap was removed); the header chrome was compacted; a "Go to definitions" context-menu item scrolls the edit panel into view for nodes and notes.
- **Worker session hand-off** — "Open session" from a workflow run now opens in a new terminal tab rather than mutating the workflows tab.

**Pending / backlogged:** the bulk of the recommendations in this file remain unimplemented, including canvas navigation wins (spacebar pan, fit-to-view, minimap, keyboard shortcuts, auto-scroll node), Claude Code-style diff approval / `@` mentions, command-palette enhancements, Copilot Workspace / Cursor patterns, deployment/error UX, Make/Zapier-style builder features, mobile/touch wins, modern terminal features, n8n / React Flow / Windmill canvas patterns, and onboarding improvements.

## Area: canvas-nav

# Competitive Research: Canvas Navigation UX for Stoa PipelineCanvas

## Scope & Goal

Research how **Figma, Miro, Excalidraw, and tldraw** handle canvas navigation (minimap, zoom, pan, spacebar drag, follow/focus). Identify 3–5 **small, KISS, high-value** wins that Stoa can apply to its **PipelineCanvas** (and a future minimap) without replacing the custom SVG implementation.

## Current Stoa State (observed)

- `PipelineCanvas.tsx` is a custom SVG canvas with a 1:1 `viewBox`; no zoom transform.
- Canvas lives in a scrollable wrapper: `max-h-[40vh] overflow-auto rounded-md border`.
- Nodes are dragged via Pointer Events; empty-canvas taps clear selection.
- No minimap, no zoom, no pan mode, no spacebar drag, no keyboard navigation, no "fit to view".
- Mobile-first: `touch-action: none` only on nodes/ports so the page scroll is not trapped.

---

## Competitive Landscape

| Tool                               | Pan                                                            | Zoom                                                                                          | Minimap / Overview                                                                              | Follow / Focus                                                                                                               | Key Source                                                                                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Figma**                          | `Space` + drag; arrow keys pan; `Shift` arrows fast-pan.       | `Cmd/Ctrl + +/-`; `Shift + 1` zoom-to-fit; `Shift + 2` zoom-to-selection; wheel + `Cmd/Ctrl`. | No built-in minimap; community plugins (e.g., Canvas Map, Minimap) are popular for large files. | Deep-link URLs zoom-to-layer on open; actions menu search.                                                                   | [Figma keyboard help](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard), [Figma zoom/view options](https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options)             |
| **Miro**                           | `Space` + drag; right-button drag; `H` hand tool / `V` select. | Mouse wheel / pinch; `+`/`-` buttons.                                                         | Built-in bottom-right minimap; toggle with `M`; click/drag to pan; fit-to-screen button.        | "Attention management" / follow facilitator; click user icon to jump to their view.                                          | [Miro mouse/trackpad/touchscreen help](https://help.miro.com/hc/en-us/articles/360017731053-Using-Miro-with-a-mouse-trackpad-or-touchscreen)                                                                                                    |
| **Excalidraw**                     | `Space` + drag; middle-mouse drag; hand tool.                  | Pinch; `Cmd/Ctrl + +/-` (or wheel).                                                           | No built-in minimap (feature request #2184); community scripts add one.                         | `scrollToContent({ fitToContent: true, animate: true })` API to center/focus content.                                        | [Excalidraw homepage](https://excalidraw.com/), [Excalidraw API docs](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api)                                                                                         |
| **tldraw**                         | `Space` + drag; middle-mouse drag.                             | Pinch; wheel; keyboard zoom.                                                                  | Built-in minimap; click pan; viewport rectangle.                                                | **User following**: `startFollowingUser()` syncs viewport to a collaborator; stops on interaction; colored border indicator. | [tldraw v2.2.0 release notes](https://tldraw.dev/releases/v2.2.0), [tldraw user following docs](https://tldraw.dev/sdk-features/user-following)                                                                                                 |
| **React Flow** (reference pattern) | Pointer drag; `panOnScroll`; spacebar in design-tool mode.     | Wheel/pinch; `fitView()`.                                                                     | `<MiniMap pannable zoomable />` — bird’s-eye view, clickable/draggable, custom node colors.     | `autoPanOnNodeFocus` brings focused nodes into view.                                                                         | [React Flow MiniMap docs](https://reactflow.dev/api-reference/components/minimap), [React Flow accessibility](https://reactflow.dev/learn/advanced-use/accessibility), [React Flow viewport](https://reactflow.dev/learn/concepts/the-viewport) |

### Cross-tool UX takeaways

- **Spacebar drag is the de-facto standard** across all four tools; users expect it. Figma users complain loudly when it breaks due to focus issues.
- **Zoom-to-fit on load** is the default in Figma and a one-line API in Excalidraw/React Flow; it prevents "lost nodes".
- **Mini-maps are expected in large canvases** (Miro, tldraw, React Flow). Figma lacks one natively, so plugins fill the gap — a signal that Stoa can differentiate with a small built-in one.
- **Keyboard navigation is an accessibility requirement**: arrow-key pan, +/- zoom, `F`/1/2 focus shortcuts. React Flow explicitly auto-pans to focused nodes for a11y.
- **Follow/focus** is valuable for multi-user or long workflows; tldraw’s smooth viewport interpolation and stop-on-interaction model is the reference.

> “The little things matter more than the big things. Smooth pan and zoom… A mini-map that’s actually useful, not decorative… Keyboard shortcuts for everything… When you study Figma, Linear, or Notion’s canvas-style features, you’ll see the same patterns implemented with obsessive care.” — _VisualFlow, “Mini-Maps, Zoom, and Pan: Getting Canvas Navigation Right”_ ([source](https://workflow.visualflow.dev/blogs/mini-maps-zoom-and-pan-getting-canvas-navigation-right))

---

## Recommended Wins for Stoa

### 1. Spacebar-drag to pan the canvas

- **What:** While `Space` is held, dragging the canvas pans the scrollable wrapper instead of selecting/moving nodes. Cursor changes to a hand/grab. Releasing `Space` returns to normal mode. Also supports middle-mouse drag as an alternative.
- **Why:** This is the most universal canvas navigation shortcut (Figma, Miro, Excalidraw, tldraw). Current PipelineCanvas requires users to find the tiny scrollbar, especially awkward on mobile/desktop hybrid workflows.
- **Effort:** **S** — add a `keydown`/`keyup` listener for `Space`, temporarily switch the wrapper drag handler from node-drag to scroll-drag, and set `cursor: grab`. No SVG transform changes required.
- **Stoa area:** `PipelineCanvas.tsx` wrapper + pointer event handlers.
- **Sources:** Figma keyboard help; Excalidraw homepage (“To move canvas, hold `Scroll wheel` or `Space` while dragging”); Miro help (space + left-button drag); tldraw v2.2.0 release notes (spacebar/middle-mouse panning fixes).

### 2. "Fit to view" button and default zoom-to-fit

- **What:** A small bottom-right control (or menu item) that scales the SVG so all nodes fit inside the visible canvas container. Mirror Figma’s `Shift + 1` / Excalidraw’s `fitToContent` / React Flow’s `fitView`. Also run automatically when a workflow is first loaded or when `Tidy layout` is used.
- **Why:** Prevents new users from landing on a blank or partially-scrolled canvas; reduces “where did my node go?” support load. Figma defaults every file open to zoom-to-fit.
- **Effort:** **S** — compute node bounding box, derive `scale = min(containerW / contentW, containerH / contentH)` (clamped), apply via CSS `transform: scale()` on the SVG and adjust wrapper scroll. Does not require a full camera model.
- **Stoa area:** `PipelineCanvas.tsx` + `WorkflowBuilder.tsx` toolbar/menu.
- **Sources:** Figma zoom/view options (“When you first open a file, the default zoom level will be set to Zoom to fit”); Excalidraw `scrollToContent` API (`fitToContent`/`fitToViewport`); React Flow `fitView` prop.

### 3. Built-in mini-map

- **What:** A small, collapsible, bottom-right overlay showing a scaled-down rectangle for every node and a draggable viewport rectangle. Clicking or dragging the mini-map pans the main canvas; double-click zooms to fit. Toggle with `M` (Miro-style).
- **Why:** The only tool in the competitive set without a native minimap is Figma, and its plugin market proves users want one. For Stoa workflows with >6–8 steps, it provides orientation and fast jumps across large DAGs.
- **Effort:** **M** — needs a second SVG (or canvas) rendered at fixed size, coordinate mapping from mini-map → main scroll position, and viewport rectangle tracking. Keep it KISS: render simple rects, no edges, no zoom on the mini-map itself for MVP.
- **Stoa area:** New `PipelineMinimap.tsx` component used inside `WorkflowBuilder.tsx` next to `PipelineCanvas`.
- **Sources:** Miro help (bottom-right navigation controls + `M` hotkey); tldraw release notes (minimap click-to-pan bug fix); React Flow `<MiniMap pannable zoomable />` docs; Figma Canvas Map / Minimap plugins showing demand.

### 4. Keyboard shortcuts for pan, zoom, and focus

- **What:** `Arrow keys` pan the scroll wrapper; `Shift + arrows` pan faster; `Ctrl/Cmd + +/-` zoom in/out (if zoom is added); `Shift + 1` fit all; `Shift + 2` zoom to selected node; `F` focus selected node. Also `Tab` cycles focusable nodes.
- **Why:** Accessibility and power-user speed. React Flow explicitly auto-pans to focused nodes for keyboard users. Figma’s arrow-key pan is the fallback when a mouse is unavailable.
- **Effort:** **S** for pan/focus; **M** if zoom shortcuts are added (requires zoom state). Can ship pan/focus first.
- **Stoa area:** `PipelineCanvas.tsx` keyboard handlers; `WorkflowBuilder.tsx` selection integration.
- **Sources:** Figma keyboard help (arrow pan, Shift-fast-pan, +/- zoom); React Flow accessibility docs (`autoPanOnNodeFocus`, arrow-key node movement); tldraw viewport docs.

### 5. Auto-scroll / follow selected node into view

- **What:** When a node is selected from outside the canvas (e.g., clicking a validation error, selecting from the dependency checklist, or the edit panel), the canvas smoothly scrolls so the node is centered in the viewport. Stop auto-follow as soon as the user manually pans or zooms.
- **Why:** Stoa already scrolls the edit panel into view on selection; extending this to the canvas prevents users from hunting for a node after selecting it from a list or error message. tldraw’s follow model uses the same stop-on-interaction guard.
- **Effort:** **S** — read selected node position, call `scrollTo({ left, top, behavior: 'smooth' })` on the wrapper, with a flag that user pan/zoom clears.
- **Stoa area:** `WorkflowBuilder.tsx` selection side effect + `PipelineCanvas.tsx` scroll wrapper.
- **Sources:** tldraw user following docs (stops on canvas interaction); React Flow `autoPanOnNodeFocus`; Figma deep-link zoom-to-layer behavior.

---

## Prioritization Suggestion

1. **Spacebar-drag pan** (S effort, highest user expectation)
2. **Fit-to-view / default zoom-to-fit** (S effort, biggest new-user win)
3. **Auto-scroll selected node into view** (S effort, complements existing selection UX)
4. **Mini-map** (M effort, differentiator for larger workflows)
5. **Keyboard shortcuts** (S–M effort, accessibility + power-user)

All five avoid replacing the current custom SVG; they layer on top of the existing scrollable wrapper and 1:1 coordinate model, keeping the changes surgical and testable.

---

## Sources

1. Figma — “Use Figma products with a keyboard” — https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard
2. Figma — “Adjust your zoom and view options” — https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options
3. Miro — “Using Miro with a mouse, trackpad, or touchscreen” — https://help.miro.com/hc/en-us/articles/360017731053-Using-Miro-with-a-mouse-trackpad-or-touchscreen
4. Excalidraw — homepage interaction hints — https://excalidraw.com/
5. Excalidraw — `excalidrawAPI` / `scrollToContent` docs — https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api
6. tldraw — v2.2.0 release notes (minimap, spacebar/middle-mouse panning, follow fixes) — https://tldraw.dev/releases/v2.2.0
7. tldraw — “User following” SDK docs — https://tldraw.dev/sdk-features/user-following
8. React Flow — MiniMap component docs — https://reactflow.dev/api-reference/components/minimap
9. React Flow — Viewport concepts / design-tool controls — https://reactflow.dev/learn/concepts/the-viewport
10. React Flow — Accessibility / auto-pan on focus — https://reactflow.dev/learn/advanced-use/accessibility
11. VisualFlow — “Mini-Maps, Zoom, and Pan: Getting Canvas Navigation Right” — https://workflow.visualflow.dev/blogs/mini-maps-zoom-and-pan-getting-canvas-navigation-right
12. Figma Community plugin — “Canvas Map” minimap — https://www.figma.com/community/plugin/1576550460245192921/canvas-map

---

## Area: claude-code

# Competitor Research: Claude Code Terminal/Agent UX Patterns

**Date:** 2026-06-14  
**Scope:** Inline edits, approvals, tool use, file context — and what Stoa can borrow.  
**Sources:** Claude Code CLI/docs changelog, GitHub issues, third-party wrappers (OpenShrimp, Polpo, CC Pocket, Claude Terminal), UX comparisons (Cursor, Codex, Cline).

---

## Key Claude Code UX Patterns Observed

| Pattern                          | How Claude Code Does It                                                                                                                                                                                                                                                                                | Pain Point / Gap                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Inline diff review**           | CLI shows `d` for full diff, `y`/`n`/`e` at every edit; Desktop GUI writes first, reviews after [[claudefa.st](https://claudefa.st/blog/guide/mechanics/output-formatting)] [[GH #38831](https://github.com/anthropics/claude-code/issues/38831)]                                                      | GUI has no pre-write diff review; VS Code ext only offers "ask before edits" (one-by-one) or "edit automatically" (silent) [[GH #31888](https://github.com/anthropics/claude-code/issues/31888)] |
| **Per-hunk approval**            | Not native; users request Copilot-style per-hunk accept/discard [[GH #31395](https://github.com/anthropics/claude-code/issues/31395)] [[GH #61794](https://github.com/anthropics/claude-code/issues/61794)]                                                                                            | Atomic accept/reject forces users to revert manually or re-prompt                                                                                                                                |
| **Approval modes**               | Tiered: `default`, `plan`, `auto`, `acceptEdits`, `bypassPermissions`; read-only tools auto-approved; write/bash require approval; rules evaluated `deny → ask → allow` [[learnwithhasan.com](https://learnwithhasan.com/claude-code-guide/)]                                                          | Mode is buried in settings; mobile Remote Control truncates commands to ~100 chars [[GH #37235](https://github.com/anthropics/claude-code/issues/37235)]                                         |
| **Tool cards**                   | Tool use rendered as collapsible cards in GUI wrappers (Claude Terminal, OpenShrimp, Polpo) with Allow / Approve All / Reject [[github.com/Sterll/claude-terminal](https://github.com/Sterll/claude-terminal)] [[github.com/yjwong/open-shrimp](https://github.com/yjwong/open-shrimp)]                | Raw terminal stream can obscure what tool is running and its result                                                                                                                              |
| **@-mentions for context**       | `@path/to/file`, `@dir/`, `@server:resource://`, tab completion, drag-and-drop; `CLAUDE.md` can `@import` other docs [[stevekinney.com](https://stevekinney.com/courses/ai-development/referencing-files-in-claude-code)] [[wmedia.es](https://wmedia.es/en/tips/claude-code-five-ways-right-context)] | Context selection is invisible to the user once sent; no persistent "pinned working set"                                                                                                         |
| **Session sidebar / status**     | Claude Code Desktop sidebar filters by status/project/environment; `claude agents` dashboard shows idle/responding/ended [[verygood.ventures](https://verygood.ventures/blog/claude-code-desktop-hands-on-review/)] [[github.com/gdanov/emacs-gravity](https://github.com/gdanov/emacs-gravity)]       | Pending approvals across sessions are not batched in one surface                                                                                                                                 |
| **Thinking / progress feedback** | Spinner shows token count, warms to amber after 10s; thinking blocks collapsible; background-agent status in footer [[Claude Code changelog](https://code.claude.com/docs/en/changelog)]                                                                                                               | Long operations feel like a black box without streaming progress                                                                                                                                 |

---

## 5 Small, KISS, High-Value Wins for Stoa

### 1. Pre-Write Inline Diff Approval Cards

**What:** When an agent proposes a file edit, render a compact diff card _before_ the write happens. Show `Accept` / `Reject` / `Accept all edits in this session`. Use Stoa's existing `DiffViewer` inside a `ChatMessage` or `ToolCallDisplay` card. Do not write to disk until the user taps approve.

**Why:** Claude Code's terminal has this (`y`/`n`/`d`/`e`), but its Desktop and VS Code extensions apply edits immediately or force one-by-one line approvals [[GH #38831](https://github.com/anthropics/claude-code/issues/38831)] [[GH #31888](https://github.com/anthropics/claude-code/issues/31888)]. A web UI is the ideal place to offer "review first, write once" because screen real estate and touch targets favor cards over TUI prompts. This directly addresses the #1 trust friction in agentic coding.

**Effort:** M — reuse `DiffViewer/UnifiedDiff` and `ToolCallDisplay`; add an approval state machine to the session backend message flow.

**Stoa area:** `components/ToolCallDisplay.tsx`, `components/DiffViewer/`, `components/ChatMessage.tsx`, session backend message parsing.

**Sources:**

- [Claude Code Diff Review shortcuts (claudefa.st)](https://claudefa.st/blog/guide/mechanics/output-formatting)
- [GH #38831: Inline diff review in GUI before writes](https://github.com/anthropics/claude-code/issues/38831)
- [GH #31888: Batch diff review mode request](https://github.com/anthropics/claude-code/issues/31888)

---

### 2. Per-Hunk Accept / Reject in Diff Cards

**What:** Extend the diff card so each hunk has its own `Accept` / `Reject` toggle. Default to all-hunks-pending; rejecting one hunk leaves the rest queued. On mobile, use swipeable hunk rows or stacked chips.

**Why:** This is the most-upvoted missing UX vs. Cursor/GitHub Copilot. Users frequently agree with most of a change but want to discard one stray hunk; today they must accept all and revert manually or reject all and re-prompt [[GH #31395](https://github.com/anthropics/claude-code/issues/31395)] [[GH #61794](https://github.com/anthropics/claude-code/issues/61794)]. Stoa can leapfrog Claude Code here with a small, focused addition.

**Effort:** S — if hunks are already parsed by the diff component, add a selection state and partial-apply logic.

**Stoa area:** `components/DiffViewer/UnifiedDiff.tsx`, `components/SessionDiffModal.tsx`.

**Sources:**

- [GH #31395: Inline per-change diff approval UI](https://github.com/anthropics/claude-code/issues/31395)
- [GH #61794: VSCode extension per-hunk accept/reject](https://github.com/anthropics/claude-code/issues/61794)
- [Cursor vs Claude Code comparison (kilo.ai)](https://kilo.ai/compare/cursor-vs-claude-code)

---

### 3. "@" File/Context Mention Picker in the Composer

**What:** In `MessageInput.tsx`, trigger a fuzzy file picker when the user types `@`. Let them pick files, directories, MCP resources, or recent files. Render the selected items as removable chips above the input. Send the resolved paths/refs to the agent as explicit context.

**Why:** Claude Code's `@` syntax is one of its most praised context features: it removes copy-paste overhead, supports tab completion, and lets users point the agent precisely [[stevekinney.com](https://stevekinney.com/courses/ai-development/referencing-files-in-claude-code)] [[wmedia.es](https://wmedia.es/en/tips/claude-code-five-ways-right-context)]. Stoa already has file exploration UI; wiring an inline picker to the composer is a low-complexity, high-visibility win, especially on mobile where copy-paste is painful.

**Effort:** S — use existing `FilePicker`/`QuickSwitcher` logic; add a contenteditable/tokenizer layer to `MessageInput.tsx`.

**Stoa area:** `components/MessageInput.tsx`, `components/QuickSwitcher.tsx`, `components/FilePicker.tsx`.

**Sources:**

- [Referencing Files and Resources in Claude Code (stevekinney.com)](https://stevekinney.com/courses/ai-development/referencing-files-in-claude-code)
- [Five Ways to Give Claude Code the Right Context (wmedia.es)](https://wmedia.es/en/tips/claude-code-five-ways-right-context)
- [Claude Terminal feature list (inline @mentions)](https://github.com/Sterll/claude-terminal)

---

### 4. Persistent Session Status + Pending Approval Badges in Session List

**What:** In `SessionList`/`SessionCard`, show a small status badge per session: `Idle`, `Running`, `Needs Approval`, `Completed`, `Error`. When a session has a pending tool approval, surface a red dot / count in the sidebar. Tapping the session scrolls to the approval card.

**Why:** Claude Code Desktop and wrappers like Emacs Gravity / CC Pocket show that users want an "inbox" of pending actions across sessions [[github.com/gdanov/emacs-gravity](https://github.com/gdanov/emacs-gravity)] [[CC Pocket app store](https://spark.mwm.ai/us/apps/id6759188790)]. Stoa already has `VerdictInboxView`; a lighter, always-visible version in the session list reduces context switching and makes mobile monitoring viable. It also fixes Claude Code's mobile Remote Control problem of truncated command previews [[GH #37235](https://github.com/anthropics/claude-code/issues/37235)] by moving approvals into a full web UI.

**Effort:** S — derive status from existing websocket/session events; add badges to `SessionCard.tsx`.

**Stoa area:** `components/SessionList/`, `components/SessionCard.tsx`, `components/VerdictInboxView/`.

**Sources:**

- [Claude Code Desktop hands-on review (verygood.ventures)](https://verygood.ventures/blog/claude-code-desktop-hands-on-review/)
- [Emacs Gravity — Inbox feature](https://github.com/gdanov/emacs-gravity)
- [CC Pocket — batch approvals](https://spark.mwm.ai/us/apps/id6759188790)
- [GH #37235: Remote Control command truncation](https://github.com/anthropics/claude-code/issues/37235)

---

### 5. One-Touch Auto-Approve Toggle with Clear Scope

**What:** Add a sticky toggle in the session header: `Ask before edits` ↔ `Auto-accept edits` ↔ `Auto-accept edits + safe commands`. When auto-approve is active, show a persistent indicator (e.g., green dot + label) with a one-tap revert. Scope the decision per-session, not global.

**Why:** Claude Code's permission modes are powerful but hidden in `settings.json` (`default`, `auto`, `acceptEdits`, `bypassPermissions`) [[learnwithhasan.com](https://learnwithhasan.com/claude-code-guide/)]. Wrappers like Polpo and Claude Terminal surface `Approve / Approve All / Reject` as explicit buttons, and users love it [[github.com/pugliatechs/polpo](https://github.com/pugliatechs/polpo)] [[github.com/Sterll/claude-terminal](https://github.com/Sterll/claude-terminal)]. Stoa already has `AutoApproveBadge.tsx` and `AutoModeDialog.tsx`; making the mode a first-class, one-tap control removes a major source of click fatigue without sacrificing safety.

**Effort:** S — extend existing `AutoApproveBadge.tsx` with a toggle; persist per-session in backend settings.

**Stoa area:** `components/AutoApproveBadge.tsx`, `components/SessionHeader.tsx`, `components/AutoModeDialog.tsx`, session settings API.

**Sources:**

- [Claude Code permissions guide (learnwithhasan.com)](https://learnwithhasan.com/claude-code-guide/)
- [Polpo — Approve / Approve All / Reject](https://github.com/pugliatechs/polpo)
- [Claude Terminal — Permission cards](https://github.com/Sterll/claude-terminal)
- [OpenShrimp — layered permission model](https://github.com/yjwong/open-shrimp)

---

## Honorable Mentions (deeper effort, still KISS-shaped)

- **Collapsible thinking/tool cards:** Claude Code renders thinking blocks and tool calls as collapsible sections. Stoa's `ToolCallDisplay.tsx` is the right seam; just make it collapsible and stream-expanded by default for the latest tool.
- **Follow-up suggestion chips:** Claude Terminal shows context-aware suggestion chips after each response. Stoa could generate 2–3 quick-reply chips from the latest assistant message.
- **Mobile-optimized approval full-screen sheet:** For long bash commands, open a bottom sheet with scrollable command text, not a truncated banner [[GH #37235](https://github.com/anthropics/claude-code/issues/37235)].

---

## Summary

Stoa's web-first, mobile-first architecture gives it an edge over Claude Code's terminal-first UX for _review and control_ surfaces. The five wins above are small in scope, reuse existing components, and directly address the most common user complaints about agentic editing: trust, visibility, and context selection.

| #   | Win                                      | Effort | Stoa Area                                  |
| --- | ---------------------------------------- | ------ | ------------------------------------------ |
| 1   | Pre-write inline diff approval cards     | M      | `ToolCallDisplay`, `DiffViewer`, chat flow |
| 2   | Per-hunk accept/reject                   | S      | `DiffViewer/UnifiedDiff`                   |
| 3   | `@` context mention picker               | S      | `MessageInput`, `QuickSwitcher`            |
| 4   | Session status + pending approval badges | S      | `SessionList`, `SessionCard`               |
| 5   | One-tap auto-approve toggle              | S      | `AutoApproveBadge`, `SessionHeader`        |

---

## Area: command-palette

# Command-palette / quick-actions competitive research

**Scope:** Raycast, Alfred, VS Code, Linear, Notion, plus general command-palette UX patterns (Mobbin, UX Patterns).  
**Goal:** find small, KISS, high-value wins for Stoa’s existing `Cmd/Ctrl+K` QuickSwitcher and global quick actions.

## What competitors do (pattern summary)

| Pattern                               | What it looks like                                                                                                                                                                                | Source                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recent-first / history**            | VS Code’s Command Palette remembers recent commands and lets you cycle them with arrow keys; Alfred learns usage and prioritises results; UX Patterns calls out a “Recent-first palette” variant. | [VS Code Command Palette](https://stevekinney.com/courses/visual-studio-code/vscode-command-palette), [Alfred](https://www.alfredapp.com/), [UX Patterns](https://uxpatterns.dev/patterns/advanced/command-palette) |
| **Contextual commands**               | Linear’s command menu surfaces only actions applicable to the current view or selection and sits near the invoking element.                                                                       | [Linear changelog](https://linear.app/changelog/2019-10-07-contextual-command-menu)                                                                                                                                 |
| **Fallback / zero-result actions**    | Raycast shows configurable “fallback commands” when a query has no match (e.g. search Google, file search). Alfred also supports fallback web/Spotlight searches.                                 | [Raycast v0.40 changelog](https://www.raycast.com/changelog/windows/0-40), [Raycast settings](https://manual.raycast.com/settings), [Alfred](https://www.alfredapp.com/)                                            |
| **Keyboard shortcuts in the palette** | VS Code displays each command’s keybinding in the palette; Mobbin notes that Figma/Vercel/Intercom expose shortcuts inside the palette.                                                           | [Mobbin](https://mobbin.com/glossary/command-palette), [VS Code UI docs](https://code.visualstudio.com/docs/getstarted/userinterface)                                                                               |
| **Aliases / keywords**                | Raycast supports aliases and hotkeys per command; Alfred is built on hotkeys and custom keywords.                                                                                                 | [Raycast settings](https://manual.raycast.com/settings), [Alfred](https://www.alfredapp.com/)                                                                                                                       |
| **Slash commands**                    | Notion uses `/` to insert blocks; Slack uses `/` for quick actions. More chat-local than global, but shows the muscle-memory value of typed shortcuts.                                            | [Notion cheat sheet](https://ourcheatsheets.com/cheatsheet/notion)                                                                                                                                                  |
| **Grouped results with empty state**  | UX Patterns anatomy: grouped results, result items with hint text/shortcut, and an empty state that explains what to do.                                                                          | [UX Patterns](https://uxpatterns.dev/patterns/advanced/command-palette)                                                                                                                                             |

## 5 small, KISS wins for Stoa

### 1. Recent-first section in the QuickSwitcher

- **What:** When `Cmd/Ctrl+K` opens with an empty query, show a **Recent** group at the top: last attached sessions and last executed palette commands. When the user types, boost recent matches to the top of their group. Persist in `localStorage` (or at least in-memory for the session).
- **Why:** Power users repeatedly return to the same sessions/actions. VS Code command history and Alfred’s learned prioritisation both prove this cuts daily keystrokes.
- **Effort:** **S–M** (purely client-side; add a history store and a new render group).
- **Stoa area:** `components/QuickSwitcher.tsx`, `lib/quick-switcher-commands.ts`, new `lib/palette-history.ts`.
- **Sources:** [VS Code Command Palette history](https://stevekinney.com/courses/visual-studio-code/vscode-command-palette), [UX Patterns recent-first palette](https://uxpatterns.dev/patterns/advanced/command-palette), [Alfred prioritisation](https://www.alfredapp.com/).

### 2. Contextual “Suggested” commands

- **What:** Pass a small slice of current app state into the palette and prepend a **Suggested** group with context-aware actions:
  - Active session is running → **Stop session**
  - Active session is waiting/needs input → **Jump to session / Respond**
  - A pane is focused → **Toggle Git / Files / Shell**, **Split pane**
  - Currently in a fleet view → the relevant fleet command
- **Why:** Linear’s command menu only shows actions applicable to the current view/selection; contextual surfacing removes the need to remember command names.
- **Effort:** **M** (requires wiring `activeSessionStatus`, `focusedPaneId`, current view from `app/page.tsx` into `QuickSwitcher`).
- **Stoa area:** `components/QuickSwitcher.tsx`, `app/page.tsx`, `lib/quick-switcher-commands.ts`.
- **Sources:** [Linear contextual command menu](https://linear.app/changelog/2019-10-07-contextual-command-menu), [UX Patterns contextual palette](https://uxpatterns.dev/patterns/advanced/command-palette).

### 3. Fallback actions when nothing matches

- **What:** Replace the plain “No matches found” with recoverable actions:
  - **Search code for “query”** — switches to code-search mode.
  - **Start new session named “query”** — pre-fills the new-session dialog.
  - **Create project “query”** — when the query looks like a path/name and no project matches.
- **Why:** Raycast’s fallback commands turn dead-end queries into useful actions; a zero-result state should be a launch pad, not a wall.
- **Effort:** **S** (empty-state UI + injecting 1–3 synthetic commands based on the query).
- **Stoa area:** `components/QuickSwitcher.tsx` (empty-state branch), `lib/quick-switcher-commands.ts`.
- **Sources:** [Raycast fallback commands](https://www.raycast.com/changelog/windows/0-40), [Raycast settings](https://manual.raycast.com/settings), [UX Patterns empty state](https://uxpatterns.dev/patterns/advanced/command-palette).

### 4. Show global keybindings next to palette commands

- **What:** For every command in the palette that also exists in `NAV_KEYBINDINGS`, render its formatted chord on the right (e.g. `⌘⇧X` for Dispatch). Also enrich keywords so aliases like `dispatch`, `fleet`, `insight` still match.
- **Why:** VS Code and Raycast both expose shortcuts inside the palette; Mobbin notes this reduces cognitive load because users don’t have to memorise a separate shortcuts sheet.
- **Effort:** **S** (reuse `formatChord` from `lib/keybindings.ts`; pass the bindings array into `QuickSwitcher`).
- **Stoa area:** `components/QuickSwitcher.tsx`, `lib/keybindings.ts`, `app/page.tsx`.
- **Sources:** [Mobbin keyboard shortcuts in command palette](https://mobbin.com/glossary/command-palette), [VS Code UI docs](https://code.visualstudio.com/docs/getstarted/userinterface), [Raycast aliases/hotkeys](https://manual.raycast.com/settings).

### 5. Pin / star favorite sessions and commands

- **What:** Let the user pin/star a session or a command (keyboard affordance, e.g. `Cmd/Ctrl+P` when highlighted, or a right-click item). Pinned items stick at the very top of the palette, above recents. Persist in `localStorage`.
- **Why:** Alfred is built around hotkeys + custom keywords; Raycast lets users manage/reorder fallback commands. Giving users control over the top of the palette matches the same power-user need without requiring a full workflow engine.
- **Effort:** **M** (small UI affordance + storage + re-ranking logic; must not conflict with selection keyboard nav).
- **Stoa area:** `components/QuickSwitcher.tsx`, `lib/quick-switcher-commands.ts`, `lib/palette-history.ts`.
- **Sources:** [Alfred hotkeys/keywords](https://www.alfredapp.com/), [Raycast command management](https://manual.raycast.com/settings), [UX Patterns recent-first/custom grouping](https://uxpatterns.dev/patterns/advanced/command-palette).

## What to avoid

- **Don’t rebuild a workflow engine.** Alfred Workflows and Raycast Extensions are large ecosystems; Stoa only needs the small KISS patterns above.
- **Don’t add a second global shortcut.** `Cmd/Ctrl+K` is already the Stoa palette; keep it.
- **Don’t break the terminal focus guard.** Any palette shortcut must respect the existing `isEditableTarget`/`.xterm` guard in `lib/keybindings.ts`.
- **Don’t overload the default empty state.** Keep it to 1–3 high-probability fallbacks.

## Source list

1. Raycast fallback commands — https://www.raycast.com/changelog/windows/0-40
2. Raycast settings (hotkeys/aliases/fallback) — https://manual.raycast.com/settings
3. Alfred — https://www.alfredapp.com/
4. VS Code Command Palette (history + fuzzy search) — https://stevekinney.com/courses/visual-studio-code/vscode-command-palette
5. VS Code UI docs — https://code.visualstudio.com/docs/getstarted/userinterface
6. Linear contextual command menu — https://linear.app/changelog/2019-10-07-contextual-command-menu
7. Notion slash commands & shortcuts — https://ourcheatsheets.com/cheatsheet/notion
8. UX Patterns command palette — https://uxpatterns.dev/patterns/advanced/command-palette
9. Mobbin command palette glossary — https://mobbin.com/glossary/command-palette

---

## Area: copilot-workspace

# Competitor Research: GitHub Copilot Workspace / Copilot Edits UX

**Date:** 2026-06-14  
**Scope:** Planning and applying code changes — what Stoa's dispatch/plan and chat UI can borrow from Copilot Workspace (web) and Copilot Edits (VS Code).  
**Sources:** GitHub Next product pages, VS Code Copilot docs, Copilot Workspace user-manual changelog, Microsoft Build 2024 transcripts, third-party UX walkthroughs.

---

## Key UX Patterns Observed

| Pattern                                         | How Copilot Does It                                                                                                                                                                                                                                                                                                                                                                                       | Pain Point / Gap for Stoa                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Spec → plan → implement**                     | Copilot Workspace first generates an editable _specification_ (current vs. desired state), then an editable _plan_ (files + steps), then code. Every stage is editable before downstream work starts. [[GitHub Next](https://githubnext.com/projects/copilot-workspace/)] [[MS Build transcript](https://news.microsoft.com/wp-content/uploads/prod/2024/05/ScottGuthrie_transcript_KEY02_Build2024.pdf)] | Stoa's `PlanConsole` drops the original spec after proposing tasks, so reviewers lose ground truth and can't steer without starting over. |
| **Working set / context controls**              | Copilot Edits uses a "Working Set" of files; users add files via drag/drop, `#` mentions, or active editors. The set is always visible. [[VS Code Copilot Edits docs](https://code.visualstudio.com/docs/copilot/copilot-edits)]                                                                                                                                                                          | Stoa chat sends bare prompts with no visible context; the agent may edit wrong files because the user can't see or prune what's attached. |
| **Mode picker**                                 | VS Code chat has `Ask`, `Plan`, `Edit`, `Agent` modes; Copilot Workspace action bar has `Ask`, `Revise`, `Command`. The mode determines whether code is written, planned, or just explained. [[VS Code chat docs](https://code.visualstudio.com/docs/copilot/copilot-edits)] [[CW changelog](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)]      | Stoa chat has one implicit mode, forcing users to type guardrails like "don't edit anything yet."                                         |
| **Per-file progress + delta preview**           | While implementing, a progress bar appears under each file; existing files show the live delta as it is generated. [[CW changelog](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)]                                                                                                                                                                | Stoa shows generic spinners ("Planning…"), giving no sense of which file is being touched or how far along it is.                         |
| **Code review flow: accept/discard per file**   | Copilot Edits renders edits in-place and provides file-level `Accept` / `Discard` plus `Accept All` / `Discard All`. [[VS Code Copilot Edits docs](https://code.visualstudio.com/docs/copilot/copilot-edits)]                                                                                                                                                                                             | Stoa's `DiffViewer` has only a "viewed" tick; there is no per-file action to keep or revert changes.                                      |
| **Add manual edits to plan**                    | Manually edited files in Workspace get a `+` button in their header to one-click include them in the AI plan. [[CW changelog](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)]                                                                                                                                                                     | Stoa has no bridge between manual file edits and the active dispatch plan.                                                                |
| **New-step indicators + latest-changes filter** | Revisions add blue dots to new plan steps and a filter to show only the latest edits, making iteration easy to follow. [[CW changelog](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)]                                                                                                                                                            | Stoa plan revisions are not visually diffed; users must manually scan for what changed.                                                   |
| **Layout persistence**                          | Collapsed files / minimized timeline state is persisted per session. [[CW changelog](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)]                                                                                                                                                                                                              | Stoa does not persist UI layout state across reloads.                                                                                     |

---

## 5 Small, KISS, High-Value Wins for Stoa

### 1. Keep the Original Spec Visible as a Markdown Reference Card in `PlanConsole`

**What:** After clicking _Propose partition_, render the original spec in a collapsible, markdown-formatted card at the top of the review panel. Allow in-place editing of the spec and a _Regenerate_ button to re-run the planner from the updated text. Currently the spec input disappears and only task rows are shown.

**Why:** Copilot Workspace treats the specification as a first-class, steerable artifact separate from the plan. Users can correct the model's understanding of the current codebase or refine the desired state before any code is written. Stoa's `PlanConsole` drops the spec after proposing, so reviewers lose the ground truth and cannot iterate without discarding the whole plan.

**Effort:** S — UI-only; pass the spec back through the plan-poll response and add a collapsible card with a textarea.

**Stoa area:** `components/views/DispatchView/PlanConsole.tsx`, `data/dispatch/queries.ts`.

**Sources:**

- [GitHub Next — Copilot Workspace steerability](https://githubnext.com/projects/copilot-workspace/)
- [Microsoft Build 2024 — spec/plan/implementation transcript](https://news.microsoft.com/wp-content/uploads/prod/2024/05/ScottGuthrie_transcript_KEY02_Build2024.pdf)
- [Copilot Workspace changelog — markdown topic rendering](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)

---

### 2. Context Chip Bar (Working Set) Above the Chat Composer

**What:** Render removable chips above `MessageInput` for the context that will be sent with the next prompt: active file, `#file` mentions, URLs, terminal selection. Typing `#` opens a fuzzy file picker. The agent only sees the explicitly attached files unless the user adds more.

**Why:** Copilot Edits' _Working Set_ is the core control surface: users know exactly which files the model is allowed to edit and can add/drop files by drag-and-drop or `#` mentions. Stoa chat currently sends bare prompts with invisible context, which leads to wrong-file edits and forces users to over-specify in natural language.

**Effort:** S — state + UI; reuse existing file picker / `fileOpen` store and render chips.

**Stoa area:** `components/MessageInput.tsx`, `components/ChatView.tsx`, `stores/fileOpen.ts`.

**Sources:**

- [VS Code Copilot Edits — Working Set and Add Files](https://code.visualstudio.com/docs/copilot/copilot-edits)
- [Introducing Copilot Edits — designed for iteration across multiple files](https://code.visualstudio.com/blogs/2024/11/12/introducing-copilot-edits)
- [VS Code chat docs — `#` mentions for context](https://code.visualstudio.com/docs/copilot/copilot-edits)

---

### 3. Mode Selector in the Chat Composer (Ask / Edit / Plan)

**What:** Add a small dropdown on the left side of `MessageInput` to choose intent: **Ask** (answer only, no edits), **Edit** (targeted code change on the Working Set), or **Plan** (generate a structured implementation plan before writing code). Send the selected mode as a system hint with the prompt.

**Why:** Copilot Edits uses `Ask` / `Edit` / `Agent` modes; Copilot Workspace's action bar uses `Ask` / `Revise` / `Command`. A mode selector removes the need for users to type guardrails like "don't write code yet" or "just explain this," and lets Stoa route the request to the right backend behavior.

**Effort:** S–M — UI is small; backend can initially ignore the hint and later use it to route between chat, planner, and edit agents.

**Stoa area:** `components/MessageInput.tsx`, `components/ChatView.tsx`, WebSocket prompt protocol.

**Sources:**

- [VS Code Copilot Edits — Ask / Edit / Agent modes](https://code.visualstudio.com/docs/copilot/copilot-edits)
- [VS Code chat docs — Plan / Ask / Edit / Agent agents](https://code.visualstudio.com/docs/copilot/copilot-edits)
- [Copilot Workspace changelog — action-bar mode picker (`Ask` / `Revise` / `Command`)](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)

---

### 4. Per-File Progress Indicators During Plan Generation and Implementation

**What:** Replace the generic "Planning…" spinner with a labeled progress bar and step text (e.g., _Reading repo…_, _Partitioning tasks…_). During implementation, show a progress bar under each in-flight file and, where possible, a live delta preview of the changes being written.

**Why:** Copilot Workspace explicitly redesigned its progress indicator to show a bar underneath each file being implemented and to display the delta for existing files as they are edited. Generic spinners make long operations feel like black boxes and hide which file is currently being touched.

**Effort:** S — client-only if the backend exposes coarse progress steps; otherwise deterministic fake progress tied to poll status still improves perceived performance.

**Stoa area:** `components/views/DispatchView/PlanConsole.tsx`, dispatch polling UI, `components/DiffViewer/UnifiedDiff.tsx`.

**Sources:**

- [Copilot Workspace changelog — redesigned progress indicator for file implementation](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)

---

### 5. Per-File Accept / Discard in the Diff Viewer

**What:** Add `Accept` and `Discard` buttons to each file header in `DiffFileList` / `UnifiedDiff`. _Accept_ writes that file's changes to disk; _Discard_ reverts it. Add `Accept all` and `Discard all` at the top of the list. Complement the existing "viewed" tick rather than replacing it.

**Why:** Copilot Edits' core UX is a code-review flow where users accept or discard each AI-generated edit before it is finalized. Stoa's diff viewer only lets users mark files as "viewed"; it provides no action to keep or revert individual files, forcing users to accept or reject the entire session elsewhere.

**Effort:** M — UI is small, but it requires backend endpoints to apply or revert changes for a single file.

**Stoa area:** `components/DiffViewer/UnifiedDiff.tsx`, `components/DiffViewer/DiffFileList.tsx`, backend apply/revert API.

**Sources:**

- [VS Code Copilot Edits — Accept or discard edits](https://code.visualstudio.com/docs/copilot/copilot-edits)
- [Introducing Copilot Edits — code review flow and undo](https://code.visualstudio.com/blogs/2024/11/12/introducing-copilot-edits)
- [Xebia — Copilot Edits as a surgical refactoring tool](https://xebia.com/blog/smarter-refactoring-starts-with-github-copilot-edits/)

---

## Honorable Mentions (Slightly Larger or Lower-ROI)

- **One-click "Add to plan" for manually edited files.** Copilot Workspace puts a `+` button on file headers so user edits can be pulled back into the AI plan. Useful for Stoa's `FileExplorer` / editor, but requires dirty-file detection and plan/session association. [[CW changelog](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)]
- **Blue-dot "new plan step" indicators.** When a plan is revised, highlight newly added steps with a blue dot and offer a _Latest changes_ filter so users can focus on what just changed. [[CW changelog](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)]
- **Persist collapsed-file / minimized-timeline layout state per session.** Copilot Workspace persists UI layout so returning to a session feels continuous. [[CW changelog](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)]
- **Keyboard shortcuts for chat modes.** Copilot Workspace maps `?` → Ask, `>` → Revise, `$` → Command. Stoa could map similar shortcuts (e.g., `Ctrl+Shift+I` for chat, `?` for Ask mode). [[CW changelog](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)]

---

## Summary

The highest-leverage, lowest-effort Copilot ideas for Stoa are:

1. **Make the plan review grounded in the original spec** (#1) — closes the feedback loop in `PlanConsole` without backend changes.
2. **Make chat context explicit** (#2, #3) — Working Set chips and a mode selector turn Stoa chat from a black-box prompt into a steerable editing surface.
3. **Show progress and give file-level control** (#4, #5) — replace spinners with progress bars and let users accept/discard per file, matching Copilot Edits' code-review flow.

All five are small, self-contained, and map directly to existing Stoa components. None require changing the underlying agent architecture.

---

## Full Source List

- [GitHub Next — Copilot Workspace product page](https://githubnext.com/projects/copilot-workspace/)
- [GitHub Blog — Expanding access to the Copilot Workspace technical preview](https://github.blog/changelog/2024-12-30-expanding-access-to-the-github-copilot-workspace-technical-preview/)
- [VS Code Docs — Copilot Edits](https://code.visualstudio.com/docs/copilot/copilot-edits)
- [VS Code Blog — Introducing Copilot Edits (preview)](https://code.visualstudio.com/blogs/2024/11/12/introducing-copilot-edits)
- [VS Code Blog — Introducing Copilot agent mode (preview)](https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode)
- [Copilot Workspace User Manual — `changes.md`](https://raw.githubusercontent.com/githubnext/copilot-workspace-user-manual/refs/heads/main/changes.md)
- [Microsoft Build 2024 — Scott Guthrie keynote transcript](https://news.microsoft.com/wp-content/uploads/prod/2024/05/ScottGuthrie_transcript_KEY02_Build2024.pdf)
- [Xebia — Smarter Refactoring Starts with GitHub Copilot Edits](https://xebia.com/blog/smarter-refactoring-starts-with-github-copilot-edits/)

---

## Area: cursor

# Competitor UX Research: Cursor Composer / Agent Mode

**Scope:** Cursor’s chat, file-edit, context, and preview UX (Composer, Agent, Inline Edit, Chat).  
**Goal:** Identify 3–5 small, KISS, high-value wins for Stoa’s chat/session UI.  
**Sources:** public Cursor docs/guides, third-party comparisons, and Cursor community forums (see citations).

---

## Summary of Cursor’s relevant UX

Cursor layers three editing surfaces on top of a VS Code-style editor:

1. **Inline Edit (Cmd/Ctrl+K)** — single-file, shows a diff, writes only after accept.
2. **Chat (Cmd/Ctrl+L)** — read-only by default; can `@`-mention files, folders, symbols, docs, git diff, terminal output; has an **Apply** button on suggested code blocks.
3. **Composer / Agent (Cmd/Ctrl+I)** — multi-file edits with a unified diff review surface; Agent mode also runs terminal commands and iterates.

Key UX primitives Cursor uses everywhere:

- **Inline diff review** with Accept/Reject per hunk/file.
- **`@` context picker** for files, folders, symbols, docs, web, terminal, git diff, codebase.
- **Mode switcher** (Ask / Normal / Agent) so the user knows what the next prompt will do.
- **Checkpoint restore** chips in the chat timeline for quick rollback.
- **Inline terminal/output previews** embedded in the conversation.

Stoa already has strong pieces (proposal confirm cards, `SessionDiffModal`, `SnapshotTimeline`, `ContextMeter`, `ToolCallDisplay`). The wins below are small UI additions that close the biggest perception gaps without rebuilding the backend.

---

## Win 1 — Inline “Apply / Copy” on code blocks in chat

**What:** Render an action bar on top of every assistant code block in the session chat:

- **Apply** — write the snippet to a file the user picks (or to the file named in the ` ```path:... ` fence).
- **Copy** — copy the snippet to the clipboard.  
  This mirrors Cursor Chat’s “Apply” button that turns a suggestion into an Inline Edit.

**Why:** Today Stoa shows raw markdown code blocks; the user must copy/paste manually. One-click apply removes friction for the most common chat-to-code action and makes the session chat feel like an editor, not a read-only transcript.

**Effort:** **S** — pure UI. Extend the markdown renderer (`react-markdown` `components` prop) in `ChatMessage.tsx` and add a small copy/apply callback. No backend changes needed if apply routes through the existing file-write API.

**Stoa area:**

- `components/ChatMessage.tsx`
- `components/views/ChatView/index.tsx` (for the Ask-Stoa answer bubbles)

**Sources:**

- DeployHQ Cursor guide: Chat “doesn’t edit code by default. Press **Apply** on a code suggestion in the chat to turn it into an Inline Edit.” — https://www.deployhq.com/guides/cursor
- IntuitionLabs comparison: “you can drag & drop whole folders into the chat … and then apply code changes directly from chat.” — https://intuitionlabs.ai/pdfs/comparing-ai-coding-assistants-for-pharma-enterprise-development.pdf
- Cursor User Guide: “After the AI produces an inline suggestion, you’ll see a diff or preview … Nothing is applied until you confirm.” — https://github.com/dazzaji/Cursor_User_Guide

---

## Win 2 — `@` context picker in the composer

**What:** When the user types `@` in the chat input, show a small picker for project entities: files, folders, symbols, git diff, terminal output, and the whole project (`@codebase`). Selecting an entity inserts a styled pill into the textarea and adds that context to the next prompt.

**Why:** Cursor’s `@` mentions are one of its most praised UX patterns. They give users precise, discoverable scope control without memorizing paths or copy/pasting. For Stoa this is especially valuable because sessions often need the agent to look at specific files in the working directory.

**Effort:** **M** — needs a lightweight mention parser, an entity search endpoint (reuse existing file-tree / code-search data), and a pill UI. Start with just `@file` and `@folder`; expand later.

**Stoa area:**

- `components/MessageInput.tsx`
- `components/ChatView.tsx`
- `components/views/ChatView/index.tsx`
- Reuses `components/CodeSearch/CodeSearchResults.tsx` or `components/FilePicker.tsx` for entity search

**Sources:**

- DeployHQ Cursor guide `@` mention table (`@file:src/auth.ts`, `@folder:src/api`, `@diff`, `@terminal`, etc.). — https://www.deployhq.com/guides/cursor
- Cursor User Guide “Context Injection with @ Symbols”: typing `@` brings up a menu; arrow keys + Enter select. — https://github.com/dazzaji/Cursor_User_Guide
- TechRxiv survey: Cursor chat supports `@web`, images, and “manual mode confines AI alterations to explicitly @-mentioned files or symbols.” — https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.174681482.27435614

---

## Win 3 — Live terminal / tool output preview cards

**What:** Replace the current collapsible JSON `ToolCallDisplay` with a richer preview card for terminal-like tools: show the streamed command output in a `<pre>` with ANSI-ish styling, a running spinner while active, and quick actions (“Run again”, “Copy output”, “Send output as context”). Non-terminal tools can keep the existing Input/Output details but styled to match.

**Why:** Cursor’s Agent keeps terminal output visible in the conversation so the user can follow along. Stoa’s current `ToolCallDisplay` dumps raw JSON, which forces the user to mentally parse the agent’s progress and loses the “pair programming” feel.

**Effort:** **S–M** — mostly presentational. The WebSocket already streams `tool_start` / `tool_end`; we just need better rendering of the `output` field and a few helper buttons.

**Stoa area:**

- `components/ToolCallDisplay.tsx`
- `components/ChatView.tsx`

**Sources:**

- DeployHQ Cursor guide: Agent mode “runs terminal commands, reads the output, reacts to errors, and iterates until tests pass.” — https://www.deployhq.com/guides/cursor
- Cursor forum on “Use Preview Box”: terminal result can be “previewed in the prompt window first.” — https://forum.cursor.com/t/use-preview-box-for-terminal-k/54311
- Tutorial: Composer agent with Chrome DevTools, where console/network output is fed back into Composer context. — https://forum.cursor.com/t/tutorial-supercharged-cursor-composer-agent-with-chrome-devtools/51394

---

## Win 4 — Mode switcher chip above the composer

**What:** Add a segmented toggle or dropdown above the chat input: **Ask** (read-only answers), **Edit** (suggestions require Apply), **Agent** (auto-runs tools/commands). The selected mode is persisted per session and shown in the header. This is Cursor Composer’s Normal / Agent / Ask switch adapted to Stoa.

**Why:** Stoa already has an `AutoApproveBadge` and a confirm-card flow, but the user has to infer the session’s behavior from scattered signals. A visible mode chip sets expectations before the user types and reduces accidental auto-runs.

**Effort:** **S** — UI-only. Map the modes to existing flags (`auto_approve`, proposal confirmation) and expose them as a radio group. No new agent capabilities required.

**Stoa area:**

- `components/ChatView.tsx`
- `components/views/ChatView/index.tsx`
- `components/AutoApproveBadge.tsx` (reuse icon/tooltip pattern)
- `components/SessionHeader.tsx`

**Sources:**

- VibeCoding guide: Composer has three modes (Ask / Normal / Agent) cycled with `Shift+Tab`; mode badge is in the top-right. — https://vibecoding.app/blog/mastering-cursor-composer
- AppyPie comparison: “Cursor … has a mode switcher (Chat / Edit / Agent) in the input box.” — https://www.appypie.io/blog/cursor-vs-windsurf-ai-code-editor
- DeployHQ Cursor guide: difference between Chat (questions), Composer (multi-file edits), and Agent (autonomous terminal/commands). — https://www.deployhq.com/guides/cursor

---

## Win 5 — Per-turn checkpoint restore chip in chat

**What:** After each assistant turn that changed files, show a small chip or menu item in the message: “Restore to before this turn”. Clicking it opens the existing `SnapshotTimeline` pre-filtered to that turn, or directly calls the restore API with a confirmation toast. Cursor exposes this as the “Restore Checkpoint” button on previous requests.

**Why:** Stoa already snapshots the working tree (`SnapshotTimeline`, `useSessionSnapshots`), but the feature is buried in a full-screen modal. Surfacing rollback next to the message that caused the change makes it discoverable and gives users the “oh-crap button” Cursor users rely on.

**Effort:** **S** — wires existing hooks (`useSessionSnapshots`, `useRestoreSnapshot`) into the message renderer. The heavy lifting (snapshotting, diffing, restoring) already exists.

**Stoa area:**

- `components/ChatView.tsx`
- `components/SnapshotTimeline.tsx` (reuse restore flow)
- `hooks/useSessionSnapshots.ts`

**Sources:**

- Steve Kinney course: “Click the ‘Restore Checkpoint’ button on previous requests in the chat interface … resets all files to that point in the conversation.” — https://stevekinney.com/courses/ai-development/cursor-checkpoints
- EastonDev blog: recommends creating a Cursor checkpoint before a task so you can “rollback to checkpoint state with one click.” — https://eastondev.com/blog/en/posts/dev/20260110-cursor-agent-large-projects/
- Cursor forum: “the recommended way to revert agent changes is through Checkpoints … restore icon next to the checkpoint in the chat panel.” — https://forum.cursor.com/t/cursor-keeps-forcing-auto-accept-when-in-agent-mode/157627

---

## Not recommended (too big or low ROI)

- **Native inline diff editor inside the file editor** — high effort; Stoa’s `DiffViewer` + `SessionDiffModal` already covers review. Do after the chat-level diff chips land.
- **Full codebase vector indexing** — large infrastructure project; `@file`/`@folder` mentions give 80 % of the value for much less work.
- **Background / parallel agents** — out of scope for a chat/session UX pass; touches orchestration, worktrees, and billing.

---

## Conclusion

The five wins above are small, mostly UI-only changes that borrow Cursor’s most recognizable primitives. They fit Stoa’s existing architecture, respect the confirm-before-act safety model, and address the biggest UX gaps users notice when comparing agent-first editors.

---

## Area: deployment-ux

# Competitor research: small KISS wins for Stoa deployment/dashboard UX

**Scope:** Vercel, Railway, GitHub Actions dashboard/run UX patterns that apply to Stoa’s Dev Servers, Pipelines, and Fleet Board.  
**Goal:** 3–5 small, low-complexity, high-value improvements. Each entry = _what_, _why_, _effort_, _Stoa area_, and a cited source.

---

## 1. Dev Servers — “Live URL first” card header

**What:**  
Promote the running dev-server’s `localhost:<port>` URL to the top of the card as a large, always-visible, tappable badge. Add a one-tap **Copy URL** button and show the server’s uptime/age (e.g. “running 12m”). For stopped servers, keep the port visible but muted.

**Why:**  
Vercel’s Project Overview surfaces the latest production deployment URL, build time, and commit details above the fold so users can open or share a live link in one click[^vercel-deployments]. Stoa users repeatedly open/copy the same localhost URLs, and the current copy button is disabled unless the server is running. Showing uptime also removes the “is this the new process?” ambiguity after a restart.

**Effort:** S — UI-only; reuse existing `primaryPort` parsing and `useDevServersQuery` polling.

**Stoa area:** `components/DevServers/DevServerCard.tsx`, `DevServersSection.tsx`.

**Source:** Vercel, _Deploying to Vercel_ — Project Overview shows latest production deployment, generated URL, build time, and logs[^vercel-deployments].

---

## 2. Pipelines — Visual step-progress bar on run cards

**What:**  
Replace the plain `done/steps` text in `RunsList` and at the top of `RunDetail` with a thin segmented progress bar colored by step status: pending, running, succeeded, failed, skipped. Keep the numeric label next to it.

**Why:**  
GitHub Actions renders run status as a visual job graph and auto-expands failed steps so a user can scan progress without reading text[^github-logs]. A progress bar gives Stoa’s mobile-first pipeline view the same at-a-glance readability — users instantly see how much work is left and whether anything is red.

**Effort:** S — pure render component using existing `run.steps` and `STEP_STATUS_META` from `shared.tsx`.

**Stoa area:** `components/views/WorkflowsView/RunsList.tsx`, `RunDetail.tsx`, `shared.tsx`.

**Source:** GitHub Docs, _Using workflow run logs_ — workflow run page shows in-progress/complete status, failed steps expanded, and per-step timing[^github-logs].

---

## 3. Pipelines — One-click Re-run / Cancel from the run list

**What:**  
Add action buttons on each `RunsList` row and in the `RunDetail` header:

- **Cancel** while `status === "running"`.
- **Re-run** once a run is terminal (succeeded/failed/partial), re-posting the same `PipelineSpec` + conductor session.

**Why:**  
Railway exposes Cancel, Redeploy, and Rollback directly from each deployment row[^railway-actions], and GitHub Actions lets users re-run failed jobs without rebuilding the workflow. Stoa pipelines currently dead-end at “done” — retrying a failed agent workflow means manually reconstructing the spec. One-click retry removes that friction and fits the “run/worker result handoff” pattern Stoa already ships.

**Effort:** M — needs small backend endpoints (`/api/pipelines/:id/cancel`, `/api/pipelines/:id/restart`) plus mutations in `data/pipelines/queries.ts`; UI is trivial.

**Stoa area:** `components/views/WorkflowsView/RunsList.tsx`, `RunDetail.tsx`; `data/pipelines/queries.ts`; `lib/pipeline` executor.

**Source:** Railway Docs, _Deployment Actions_ — Cancel/Redeploy/Rollback from the deployment row menu[^railway-actions].

---

## 4. Fleet Board — “Needs me” filter toggle

**What:**  
Add a header toggle in `FleetBoardView` to filter the board to only cards where `cardNeedsMe(c)` is true. When active, lanes with no matching cards collapse to `—`. Leave the existing count pill intact.

**Why:**  
GitHub Actions and Vercel both let users filter noisy run/deployment lists by status (e.g., failed, in-progress)[^vercel-rollback][^github-logs]. Stoa already computes the exact same `needsMe` predicate for the nav badge, so exposing it as a board filter aligns the badge count with the board content and lets users triage attention items on mobile without scrolling.

**Effort:** S — client-side filter using existing `needsMeCount` and `cardNeedsMe`; no new data dependencies.

**Stoa area:** `components/views/FleetBoardView/index.tsx`, `lib/fleet-board/lanes.ts`.

**Sources:**

- Vercel Docs, _Performing an Instant Rollback_ — recommends filtering deployments list by branch/status to find rollback targets[^vercel-rollback].
- GitHub Docs, _Using workflow run logs_ — workflow run list supports status/event filters[^github-logs].

---

## 5. Dev Servers + Pipelines — Severity-highlighted, searchable log snippets

**What:**  
Upgrade `ServerLogsModal` with a search box and colored severity tokens (error / warn / info), and add a per-step **View logs** expander in `RunDetail` that renders the last ~50 lines of the worker session using the same log component.

**Why:**  
Railway’s Log Explorer supports filtering by service, level, and custom attributes[^railway-logs], and GitHub Actions groups logs into collapsible sections with `::error`/`::warning` annotations[^github-commands]. Today Stoa pipeline steps only show status; to see why a step failed the user must jump into the session. A log snippet with error highlighting collapses that debug loop.

**Effort:** M — logs endpoint already exists for dev servers; reuse it for pipeline step session logs (or add `GET /api/sessions/:id/logs`). Search/filter is UI-only.

**Stoa area:** `components/DevServers/ServerLogsModal.tsx`, `components/views/WorkflowsView/RunDetail.tsx`; sessions or pipeline API.

**Sources:**

- Railway Docs, _Logs_ — Build/Deploy panel and Log Explorer with filtering/search across services[^railway-logs].
- GitHub Docs, _Workflow commands for GitHub Actions_ — `::error`, `::warning`, `::group` log annotations and collapsible groups[^github-commands].

---

## Quick prioritization

| #   | Win                               | Area                    | Effort | Highest value for          |
| --- | --------------------------------- | ----------------------- | ------ | -------------------------- |
| 1   | Live URL first                    | Dev Servers             | S      | Daily local dev loop       |
| 2   | Visual progress bar               | Pipelines               | S      | Mobile pipeline monitoring |
| 3   | Re-run / Cancel                   | Pipelines               | M      | Failed-run recovery        |
| 4   | “Needs me” filter                 | Fleet Board             | S      | Triage/dispatch workflow   |
| 5   | Searchable, severity-colored logs | Dev Servers + Pipelines | M      | Incident debugging         |

---

## Sources

[^vercel-deployments]: Vercel, _Deploying to Vercel_ (2026-02-26). https://vercel.com/docs/deployments

[^vercel-rollback]: Vercel, _Performing an Instant Rollback on a Deployment_ (2026-02-26). https://vercel.com/docs/instant-rollback

[^railway-actions]: Railway Docs, _Deployment Actions_ (2026-06-02). https://docs.railway.com/deployments/deployment-actions

[^railway-logs]: Railway Docs, _Logs_ (2026-06-12). https://docs.railway.com/observability/logs

[^github-logs]: GitHub Docs, _Using workflow run logs_ (2022-11-28). https://docs.github.com/actions/managing-workflow-runs/using-workflow-run-logs

[^github-commands]: GitHub Docs, _Workflow commands for GitHub Actions_. https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions

---

## Area: error-ux

# Error / diagnostic UX competitive research

**Scope:** error badges, notifications, and the Verdict Inbox in Stoa.  
**Competitors studied:** Sentry, Datadog, Vercel, GitHub Actions.  
**Goal:** find small, KISS, high-value UX wins that Stoa can ship quickly.

---

## Competitor patterns that matter

### Sentry — issue status + subscription model

- Issues carry **one primary status at a time** (`New`, `Ongoing`, `Escalating`, `Regressed`, `Archived`, `Resolved`) plus a `substatus` for nuance (e.g. a resolved issue that comes back is `Regressed`).
- Users **subscribe to individual issues** by clicking a bell icon; state-change notifications (resolved, regressed, assigned) go only to subscribers/participants.
- Workflow notifications are tied to real triage actions, not just "an error happened".

Sources:

- Sentry, "Issue Status" — https://docs.sentry.io/product/issues/states-triage/
- Sentry, "Sentry Notifications" — https://docs.sentry.io/product/notifications/

### Datadog — issue states, muting, and rich alert context

- Error Tracking uses issue states (`For Review`, `Reviewed`, `Ignored`, `Resolved`). Marking an issue **`Ignored` automatically mutes it from monitor notifications**.
- Alert notifications can include **triggering tags in the title** and structured variables such as `error.message`, `error.file`, `error.stack`, and issue category.
- Severity is surfaced with **color-coded badges** so on-call engineers can prioritize at a glance.

Sources:

- Datadog, "Error Tracking Monitors" — https://docs.datadoghq.com/tracing/error_tracking/monitors/
- Datadog, "Error Tracking" product page — https://www.datadoghq.com/error-tracking/
- Datadog + OpenAI Codex CLI blog (color-coded severity badges) — https://www.datadoghq.com/blog/openai-datadog-ai-devops-agent/

### Vercel — failure summary and scannable build logs

- Failed/canceled builds show **clear error feedback directly on the deployment details page**, not just inside raw logs.
- Build logs are **color-coded** (red errors, yellow warnings) and for failed builds they **auto-filter to errors**.
- Individual log lines are **deep-linkable** via `#L6` anchors; missing-log failures show an overlay with the error message.

Sources:

- Vercel, "Troubleshooting Build Errors" — https://vercel.com/docs/deployments/troubleshoot-a-build
- Vercel, "Accessing Build Logs" — https://vercel.com/docs/deployments/logs
- Vercel Changelog, "Improved error messages for failed or canceled builds" — https://vercel.com/changelog/improved-error-messages-for-failed-or-canceled-builds
- Vercel Changelog, "Deployment logs filtering now available" — https://vercel.com/changelog/deployment-logs-filtering-now-available

### GitHub Actions — status badges and opt-in failure notifications

- Workflow runs expose a **status badge** (`/badge.svg`) with optional `branch` and `event` filters.
- Notifications include the run status (success, failed, neutral, canceled) and users can choose to receive them **only when a run has failed**.
- Annotations show errors/warnings tied to file/line in the PR diff.

Sources:

- GitHub Docs, "Adding a workflow status badge" — https://docs.github.com/actions/managing-workflow-runs/adding-a-workflow-status-badge
- GitHub Docs, "Notifications for workflow runs" — https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs

---

## Where these patterns fit in Stoa

Stoa already has most of the primitives:

- **Badges:** `AutoApproveBadge`, `SessionCard` status indicator, PR/rate-limit badges, `STATUS_META` in the dispatch board, verify badges, lens badges in `InboxCard`.
- **Notifications:** `NotificationSettings` with per-event toggles (waiting/error/completed), sound toggle, browser push, and a waiting-sessions list.
- **Verdict Inbox:** `VerdictInboxView` + `InboxCard` with segmented tabs (All / Needs me / In review / Approved), expandable critic findings, verify output, and merge/dismiss/retry actions.
- **Dispatch diagnostics:** `InFlightBoard` shows per-status cards with verify output and retry/dismiss actions.

The wins below are small UI/notification-layer changes that reuse the existing data.

---

## Recommended wins

### 1. One primary status badge + a sub-status chip

**What:** In `VerdictInboxView` and `InFlightBoard`, render **one primary status badge** per row (e.g. `Failed`, `In review`, `Approved`, `Merged`) and a small **secondary chip** for nuance (e.g. `verify failed`, `changes requested`, `round 2`, `stuck`). Keep the existing color palette so it still reads identically across surfaces.

**Why:** Sentry forces a single status at a time and uses `substatus` for detail; Datadog uses `For Review` / `Reviewed` / `Ignored` / `Resolved` with muting rules. A single primary badge reduces scanning load, while the chip preserves the useful detail that Stoa already computes (`verifyStatus`, `reviewDecision`, `fixRounds`).

**Effort:** S  
**Stoa area:** `VerdictInboxView`, `InFlightBoard`, error badges.

---

### 2. Auto-expand verification output and jump to the first error

**What:** When a row's `verifyStatus` is `fail` or `error`, automatically expand the verification output block, colorize lines containing `error` / `FAIL` / `failed` in red, and add a **"Jump to first error"** button. If `verifyOutput` is empty, show a compact overlay with the server error reason instead of a blank panel.

**Why:** Vercel color-codes build logs and **auto-filters to errors on failed builds**; it also surfaces a summary when logs are unavailable. Today Stoa shows the raw tail in a `<pre>` block, so users must manually hunt for the failing line.

**Effort:** S–M  
**Stoa area:** `VerdictInboxView/InboxCard`, `InFlightBoard` diagnostics.

---

### 3. Per-item watch / mute controls in the Verdict Inbox

**What:** Add a **bell icon** to each `InboxCard` to subscribe/unsubscribe to that item's updates, plus a **"Mute"** quick action that suppresses notifications for that item until its state changes or the user unmutes it. Muted rows can still appear in the list but are de-emphasized.

**Why:** Sentry lets users subscribe to individual issues via the bell; Datadog's `Ignored` state mutes monitor notifications. Stoa's notifications are currently global (`waiting` / `error` / `completed`), so a noisy worker can drown out the items a user actually cares about.

**Effort:** S–M (needs a small preference or local-storage flag; no schema change if kept client-side).  
**Stoa area:** `VerdictInboxView`, `NotificationSettings`.

---

### 4. Rich error notifications with context and deep links

**What:** When Stoa sends an error/failure notification, include structured context: repo, failing lens (`correctness` / `conventions` / `simplicity`), verify status, fix round, and a **deep link** to the exact `InboxCard` or session. For web push, add action buttons: **Open**, **Retry**, **Dismiss**.

**Why:** Datadog Error Tracking notifications include `error.message`, `error.file`, triggering tags, and issue category; GitHub Actions notifications include the run status; Vercel sends failure notifications to the deployment creator. A notification that only says "an error occurred" forces the user to open the app and hunt for the item.

**Effort:** S–M  
**Stoa area:** Notifications (toast, web push, `lib/notifications`).

---

### 5. "Notify only on failure" toggle + error count on the bell

**What:** In `NotificationSettings`, add an option to **only notify when a session/dispatch transitions to `error`/`failed`** (not on every error event). Also show a small **error count badge** on the notification bell for failed/stuck inbox items, mirroring the existing waiting-count badge.

**Why:** GitHub Actions lets users limit notifications to failed runs. Stoa already shows a waiting count on the bell; extending that to failures makes real problems visible without turning every error toast into noise.

**Effort:** S  
**Stoa area:** `NotificationSettings`, notification bell.

---

## Honorable mention (slightly larger)

- **GitHub-style annotations in findings:** If a critic finding mentions a file path and line, render it as a clickable link that opens the file at that line in `SessionDiffModal` or the active session. This mirrors GitHub Actions annotations but requires parsing findings text, so it is a M effort.

---

## Sources

1. Sentry — Issue Status: https://docs.sentry.io/product/issues/states-triage/
2. Sentry — Notifications: https://docs.sentry.io/product/notifications/
3. Datadog — Error Tracking Monitors: https://docs.datadoghq.com/tracing/error_tracking/monitors/
4. Datadog — Error Tracking: https://www.datadoghq.com/error-tracking/
5. Datadog + OpenAI Codex CLI (severity badges): https://www.datadoghq.com/blog/openai-datadog-ai-devops-agent/
6. Vercel — Troubleshooting Build Errors: https://vercel.com/docs/deployments/troubleshoot-a-build
7. Vercel — Accessing Build Logs: https://vercel.com/docs/deployments/logs
8. Vercel Changelog — Improved error messages for failed/canceled builds: https://vercel.com/changelog/improved-error-messages-for-failed-or-canceled-builds
9. Vercel Changelog — Deployment logs filtering: https://vercel.com/changelog/deployment-logs-filtering-now-available
10. GitHub Docs — Workflow status badge: https://docs.github.com/actions/managing-workflow-runs/adding-a-workflow-status-badge
11. GitHub Docs — Notifications for workflow runs: https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs

---

## Area: make-zapier

# Competitive UX Research: Make.com & Zapier Visual Automation Builders

**Goal:** Identify small, KISS, high-value usability wins for Stoa's Workflow Builder (Visual builder tab in `components/views/WorkflowsView/`).

**Scope:** Analyzed Make.com's scenario editor / canvas and Zapier's Zap editor / Canvas product. Sources are public help docs, product blogs, and recent (2025-2026) third-party comparisons.

---

## What the competitors do that Stoa doesn't yet

| Pattern                          | Make.com                                                                                       | Zapier                                                                   | Stoa today                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Undo/redo**                    | Toolbar + `Ctrl/Cmd+Z`, `Ctrl/Cmd+Y` for canvas edits (add/move/link/configure modules) [1][2] | Less central (linear editor), but undo exists in form fields             | None — an accidental delete or drag requires manual reversal             |
| **Dynamic field / token picker** | Inline mapping panel shows output bundles from upstream modules                                | Field picker inserts variables from previous Zap steps [3][4]            | Users must type `{{steps.<id>.output}}` by hand in the Task textarea     |
| **Node context menu**            | Right-click a module → Rename, Clone, Delete, Run this module once [5][6]                      | Step-level "…" menu for duplicate/delete                                 | No node-level menu; delete is only in the bottom edit panel              |
| **Snap-to-grid / auto-align**    | "Auto-align" button snaps modules to a clean grid; drag snaps [7]                              | Canvas has align/distribute in Canvas                                    | Tidy layout re-seeds topological columns but doesn't snap while dragging |
| **Run status on canvas**         | Scenario History highlights the execution path on the diagram; replay from a module [8][9]     | Zapier Canvas links diagrams to live Zaps; editor shows step test status | Runs list is separate; canvas doesn't show which step failed/succeeded   |

---

## Recommended wins (3–5)

### 1. Add an undo/redo stack for canvas edits

- **What:** Keep a lightweight in-memory history of `BuilderDoc` changes. Add toolbar `↶ / ↷` buttons and standard shortcuts (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y`). Cover add step, delete step, move node, connect, disconnect, rename, and edit-panel field changes.
- **Why:** Make.com explicitly shipped this as a top request because users constantly experiment, mis-drag, or delete the wrong node [1][2]. It is the fastest way to make the canvas feel safe and "professional." Stoa's current builder is already pure-state (`doc`/`setDoc`), so a stack is a thin wrapper.
- **Effort:** S
- **Stoa area:** `WorkflowBuilder.tsx` state + `PipelineCanvas.tsx` keyboard handling.
- **Sources:** [1] Make Help Center — _Undo and redo scenario changes_; [2] Make community update — _Undo & Redo_.

### 2. Inline token picker for upstream step outputs

- **What:** In the **Task** textarea (and later Exit criteria), add a small button or `/` mention menu that inserts `{{steps.<id>.output}}` for every upstream step. Show the step's `name ?? id` in the menu and filter out steps that would create a cycle.
- **Why:** Zapier's core UX advantage is that users never memorize variable syntax — they pick fields from a dropdown [3][4]. Stoa currently forces users to remember the exact `steps.<id>.output` shape, which is the #1 place a new user will produce an invalid spec.
- **Effort:** S
- **Stoa area:** `WorkflowBuilder.tsx` edit panel (Task `Textarea`).
- **Sources:** [3] Zapier Platform docs — _Dynamic Dropdowns / field mapping_; [4] Autonoly comparison — _Zapier field mapping was automatic_.

### 3. Node context menu: Duplicate, Rename, Delete

- **What:** Right-click (desktop) or long-press (mobile/touch) a canvas node to open a menu with **Duplicate**, **Rename**, and **Delete**. Duplicate creates a copy with a unique id, same agent/task/exitCriteria, and no dependencies. Rename focuses the step-id field in the edit panel.
- **Why:** Make.com users rely heavily on right-click → Clone to build repetitive logic [5][6]. Stoa's delete action is buried at the bottom of the edit form; duplicating a step is impossible without manually re-creating it. A context menu matches OS conventions and avoids extra scrolling on mobile.
- **Effort:** S–M
- **Stoa area:** `PipelineCanvas.tsx` (menu trigger) + `lib/pipeline/builder-model.ts` (`duplicateStep`).
- **Sources:** [5] Make Help Center — _Clone a scenario_; [6] Make community — _right-click → Run this module once / clone_.

### 4. Snap-to-grid while dragging + collision-aware Tidy

- **What:** While dragging a node, snap `x`/`y` to a small grid (e.g. 8 px or 16 px). Extend **Tidy layout** so nodes within the same topological column don't overlap vertically when many nodes fan out.
- **Why:** Make.com's "Auto-align" is repeatedly called out as the tool users reach for once a scenario grows [7]. Stoa already has `relayout()`, but hand-dragged nodes can still pile on top of each other (the `handleAdd` cascade only offsets the first few). Grid snap is a one-line rounding change with outsized perceived polish.
- **Effort:** S
- **Stoa area:** `PipelineCanvas.tsx` drag math + `lib/pipeline/graph-layout.ts` row distribution.
- **Sources:** [7] Adbest Make guide — _Auto-align keeps the canvas readable_.

### 5. Run-status chips on canvas nodes

- **What:** When a workflow run is selected in the Runs panel, overlay each canvas node with a tiny status dot (pending/running/success/error). On error, pulse the failed node and scroll it into view. Keep it read-only; don't animate edges yet.
- **Why:** Make.com's Scenario History is praised because it visually highlights the execution path, making debugging "85% faster" [8][9]. Stoa already polls run details; mapping `step.id` → node is trivial. This is the smallest slice of that feature and immediately answers "which step broke?"
- **Effort:** M
- **Stoa area:** `PipelineCanvas.tsx` props (`runStatusByStepId`) + run-detail view wiring.
- **Sources:** [8] GrowwStacks — _Make.com Scenario History_; [9] Make Help Center — _Scenario history_.

---

## Priority order

1. **Token picker** — smallest change, biggest reduction in invalid specs.
2. **Undo/redo** — table-stakes for any canvas editor; makes the builder feel safe.
3. **Snap-to-grid** — cheap polish that prevents the messy-canvas problem.
4. **Node context menu** — follows OS convention and unlocks duplication.
5. **Run-status chips** — highest value for debugging, but slightly more wiring.

---

## Sources

1. Make Help Center, "Undo and redo scenario changes" — https://help.make.com/undo-and-redo-scenario-changes
2. Make community, "Feature Spotlight: Undo & Redo" — https://community.make.com/t/feature-spotlight-undo-redo/109438
3. Zapier Platform docs, "Add input fields to triggers and actions" — https://docs.zapier.com/integrations/build/add-fields
4. Autonoly, "n8n vs Zapier vs Make" — https://www.autonoly.com/blog/n8n-vs-zapier-vs-make
5. Make Help Center, "Clone a scenario" — https://help.make.com/clone-a-scenario
6. Make community, "Clone scenario to update module" — https://community.make.com/t/clone-scenario-to-update-module/16994
7. Adbest, "Make teaching — interface & auto-align" — https://adbest.com.tw/blog/make-guide/
8. GrowwStacks, "How to Turn On and Use Scenario History in Make.com" — https://growwstacks.com/blog/how-to-use-make-com-scenario-history/
9. Make Help Center, "Scenario history" — https://help.make.com/scenario-history

---

## Area: mobile-touch

# Competitor Research: Mobile / Touch UX Wins for Stoa

**Scope:** Deep-web review of mobile/touch UX patterns in Trello, Monday.com, Figma mobile, and Notion. Goal: identify small, KISS, high-value wins for Stoa's mobile-first canvas and UI.

**Date:** 2026-06-14

---

## TL;DR — Recommended Wins

| #   | Win                                                           | Effort | Stoa Area                        |
| --- | ------------------------------------------------------------- | ------ | -------------------------------- |
| 1   | **One-finger pan + two-finger pinch-zoom on the canvas**      | S      | Canvas / Pane viewport           |
| 2   | **Swipe-for-quick-actions on session cards**                  | S      | `SessionList` / session cards    |
| 3   | **Bottom quick-action toolbar for terminal/session controls** | S–M    | Terminal / active session UI     |
| 4   | **Contextual bottom sheet for menus/pickers**                 | S      | `NewSessionDialog`, action menus |
| 5   | **≥44 dp touch targets + thumb-zone primary actions**         | S      | Global UI / CSS                  |

---

## 1. Canvas: One-Finger Pan + Two-Finger Pinch-Zoom

**What**

- Single-finger drag → pan the session/terminal canvas.
- Two-finger pinch/spread → zoom in/out.
- Optional double-tap or reset button to return to fit-to-screen.

**Why**

- Figma's mobile app explicitly maps these exact gestures to canvas navigation: "Hold and drag your finger across your screen to pan around the file's canvas. Pinch the screen with two fingers to zoom in and out of the canvas" [Figma Help Center](https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app).
- This is the de-facto standard for canvas apps (Figma, Miro, Excalidraw) and removes the need for tiny zoom/pan controls.
- For Stoa, terminal output and code can be wide/dense; natural zoom/pan lets users inspect details without fighting the viewport.

**Effort:** S — gesture handlers are well-supported in browsers (`touchmove`, `pointermove`, `wheel` with `ctrlKey` detection). Existing canvas/Pane component can add a transform wrapper.

**Stoa Area:** Canvas / Pane viewport (`components/Pane/` or the main session canvas).

**Sources**

- Figma Help Center, "Guide to the Figma mobile app" — pan/zoom gestures.
- Tiger Abrodi, "How to Handle Trackpad Pinch-to-Zoom vs Two-Finger Scroll in JavaScript Canvas Apps" — describes the `ctrlKey` wheel-event convention used by Figma, Tldraw, and Excalidraw.

---

## 2. Session List: Swipe-for-Quick-Actions

**What**

- On session cards/items in the session list, allow horizontal swipe to reveal quick actions: **Close / Restart / Copy / Favorite**.
- Show a colored action background (e.g., red for close, blue for restart) and a subtle haptic/visual confirmation.
- Provide undo for destructive actions.

**Why**

- Trello mobile uses "swipe to archive" and "long-press for quick actions" as core mobile shortcuts [NextSprints Trello teardown](https://nextsprints.com/guide/trello-product-teardown-analysis).
- Reduces taps for high-frequency session management; users don't need to open a menu to close a finished agent run.
- Pattern is standard in iOS Mail, Gmail, and productivity apps.

**Effort:** S — can be implemented with touch/pointer events or a lightweight library; keep to a single axis to avoid conflict with vertical scrolling.

**Stoa Area:** `components/SessionList/` session cards.

**Sources**

- NextSprints, "Trello Product Teardown Analysis" — swipe to archive, long-press quick actions.
- Elaris Software, "Mobile App UX: Designing for Thumb Zones and Gestures" — swipe best practices and visual feedback.

---

## 3. Terminal / Session: Bottom Quick-Action Toolbar

**What**

- A persistent bottom toolbar (or floating bar above the keyboard) with the 3–5 most-used actions for the active session:
  - Send interrupt (`Ctrl+C`)
  - Clear output
  - Copy output
  - New prompt / quick command
  - Expand / fullscreen
- Keep icons labeled and ≥44 dp.

**Why**

- Notion mobile uses a "quick access toolbar for core actions" so users can work efficiently on small screens [Arounda, "Top Mobile Menu Design Inspirations"](https://arounda.agency/blog/top-mobile-menu-design-inspirations).
- Terminal users repeat interrupt/clear/copy constantly; placing these in the thumb zone dramatically reduces reach and friction.
- Aligns with the mobile UX "3-tap rule" for critical actions.

**Effort:** S–M — mostly UI layout; may need state wiring to the active session backend.

**Stoa Area:** Active terminal/session UI (`components/` terminal or pane chrome).

**Sources**

- Arounda, "Top Mobile Menu Design Inspirations" — Notion quick access toolbar.
- GitNexa, "Mobile UI/UX Best Practices Guide 2026" — bottom navigation dominance and 3-tap rule.

---

## 4. Menus: Contextual Bottom Sheets

**What**

- Replace top-bar dropdown menus on mobile with bottom sheets that slide up from the thumb zone.
- Apply to:
  - Provider / model picker in `NewSessionDialog`
  - Action overflow menus
  - Confirmation/filters
- Use large rows, clear labels, and swipe-down-to-dismiss.

**Why**

- Bottom sheets are the standard pattern for context actions on mobile: "Use bottom sheets for contextual actions related to the current screen" [RapidNative](https://www.rapidnative.com/blogs/mobile-app-design-best-practices).
- Dropdowns at the top of the screen are hard to reach one-handed and have small tap targets.
- Monday.com and Notion both lean on modal/persistent bottom sheets for actions on small screens.

**Effort:** S — can wrap existing menu content in a sheet component for mobile breakpoints.

**Stoa Area:** `components/NewSessionDialog/`, global action menus, pickers.

**Sources**

- RapidNative, "10 Mobile App Design Best Practices for Product Teams" — bottom sheets for contextual actions.
- Mobbin, "Bottom Sheet UI Design" — modal vs. non-modal bottom sheet guidance.
- Appy Pie, "App Navigation Patterns" — bottom sheets for action-focused flows.

---

## 5. Touch Targets: ≥44 dp + Thumb-Zone Primary Actions

**What**

- Audit all interactive elements to meet minimum touch targets: **44×44 pt (iOS) / 48×48 dp (Android)**.
- Increase spacing between adjacent targets to ≥8 dp (recommended 16 dp).
- Move primary actions (e.g., **New session**, **Send prompt**) to the bottom center or bottom-right thumb zone.

**Why**

- Apple HIG and Material Design both specify 44/48 dp minima; a study by Steven Hoober found ~49% of users operate phones one-handed, so thumb reach matters [Elaris](https://elaris.software/blog/mobile-ux-thumb-zones-2025/).
- Notion's buttons "clearly distinguish between primary actions (filled, prominent) and secondary actions" and maintain adequate touch targets [CleverX UX audit checklist](https://cleverx.com/blog/ux-audit-checklist-step-by-step-evaluation-template/).
- Prevents mis-taps on dense terminal controls and small picker items.

**Effort:** S — mostly CSS/component token updates; quick audit with dev tools.

**Stoa Area:** Global UI / design tokens / `components/` primitives.

**Sources**

- Elaris Software, "Mobile App UX: Designing for Thumb Zones and Gestures" — thumb-zone and target-size guidance.
- Support URL Generator, "Mobile App UI/UX Design Best Practices" — 44×44 pt / 48×48 dp target sizes.
- CleverX, "UX audit checklist" — Notion example on touch targets and primary/secondary distinction.

---

## What to Avoid

- **Hamburger menus for primary navigation.** Visible tab/bottom bars outperform hidden menus on engagement [Appy Pie](https://www.appypie.com/blog/app-navigation-patterns).
- **Complex custom gestures.** Stick to platform conventions (tap, long-press, swipe, pinch) and provide button alternatives [FasterCapital touch-gesture best practices](https://fastercapital.com/content/User-experience--UX---Touch-Gestures--Integrating-Touch-Gestures-into-Your-UX-Design.html).
- **Conflict with system gestures.** Avoid binding important actions to edge swipes reserved by iOS/Android.

---

## Suggested Implementation Order

1. Touch-target audit (#5) — quick win, improves everything.
2. Canvas pan/zoom (#1) — directly improves the core mobile-first canvas.
3. Bottom quick-action toolbar (#3) — high daily-use value for terminal workflows.
4. Swipe quick-actions on session cards (#2) — speeds up session management.
5. Bottom sheets for menus (#4) — polish and accessibility for pickers/menus.

---

## Area: modern-terminal

# Modern Terminal UX Research for Stoa Sessions

**Scope:** Competitive scan of Warp, Ghostty, Rio, and Tabby for small, KISS UX wins relevant to Stoa's terminal-session UI. Focus areas: input, output blocks, links, AI hints.

**Date:** 2026-06-14

---

## 1. Clickable Links & File Paths in Terminal Output

**What**
Auto-detect URLs and absolute/relative file paths in terminal output and render them as clickable anchors (OSC 8 hyperlinks where possible, fallback to hover-underline + click handler). For file paths, open in Stoa's file explorer or the OS default app; for URLs, open in the default browser.

**Why**
AI agents constantly emit URLs (docs, PRs, deployed previews) and file paths (errors, generated files). Today users must drag-select and copy. One-click navigation removes friction and reduces context-switching.

**Effort:** S

- Add a lightweight regex/linkifier pass over rendered terminal lines.
- Reuse Stoa's existing file-open / URL-open handlers.
- No backend or session-protocol changes.

**Stoa Area:** Terminal output renderer / `components/*` session view.

**Sources**

- Ghostty supports clickable hyperlinks and right-click URL highlighting [Ghostty 1.3.0 release notes](https://ghostty.org/docs/install/release-notes/1-3-0).
- WezTerm/Tabby comparisons note "hyperlinks" as a first-class feature [SourceForge comparison](https://sourceforge.net/software/compare/Rio-Terminal-vs-WezTerm/).
- Claude Code CLI added "clickable hyperlinks for file paths in tool output in terminals that support OSC 8" [CLI release notes](https://myysophia.github.io/cli-agent/), demonstrating direct value for AI-agent output.

---

## 2. Contextual Hint Bar Above the Terminal Input

**What**
A thin, unobtrusive message bar near the input that shows context-aware shortcuts:

- "`Ctrl+Enter` to send to agent" when text looks like natural language.
- "`Ctrl+Shift+Up` attach last failed command output" after a non-zero exit.
- "`Ctrl+Y` continue last conversation" when the last visible item is an agent response.

**Why**
Stoa's AI-vs-shell input model is powerful but hidden. Warp's Terminal/Agent modes rely on a hint bar for discoverability without cluttering the UI. A hint bar teaches shortcuts in-context and reduces accidental shell submissions.

**Effort:** S–M

- Track a few session-state flags (last exit code, last block type, current input heuristic).
- Render a dismissible inline hint component.
- Wire existing commands to the advertised shortcuts.

**Stoa Area:** Session input component / prompt bar.

**Sources**

- Warp docs detail Terminal Mode hints: default hint, "send to agent," error-block attachment, attached-context indicator, and continue-conversation hint [Warp Docs — Terminal and Agent modes](https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents/terminal-and-agent-modes/).
- Warp's auto-detection shows "(autodetected)" inline before submission, a pattern Stoa can mirror [same source].

---

## 3. Command/Output Blocks with Quick Actions

**What**
Group each shell command and its output into a visually distinct "block." On hover or focus, expose small actions: copy command, copy output, rerun, collapse/expand, and "attach to chat" (send the block as context to the active agent conversation).

**Why**
Long agent sessions become a wall of text. Blocks make it easy to find, reuse, and share specific command outputs. The "attach to chat" action is the Stoa equivalent of Warp's "attach block as agent context" — turning terminal history into prompt context.

**Effort:** M

- Requires parsing prompt boundaries (OSC 133 / shell integration or heuristic prompt detection).
- Add block chrome and action buttons.
- Implement "copy block" and "attach block to conversation" IPC/API calls.

**Stoa Area:** Terminal session view / block renderer.

**Sources**

- Warp's block interface lets users navigate, copy, share, and attach individual command blocks [Techdots — How To Use Warp AI Terminal](https://www.techdots.dev/blog/how-to-use-warp-ai-terminal-for-developer).
- Warp distinguishes Terminal blocks (global) from Agent-conversation blocks (scoped) [Warp Docs — Terminal and Agent modes](https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents/terminal-and-agent-modes/).
- Ghostty uses OSC 133 semantic prompts for "copy command output" and "jump-to-prompt" [Ghostty 1.3.0 release notes](https://ghostty.org/docs/install/release-notes/1-3-0), providing the boundary-detection hook.

---

## 4. Jump-to-Prompt & Copy-Last-Output Shortcuts

**What**
Keyboard shortcuts to navigate between command prompts in the scrollback and copy the output of the most recent command. Example bindings:

- `Ctrl+Shift+Up/Down` — jump to previous/next prompt.
- `Ctrl+Shift+C` (contextual) — copy output of the current/last command.

**Why**
Agent sessions generate many command/output pairs. Users currently scroll manually. Prompt-aware navigation is a high-frequency win for reviewing agent progress.

**Effort:** S–M

- Detect prompt lines via OSC 133 markers (preferred) or a configurable regex.
- Maintain an index of prompt row positions in the frontend.
- Add keybindings and a "copy output between prompts" utility.

**Stoa Area:** Terminal viewport / keybinding system.

**Sources**

- Ghostty 1.3 supports "jump-to-prompt or copy command output" powered by a more complete OSC 133 implementation [Ghostty 1.3.0 release notes](https://ghostty.org/docs/install/release-notes/1-3-0).
- Ghostty dotfiles feature "Advanced Prompt Navigation with `cmd+up/down`" [jlfguthrie/ghostty-terminal-dotfiles](https://github.com/jlfguthrie/ghostty-terminal-dotfiles).

---

## 5. Notification on Long-Running Command Completion

**What**
When a command runs longer than a configurable threshold (default 5–10 s) and the Stoa tab/window is not focused, show a browser notification and/or an in-app badge. Include the command name and exit status.

**Why**
AI agents kick off long builds, tests, and installs. Users switch tabs while waiting. A finish notification prevents them from losing momentum and missing failures.

**Effort:** S

- Track command start time and focus state.
- On command end, compare duration to threshold and focus status.
- Trigger the browser Notification API (with permission gate) or a Stoa toast.

**Stoa Area:** Session lifecycle / notification system.

**Sources**

- Ghostty 1.3 added `notify-on-command-finish`, `notify-on-command-finish-action`, and `notify-on-command-finish-after` configs for desktop notifications when a long command finishes, especially when unfocused [Ghostty 1.3.0 release notes](https://ghostty.org/docs/install/release-notes/1-3-0).
- Tabby lists "Progress detection" and "Notification on process completion" as terminal features [Eugeny/tabby README](https://github.com/Eugeny/tabby).

---

## Summary Table

| #   | Win                                      | Effort | Primary Stoa Area | Key Inspiration                          |
| --- | ---------------------------------------- | ------ | ----------------- | ---------------------------------------- |
| 1   | Clickable links & file paths in output   | S      | Terminal renderer | Ghostty, WezTerm, Tabby, Claude Code CLI |
| 2   | Contextual input hint bar                | S–M    | Input/prompt bar  | Warp Terminal/Agent modes                |
| 3   | Command/output blocks with quick actions | M      | Session view      | Warp blocks, Ghostty OSC 133             |
| 4   | Jump-to-prompt & copy-last-output        | S–M    | Terminal viewport | Ghostty OSC 133 navigation               |
| 5   | Notification on long command completion  | S      | Session lifecycle | Ghostty 1.3, Tabby                       |

---

## Other Terminals: What We Didn't Reuse

- **Rio:** Strong on GPU/WebGPU rendering, WASM plugin future, RetroArch shaders, and Sixel images [rioterm.com](https://rioterm.com/), [GitHub — raphamorim/rio](https://github.com/raphamorim/rio). These are renderer-level bets; lower immediate UX value for Stoa than the five wins above.
- **Tabby:** Pluggable SSH/serial client, split panes, Quake console, and progress detection [Eugeny/tabby README](https://github.com/Eugeny/tabby). The SSH and multiplexer layers are largely handled by Stoa's existing `SessionBackend`/`PtyTransport` seam; only the completion notification was directly applicable.

---

## Source URLs

1. https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents/terminal-and-agent-modes/
2. https://www.deployhq.com/guides/warp
3. https://www.techdots.dev/blog/how-to-use-warp-ai-terminal-for-developer
4. https://ghostty.org/docs/features
5. https://ghostty.org/docs/install/release-notes/1-3-0
6. https://github.com/jlfguthrie/ghostty-terminal-dotfiles
7. https://github.com/raphamorim/rio
8. https://rioterm.com/
9. https://github.com/Eugeny/tabby
10. https://sourceforge.net/software/compare/Rio-Terminal-vs-WezTerm/
11. https://myysophia.github.io/cli-agent/

---

## Area: n8n

# n8n Visual Workflow Builder UX — Competitive Research for Stoa

**Date:** 2026-06-14  
**Scope:** Surface small, KISS, high-value usability/performance/feature wins from n8n’s visual workflow builder that Stoa’s own workflow builder could borrow.  
**No Stoa source files were modified.**

---

## Executive Summary

n8n’s workflow editor has been iterated heavily around three themes that matter for agent-pipeline builders:

1. **Keep the user’s hands on the keyboard** (fast node insertion, auto-wiring, shortcuts).
2. **Make iteration cheap** (data pinning, partial execution, dirty-node indicators).
3. **Keep complex graphs readable** (sticky notes, zoom-to-fit, auto-layout, canvas annotations).

Stoa’s visual builder already has the core DAG, drag-to-wire, auto-layout (“Tidy layout”), and save/load/export. The biggest remaining gaps are the micro-interactions that turn a static canvas into a fast authoring environment. The five ideas below are intentionally small, mostly frontend/model changes, and map directly to Stoa’s existing components.

---

## Methodology

- Reviewed n8n’s official docs on the editor UI, keyboard shortcuts, sticky notes, data pinning, and manual/partial execution.
- Cross-released against third-party UX roundups of hidden n8n features.
- Mapped each idea to Stoa’s actual code areas: `components/views/WorkflowsView/WorkflowBuilder.tsx`, `PipelineCanvas.tsx`, `PipelineGraph.tsx`, `lib/pipeline/builder-model.ts`, and the pipeline engine/run views.

---

## 1. Keyboard-first node insertion with auto-connect

### What it is

In n8n, pressing `Tab` or `N` opens the node panel, and inserting a node while another node is selected automatically wires the new node after it. Stoa currently requires clicking **Add step** and then manually dragging a dependency if you want the new step wired.

A KISS version for Stoa:

- Add a global `Tab` or `Ctrl/Cmd + K` shortcut in the builder that creates a new step.
- If a step is currently selected, auto-add `dependsOn: [selectedId]` to the new step and place it to the right of the selected node.
- If nothing is selected, behave like today’s **Add step** button.

### Why it matters

- Most agent workflows are built left-to-right; auto-wiring removes ~2 clicks/drags per step.
- Keeps power users in flow; matches the “draw the DAG as you think” mental model.
- Very low risk — it only changes the initial placement/dependency of newly added steps.

### Estimated effort

**S** — a keyboard listener plus a small change to `handleAdd` in `WorkflowBuilder.tsx`. No backend work.

### Stoa area most likely to benefit

`WorkflowBuilder.tsx` (step creation + dependency wiring) and `PipelineCanvas.tsx` (selection state).

### Sources

- n8n docs, _Keyboard shortcuts_: `Tab` summons the node panel, new nodes auto-connect to the selected node — https://docs.n8n.io/keyboard-shortcuts/
- n8n docs, _Navigating the editor UI_: selecting a node in the node panel auto-connects it — https://docs.n8n.io/courses/level-one/chapter-1/
- Stackademic, _37 Hidden n8n Features_: “Auto-connect New Node — Select a node, press Tab, choose a new one. It connects instantly” — https://blog.stackademic.com/37-hidden-n8n-features-that-changed-how-i-build-automations-and-will-change-yours-too-71c77eccbaa1

---

## 2. Pin / mock upstream step output for cheap downstream iteration

### What it is

n8n lets a user “pin” a node’s output after it has run. On subsequent runs, n8n skips the pinned node and uses the saved output, so you can iterate on downstream logic without re-calling the upstream service. In Stoa, the upstream “service” is an expensive agent step that may take minutes and cost tokens.

A KISS version for Stoa:

- In the run detail or step context, let the user copy a completed step’s output and paste/pin it into the builder as that step’s “mock output”.
- When the workflow runs in “test mode”, any pinned step returns its pinned output instead of spawning a worker.
- Allow editing the pinned JSON so users can test edge cases without re-running the agent.

### Why it matters

- Agent steps are slow and token-expensive. Pinning removes the biggest iteration cost in multi-step pipelines.
- Makes debugging deterministic: downstream behavior stops changing because the upstream output changed.
- Enables offline/air-gapped workflow development.

### Estimated effort

**M** — needs a small schema addition in `BuilderDoc`/step (e.g. `pinnedOutput?: string`), UI in `WorkflowBuilder.tsx`, and a bypass path in the pipeline engine so pinned steps become no-ops during test runs.

### Stoa area most likely to benefit

Pipeline engine (`lib/pipeline/engine.ts` and executor), `WorkflowBuilder.tsx` step editor, and `RunDetail.tsx` (copy output affordance).

### Sources

- n8n docs, _Pinning and mocking data_: “Data pinning means saving the output data of a node and using the saved data instead of fetching fresh data in future workflow executions” — https://docs.n8n.io/data/data-pinning/
- n8n docs, _Manual, partial, and production executions_: pinned data is substituted on manual runs; production runs ignore it — https://docs.n8n.io/workflows/executions/manual-partial-and-production-executions/
- Stackademic, _37 Hidden n8n Features_: “Pin Data — After executing a node, press P to pin the result… re-run downstream nodes without calling APIs again” — https://blog.stackademic.com/37-hidden-n8n-features-that-changed-how-i-build-automations-and-will-change-yours-too-71c77eccbaa1

---

## 3. Canvas sticky notes

### What it is

n8n lets users drop sticky notes onto the canvas (`Shift + S`) and format them with Markdown and colors. They are purely annotations but heavily recommended for templates and shared workflows.

A KISS version for Stoa:

- Add a `Shift + S` shortcut and a small toolbar button to drop a sticky note on the canvas.
- Store notes in `BuilderDoc` as a new lightweight array (id, x, y, text, color).
- Render them behind nodes in `PipelineCanvas.tsx` as colored rectangles with text.
- Optional: a small color picker (e.g. yellow/green/red) and Markdown-lite for headers/lists.

### Why it matters

- Multi-agent workflows are inherently collaborative and hard to read months later. Notes reduce the “what was this step thinking?” problem.
- Cost/effort is tiny; value grows with workflow complexity.
- Aligns with n8n’s own stated best practice of using sticky notes heavily on templates.

### Estimated effort

**S–M** — model change in `lib/pipeline/builder-model.ts`, canvas rendering in `PipelineCanvas.tsx`, and a small edit popover. No backend/execution changes.

### Stoa area most likely to benefit

`PipelineCanvas.tsx`, `lib/pipeline/builder-model.ts`, and `WorkflowBuilder.tsx` (toolbar shortcut).

### Sources

- n8n docs, _Sticky Notes_: “Sticky Notes allow you to annotate and comment on your workflows… n8n recommends using Sticky Notes heavily, especially on template workflows” — https://docs.n8n.io/workflows/components/sticky-notes/
- n8n docs, _Keyboard shortcuts_: `Shift + s` adds a sticky note — https://docs.n8n.io/keyboard-shortcuts/
- Growwstacks, _Master n8n Canvas Settings_: best practice of one sticky per workflow section, color-coded — https://growwstacks.com/blog/n8n-canvas-settings-sticky-notes-tidy-up-workflow-organization/

---

## 4. Zoom-to-fit and reset-zoom controls

### What it is

n8n provides both keyboard shortcuts (`1` to fit, `0` to reset zoom) and visible canvas buttons for zoom in/out/fit/reset. Stoa’s `PipelineCanvas` is currently a scrolling SVG with no zoom or fit-to-view.

A KISS version for Stoa:

- Add small `+ / − / 1:1 / ⊠` buttons above the canvas.
- Implement zoom by scaling the SVG `viewBox` (or a CSS transform wrapper), keeping all pointer math in user space.
- `⊠` fits the full DAG into the visible canvas area; `1:1` returns to the current 1-unit behavior.

### Why it matters

- As soon as a pipeline has more than ~4 steps, the canvas overflows the viewport; users lose context.
- Zoom/fit is expected canvas behavior and makes presentations/screenshots easier.
- Purely presentational; no execution/model risk.

### Estimated effort

**S** — SVG `viewBox` manipulation in `PipelineCanvas.tsx`. Pointer-event coordinate math must convert through the current zoom scale, but that is well-understood.

### Stoa area most likely to benefit

`PipelineCanvas.tsx`.

### Sources

- n8n docs, _Keyboard shortcuts_: `+`/`-` zoom, `0` reset, `1` zoom-to-fit — https://docs.n8n.io/keyboard-shortcuts/
- n8n docs, _Navigating the editor UI_: canvas buttons for zoom-to-fit, zoom in/out, reset zoom, tidy up — https://docs.n8n.io/courses/level-one/chapter-1/

---

## 5. Partial / per-step execution

### What it is

n8n lets a user select a single node and choose **Execute step**. n8n runs only that node plus whatever upstream nodes are required to fill its input. This is especially useful for AI tool nodes where the full agent run is slow.

A KISS version for Stoa:

- In `WorkflowBuilder.tsx`, add a “Run up to this step” action on the selected node (or on each row in `RunDetail`).
- The backend takes the existing `PipelineSpec`, prunes it to the selected step and its transitive dependencies, and runs only that subgraph.
- Combine with Idea #2 (pinned outputs) so the pruned run can reuse already-completed upstream results.

### Why it matters

- The most common debugging loop is “I changed step 4; I want to see step 4 run, not steps 1–3 again.”
- Saves time and API/agent tokens during development.
- Builds naturally on the DAG structure Stoa already has.

### Estimated effort

**M** — needs a pruning helper in `lib/pipeline/engine.ts` and a new API/data mutation path, plus UI affordances. Less work if paired with pinned-output reuse.

### Stoa area most likely to benefit

Pipeline engine (`lib/pipeline/engine.ts`), `WorkflowBuilder.tsx`, `RunDetail.tsx`, and the run-start mutation.

### Sources

- n8n docs, _Manual, partial, and production executions_: “Partial executions are manual executions that only run a subset of your workflow nodes… select a node, open its detail view, and select Execute step” — https://docs.n8n.io/workflows/executions/manual-partial-and-production-executions/
- n8n docs, _Dirty nodes_: partial executions use dirty-node indicators to know where to restart — https://docs.n8n.io/workflows/executions/dirty-nodes/
- n8n release notes, _Partial Execution for AI Tools_ (1.92.0): run and test specific tools without executing the entire agent workflow — https://n8n-docs.teamlab.info/release-notes/

---

## Honorable mentions (not top 5)

| Idea                                                      | Why it’s nice                                       | Why it didn’t make the cut                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Duplicate / copy-paste a step** (`Ctrl + C / Ctrl + V`) | Saves time when building similar agent steps.       | Already trivial with the existing `addStep` + copy-fields logic; can be added as a small follow-up to Idea #1.             |
| **Disable a step temporarily** (`D`)                      | Lets users test a workflow without deleting a step. | Slightly more model/engine surface than the top 5; n8n itself calls it out as a partial-execution companion.               |
| **Auto-layout keyboard shortcut** (`Shift + Alt + T`)     | Stoa already has **Tidy layout** in the Saved menu. | Borrowing n8n’s keyboard shortcut and right-click menu entry would be a nice S win, but the feature itself already exists. |

---

## Recommended sequencing

1. **Quick wins (this week):** Ideas #1, #4, and #3 (keyboard auto-add, zoom controls, sticky notes). These are mostly self-contained UI/model changes.
2. **Iteration wins (next):** Idea #2 (pin/mock outputs). Reduces the biggest recurring cost in agent workflows.
3. **Advanced win:** Idea #5 (partial execution). Best delivered after #2 so it can reuse pinned upstream outputs.

---

## Sources

- n8n official keyboard shortcuts: https://docs.n8n.io/keyboard-shortcuts/
- n8n editor UI / canvas overview: https://docs.n8n.io/courses/level-one/chapter-1/
- n8n Sticky Notes: https://docs.n8n.io/workflows/components/sticky-notes/
- n8n Data pinning: https://docs.n8n.io/data/data-pinning/
- n8n Manual, partial, and production executions: https://docs.n8n.io/workflows/executions/manual-partial-and-production-executions/
- n8n Dirty nodes (partial-execution visual cue): https://docs.n8n.io/workflows/executions/dirty-nodes/
- n8n release notes (Partial Execution for AI Tools, Extended logs view, Tidy up): https://n8n-docs.teamlab.info/release-notes/
- Stackademic, 37 hidden n8n features (auto-connect, pinned data, sticky notes, shortcuts): https://blog.stackademic.com/37-hidden-n8n-features-that-changed-how-i-build-automations-and-will-change-yours-too-71c77eccbaa1
- Growwstacks, n8n canvas settings (sticky notes, tidy up, zoom-to-fit): https://growwstacks.com/blog/n8n-canvas-settings-sticky-notes-tidy-up-workflow-organization/

---

## Area: onboarding

# Onboarding & Empty-State UX Research for Stoa

**Date:** 2026-06-14  
**Scope:** Linear, Notion, Figma, Vercel + cross-tool patterns  
**Goal:** Identify 3–5 small, KISS, high-value wins for Stoa’s empty states, first-run experience, and workflow-builder onboarding.

---

## Executive Summary

Modern dev tools treat onboarding as a **value-delivery problem**, not a feature-tour problem. The shared playbook is surprisingly consistent:

1. **Never show a truly blank canvas.** Pre-seed workspaces, example files, templates, or importable artifacts so the user can learn by touching real objects.
2. **One primary action per empty state.** Empty screens are high-stakes decision points; extra links and “learn more” buttons dilute activation.
3. **Detect, don’t ask.** Infer framework, directory, or intent from existing user context instead of forcing configuration rituals.
4. **Teach by doing.** Interactive examples and runnable templates outperform static tutorials for developer tools.
5. **Context over sequence.** Progressive disclosure and just-in-time hints beat upfront product tours.

Below are 5 small, low-complexity wins mapped directly to Stoa surfaces.

---

## Competitor Pattern Map

### Linear — "Anti-onboarding"

- Entire onboarding is ~60 seconds, no tours/tooltips.
- Workspace is pre-populated with demo projects/issues that model the ideal workflow.
- Every empty state uses a subtle animation, a single explanation, and **one** button.
- Keyboard shortcuts appear on hover; command bar is introduced early.[^1]

### Notion — "Intent + checklist + AI starter"

- Opening question (“Work, Personal, or School”) filters the workspace before the user lands.
- In-app checklist narrows the next action and creates visible progress.
- AI-generated starter page shifts the user from “build from scratch” to “react to something.”[^5]

### Figma — "Learn by touching real artifacts"

- Pre-loads interactive example files (“Figma Basics,” “FigJam Basics”) directly into the workspace.
- Blank canvas is surrounded by scaffolding: templates, feature tour, and example files.
- Example files are real, unlocked Figma files—not simplified training modes.[^2]

### Vercel — "Engineer out the empty state"

- First interaction is **selection, not creation**: import an existing Git repo.
- Framework auto-detection removes configuration questions.
- Empty states are instructions, not illustrations; they show the exact next command/action.[^3][^4]

### Cross-tool meta-patterns (synthesized)

- **Content beats empty space.** Templates, sample data, and pre-loaded examples outperform blank canvases.[^7]
- **One primary action, not ten.** Every strong onboarding flow defines activation around a single behavior.[^7]
- **Detect, don’t ask.** Every field you infer is a step the user doesn’t abandon.[^3]
- **Empty states are launchpads, not dead ends.** Use them to educate, nudge, or sell the next step.[^6][^7]

---

## Recommended Wins for Stoa

### 1. Seed first-run workspace with a demo project + sample session

- **What:** On first launch with zero projects, automatically create a lightweight read-only “Stoa Tour” project containing one sample session card. The card shows what an agent session looks like (name, status badge, last line) and includes a label like _“This is a sample—start your own session to take over.”_
- **Why:** Blank lists trigger “blank-field anxiety” and early abandonment.[^7] Linear’s pre-populated demo workspace and Figma’s embedded example files prove that users learn faster by inspecting real artifacts than by reading explanations.[^1][^2]
- **Effort:** S–M
  - Seed logic can live client-side or in a one-time bootstrap hook.
  - No backend changes required if the sample is created via existing project/session creation APIs.
- **Stoa area:** `ProjectsSection` / `SessionList` first-run empty state.
- **Source inspiration:** Linear pre-populated workspace[^1]; Figma embedded example files[^2].

---

### 2. Empty-state launchpad: one sentence, one button, one shortcut

- **What:** Replace generic “No sessions yet” placeholders with a focused empty state:
  - A short title: _“No agent sessions yet”_
  - One-line description: _“Start a coding agent in this project.”_
  - A single primary CTA: **“New Session”**
  - A keyboard hint: _“or press Ctrl/Cmd + N”_
  - Add a subtle terminal-cursor blink or gentle pulse to draw the eye without noise.
- **Why:** Empty states are high-stakes moments where users decide whether to invest time.[^7] Linear’s empty-state rule is “single explanation + one button,” and Vercel’s Geist framework explicitly recommends capping empty states at one primary CTA (two only when paths are genuinely equal).[^1][^4]
- **Effort:** S
  - Pure presentational change in existing empty-state components.
  - Shortcut hint can reuse existing keybinding metadata.
- **Stoa area:** `SessionList` empty state; `ProjectsSection` when a project has zero sessions.
- **Source inspiration:** Linear empty-state pattern[^1]; Vercel Geist empty-state framework[^4].

---

### 3. Workflow Builder starter-template shelf

- **What:** When the `WorkflowBuilder` canvas is empty or the “Saved workflows” list is empty, surface 2–3 small template cards:
  - _Research → Implement_ (reuse the existing `EXAMPLE_DOC` DAG)
  - _Bug Fix_
  - _Code Review_
    Clicking a card loads a runnable DAG into the canvas.
- **Why:** Complex canvas tools have long time-to-value. Templates lower activation energy by giving users something runnable to edit instead of a blank canvas.[^6] Postman tags templates by difficulty/setup time; Figma’s example files teach by doing.[^2][^6]
- **Effort:** S–M
  - Compose 2–3 lightweight `PipelineSpec`s (can mirror `EXAMPLE_DOC`).
  - Add a small card grid UI above or beside the canvas.
- **Stoa area:** `WorkflowBuilder` / `WorkflowsView` empty state and saved-workflows panel.
- **Source inspiration:** Figma pre-loaded example files[^2]; Postman “Templates Beat Blank Slates”[^6].

---

### 4. Detect, don’t ask: suggest recent directories on first project creation

- **What:** In the empty `ProjectsSection` and the `NewProjectDialog`, show a short “Suggested directories” list (recent Git roots or commonly used folders under the home directory). Clicking a suggestion creates the project with that working directory; only ask for a display name if needed.
- **Why:** Vercel’s onboarding works because it “engineers out the empty state”—the first interaction is selecting an existing artifact rather than creating one from nothing.[^3] “Every field you do not ask is a step the user does not abandon at.”[^3]
- **Effort:** M
  - Needs platform-aware directory scanning (Stoa already has `lib/platform.ts` and directory-browser hooks).
  - Must gracefully fall back to the manual form when no suggestions exist.
- **Stoa area:** `NewProjectDialog`, `ProjectsSection` empty state.
- **Source inspiration:** Vercel Git-native import / “detect, don’t ask”[^3].

---

### 5. First-session mini checklist (product bumpers)

- **What:** Add a dismissible, 3-item checklist widget in the sidebar or `SessionListHeader` for new users:
  1. Create a project
  2. Start your first agent session
  3. Run a workflow step
     Items check off automatically when the corresponding action happens.
- **Why:** Notion’s onboarding checklist narrows the path to first value and creates forward pull without teaching the whole product.[^5] For Stoa, it surfaces the core loop (project → session → workflow) without an intrusive tour.
- **Effort:** S–M
  - Track completion via existing query/mutation hooks.
  - Persist dismiss state locally or per-user.
- **Stoa area:** `Sidebar`, `SessionListHeader`, first-run dashboard.
- **Source inspiration:** Notion onboarding checklist / product bumpers[^5].

---

## What to Avoid

- **Multi-step product tours or forced tooltips.** Linear deliberately skips them; dev-tool users often find tours friction.[^1]
- **Sad-robot “Nothing here yet” illustrations.** Vercel’s Geist framework treats empty states as instructions, not decorations.[^4]
- **More than one primary CTA in an empty state.** Two CTAs are only justified when paths are genuinely equal (e.g., “Import Repository” vs. “Deploy Template”); three is a smell.[^4]
- **Auto-launching tours from empty states.** Pair a “Start Tour” button with a clear “Skip” option.[^4]

---

## Quick Prioritization Table

| #   | Win                                | Effort | Highest-Impact Stoa Area            |
| --- | ---------------------------------- | ------ | ----------------------------------- |
| 1   | Demo project + sample session      | S–M    | `ProjectsSection` / `SessionList`   |
| 2   | One-sentence empty-state launchpad | S      | `SessionList` empty state           |
| 3   | Workflow Builder template shelf    | S–M    | `WorkflowBuilder` / `WorkflowsView` |
| 4   | Suggested directory import         | M      | `NewProjectDialog`                  |
| 5   | First-session mini checklist       | S–M    | `Sidebar` / `SessionListHeader`     |

---

## Sources

[^1]: Candu, “Linear Onboarding Teardown: How Anti-Onboarding Drives Adoption” — https://www.candu.ai/blog/linear-onboarding-teardown

[^2]: Supademo, “Figma Onboarding Flow: A Screen-by-Screen Teardown” — https://supademo.com/user-flow-examples/figma

[^3]: Perspective AI, “Vercel's AI-Native Customer Onboarding: How They Activate Developer Teams” — https://getperspective.ai/blog/vercel-ai-native-customer-onboarding-developer-teams

[^4]: Vercel Geist, “Empty State” design framework — https://vercel.com/geist/empty-state

[^5]: Supademo, “Notion Onboarding Flow: A Screen-by-Screen Teardown” — https://supademo.com/user-flow-examples/notion

[^6]: Candu, “Postman Onboarding Teardown: 7 UX Moves Every Dev Tool Should Copy” — https://www.candu.ai/blog/postman-onboarding-ux-lessons

[^7]: SaaS Factor, “Empty State UX: Turn Blank Screens Into Higher Activation and SaaS Revenue” — https://www.saasfactor.co/blogs/empty-state-ux-turn-blank-screens-into-higher-activation-and-saas-revenue

---

## Area: reactflow

# React Flow / xyflow Canvas UX Research for Stoa PipelineCanvas

**Scope:** identify small, KISS, high-value interaction wins from React Flow (`@xyflow/react`) that can be adapted to Stoa's custom SVG `PipelineCanvas` (`components/views/WorkflowsView/PipelineCanvas.tsx`). Stoa's canvas is dependency-free SVG with Pointer Events, single selection, node drag, output-port connection drag, and tap-to-remove edges. It is mobile-first by design (`touch-action: none` only on nodes/ports, native scroll on empty canvas).

**Research date:** 2026-06-14

---

## 1. Drag threshold so a click doesn't become a drag

**What it is**  
React Flow 12 changed `nodeDragThreshold` default from `0` to `1` px, and added `connectionDragThreshold`. The pointer must move a few pixels before a drag (or connection) is recognized, so a simple tap/click is not mis-interpreted as a tiny drag.

**Why it matters for Stoa**  
`PipelineCanvas` starts a node drag immediately on `pointerdown` inside the node. On touch, a tap can jitter a pixel or two and accidentally nudge the step. A 2–4 px drag threshold prevents accidental moves while keeping the canvas feel responsive. Cheap to add: store the start pointer position and only commit `onMoveNode` once `|dx| + |dy| > threshold`.

**Effort:** S  
**Stoa area:** `PipelineCanvas` node drag + port connection drag  
**Sources:**

- React Flow API reference: `nodeDragThreshold` / `connectionDragThreshold` defaults in v12 — https://reactflow.dev/api-reference/react-flow
- React Flow 12 release notes: "`nodeDragThreshold` is 1 by default instead of 0" — https://xyflow.com/blog/react-flow-12-release

---

## 2. Tap-to-connect fallback for touch

**What it is**  
React Flow's `connectOnClick` prop lets users tap a source handle, then tap a target handle to complete a connection without a continuous drag. The official "Touch Device" example pairs this with enlarged handles on small screens.

**Why it matters for Stoa**  
Stoa already has a 14 px transparent touch target around each output port, which is good. But a continuous finger-drag is still hard on small screens because the finger obscures the target node. A two-tap mode—tap a source port (it highlights), tap a target node to wire the dependency—would make connection creation reliable on phones. This can coexist with the existing drag-to-connect path.

**Effort:** S–M  
**Stoa area:** `PipelineCanvas` connection UX (ports + edges)  
**Sources:**

- React Flow "Touch Device" example — https://reactflow.dev/examples/interaction/touch-device
- React Flow API reference: `connectOnClick` — https://reactflow.dev/api-reference/react-flow
- GitHub discussion on mobile support referencing the touch example — https://github.com/xyflow/xyflow/discussions/2403

---

## 3. Snap-to-grid / alignment guides while dragging

**What it is**  
React Flow supports `snapToGrid` + `snapGrid`, and the Pro "Helper Lines" example draws horizontal/vertical alignment guides as a node is dragged, with snapping when close to another node's edge or center.

**Why it matters for Stoa**  
`PipelineCanvas` currently allows free positioning, which can leave steps messy and edges hard to read. A small grid snap (e.g., 8 px, matching the existing `PAD`) plus faint alignment lines would keep pipelines tidy with almost no user friction. Because Stoa uses a 1:1 viewBox, grid math is trivial: round `x`/`y` to the nearest multiple of `GRID` before calling `onMoveNode`.

**Effort:** S (grid snap); M (helper lines)  
**Stoa area:** `PipelineCanvas` node positioning / layout polish  
**Sources:**

- React Flow API reference: `snapToGrid`, `snapGrid` — https://reactflow.dev/api-reference/react-flow
- React Flow Pro "Helper Lines" example — https://reactflow.dev/examples/interaction/helper-lines
- Synergy Codes React Flow UX guide: "Difficulty with precise positioning" / snap-to-grid as a solution — https://www.synergycodes.com/webbook/building-usable-and-accessible-diagrams-with-react-flow

---

## 4. Keyboard selection, arrow-key nudge, and Delete/Backspace

**What it is**  
React Flow makes nodes/edges focusable via `Tab`, selectable with `Enter`/`Space`, movable with arrow keys (Shift for bigger steps), and deletable with `Delete`/`Backspace`. It also exposes `ariaLabelConfig` for screen-reader instructions.

**Why it matters for Stoa**  
`PipelineCanvas` has no keyboard affordances today. A keyboard-only user cannot select a step, move it, or delete a dependency. The smallest viable lift:

- `tabIndex={0}` on each node `<g>` and edge `<g>`.
- `Enter`/`Space` toggles `selectedId`; `Escape` clears it.
- Arrow keys nudge the selected node by the grid step (e.g., 8 px), Shift × 5.
- `Delete` / `Backspace` removes the selected node (call the existing delete handler) or selected edge (`onDisconnect`).
- Add an `aria-label` / `aria-description` to each node so a screen reader announces the step name and keyboard hints.

This satisfies the mobile-first product goal without adding heavy dependencies.

**Effort:** M  
**Stoa area:** `PipelineCanvas` accessibility & power-user UX  
**Sources:**

- React Flow "Accessibility" guide: tab navigation, arrow keys, delete, ARIA live regions — https://reactflow.dev/learn/advanced-use/accessibility
- React Flow API reference: `nodesFocusable`, `edgesFocusable`, `deleteKeyCode`, `disableKeyboardA11y` — https://reactflow.dev/api-reference/react-flow
- Synergy Codes: "Keyboard-controlled interactions" and focus visibility — https://www.synergycodes.com/webbook/building-usable-and-accessible-diagrams-with-react-flow

---

## 5. Multi-select with Shift+click (and optional marquee box)

**What it is**  
React Flow supports `multiSelectionKeyCode` (default Shift) to add/remove individual elements from the selection, and `selectionOnDrag` / `selectionKeyCode` to draw a marquee selection box. `selectionMode="partial"` selects nodes that are only partially inside the box.

**Why it matters for Stoa**  
Currently `PipelineCanvas` only tracks a single `selectedId`. For a pipeline with many steps, users may want to select several steps at once to delete or reorder them as a group. The smallest first step is Shift+click multi-select:

- Extend state from `selectedId: string | null` to `selectedIds: Set<string>`.
- Shift+click toggles a node in the set; click without Shift clears and selects one.
- Dragging any selected node moves the whole group by the same delta.
- A marquee box can be added later by drawing a `<rect>` on pointer drag over empty canvas and intersecting with node bounds.

This is the highest-value "power user" win and lays groundwork for future group actions (delete selected, align selected, etc.).

**Effort:** M (Shift+click + group drag); L (full marquee selection)  
**Stoa area:** `PipelineCanvas` selection model + `WorkflowBuilder` actions  
**Sources:**

- React Flow API reference: `multiSelectionKeyCode`, `selectionOnDrag`, `selectionMode`, `onSelectionChange` — https://reactflow.dev/api-reference/react-flow
- React Flow 12 release notes: "a better selection box usability (capture while dragging out of the flow)" — https://xyflow.com/blog/react-flow-12-release
- GitHub issue #5588 on `selectionOnDrag` behavior (shows current UX trade-offs) — https://github.com/xyflow/xyflow/issues/5588

---

## Quick prioritization table

| #   | Idea           | Effort | Value                              | Best first? |
| --- | -------------- | ------ | ---------------------------------- | ----------- |
| 1   | Drag threshold | S      | High (prevents accidental edits)   | ⭐ Yes      |
| 2   | Tap-to-connect | S–M    | High (mobile reliability)          | ⭐ Yes      |
| 3   | Snap-to-grid   | S      | Medium (visual tidiness)           | Yes         |
| 4   | Keyboard a11y  | M      | High (accessibility + power users) | Yes         |
| 5   | Multi-select   | M–L    | High (batch operations)            | After #1–#3 |

---

## Notes on implementation constraints

- Stoa's canvas is plain SVG, so these ideas should be **re-implemented**, not imported from `@xyflow/react`. That keeps the bundle small and avoids pulling a graph library into a single view.
- Preserve the existing mobile-first scroll behavior: `touch-action: none` must stay scoped to nodes/ports only; empty-canvas drags should continue to scroll the page.
- Coordinate math is simple because `PipelineCanvas` uses a 1-unit-per-px `viewBox` and no zoom/CTM transforms.
- Any new interaction should ship with unit tests per `AGENTS.md` (mock pointer events / keyboard events on the SVG).

---

_Research compiled for Stoa competitor-research. Do not modify source files based on this document without a separate implementation plan._

---

## Area: vscode-terminal

# Competitor Research: VS Code Terminal Panel UX → Stoa Wins

**Scope:** VS Code integrated terminal panel UX patterns (tabs, split panes, link detection, command palette).  
**Goal:** Identify small, KISS, high-value improvements for Stoa's session/terminal UI.  
**Sources:** Official VS Code docs, VS Code release notes, Windows Terminal/Warp/TUICommander competitive references.

---

## Stoa Baseline Observed

- **Panes/tabs:** One tab bar per pane (`components/Pane/DesktopTabBar.tsx`, `MobileTabBar.tsx`). Tabs show session names but no live status icon. Splits exist via toolbar icons; no documented pane-focus keyboard nav.
- **Terminal:** xterm.js with `@xterm/addon-web-links` (`components/Terminal/hooks/terminal-init.ts`). Detects URLs but not local file paths with line/column.
- **Command surface:** A `QuickSwitcher` (`components/QuickSwitcher.tsx`) exposes sessions, code search, and a handful of global commands, but not terminal/pane actions.
- **Keybinding infra:** `lib/keybindings.ts` + `hooks/useGlobalKeybindings.ts` already normalize cross-platform chords and guard text inputs/xterm focus.

---

## Recommended Wins (4)

### 1. Clickable file links with line:column in terminal output

**What**  
Extend xterm link detection beyond URLs to agent-emitted file paths:

- `src/lib/foo.ts:42:5`
- `./README.md`
- `lib/providers/registry.ts(12,3)`
- `file://` links (already supported by some agents)

Hover shows underline; `Ctrl/Cmd+click` opens the file in Stoa's file editor at the referenced line. Resolve relative paths against the session's `working_directory`.

**Why**  
Agents constantly output paths, stack traces, and lint/compiler errors. Today users must manually browse the file tree. VS Code's terminal turns these into first-class navigation gestures. This is a narrow, high-leverage change that reuses Stoa's existing file editor and `fileOpenStore`.

**Effort:** **S–M**

**Stoa area**

- `components/Terminal/hooks/terminal-init.ts` – add a custom xterm `LinkProvider` or a regex-based addon.
- `components/Terminal/index.tsx` – expose an `onOpenFile(path, line)` callback.
- `stores/fileOpen.ts` / `hooks/useFileEditor.ts` – open the file and scroll to the line.
- Use `lib/path-display.ts` / `lib/platform.ts` helpers for cross-platform path resolution (per `AGENTS.md`).

**Sources**

- VS Code Terminal Basics: "File links ... open the file in a new editor tab and support many common line/column formats such as `file:1:2`"[^1].
- VS Code Shell Integration: CWD detection lets relative links resolve to the correct folder[^2].
- Eliot Struyf, "Handle links in the terminal from your Visual Studio Code extension" – `registerTerminalLinkProvider` API pattern[^3].

---

### 2. Keyboard-driven pane navigation & splitting

**What**  
Add global shortcuts for:

- Split pane horizontally / vertically (e.g. `Mod+Shift+H` / `Mod+Shift+V`, mirroring muscle memory from VS Code `Ctrl+\` / `Ctrl+Shift+5`).
- Focus next/previous pane (e.g. `Mod+Alt+→` / `←`, like VS Code/Windows Terminal `Alt+Arrow`).
- Close focused pane (`Mod+Shift+W`).

Show a subtle focus ring/color shift on the active pane so users know where keystrokes go.

**Why**  
Power users run multiple agents side-by-side. VS Code and Windows Terminal both use `Alt+Arrow` for pane focus and simple chords for split/close[^4][^5]. Stoa already has `PaneContext`, `splitHorizontal`, `splitVertical`, `close`, and the keybinding normalization layer, so the wiring is mostly additive.

**Effort:** **S**

**Stoa area**

- `lib/keybindings.ts` – add `split-h`, `split-v`, `focus-next-pane`, `focus-prev-pane`, `close-pane` actions.
- `hooks/useGlobalKeybindings.ts` wiring (likely in `app/page.tsx` or a new pane-keyboard hook).
- `contexts/PaneContext.tsx` – add `focusNextPane`/`focusPrevPane` helpers that walk `state.layout`.
- `components/Pane/index.tsx` – already exposes `isFocused`; amplify the visual difference.

**Sources**

- VS Code Terminal Basics: split via `Ctrl+Shift+5` (macOS `Cmd+\`), navigate panes with `Alt+Left/Right`[^4].
- Windows Terminal pane management guide: `Alt+Shift+Plus/Minus` to split, `Alt+Arrow` to navigate, `Ctrl+Shift+W` to close[^5].

---

### 3. Terminal/pane actions in the QuickSwitcher command palette

**What**  
Extend the existing `Cmd/Ctrl+K` QuickSwitcher command lane with context-aware terminal/pane actions:

- Split pane right / down
- Close pane
- New tab / close tab
- Next tab / previous tab
- Toggle Files / Git / Shell drawer
- Attach selection to agent
- Compose prompt
- Detach from tmux (when applicable)

Each command shows its keybinding hint (like VS Code's palette does) so the palette also teaches shortcuts.

**Why**  
VS Code's command palette is the primary discoverability surface: every terminal action is searchable and its shortcut is displayed next to the label[^6][^7]. Stoa's QuickSwitcher already has a command lane and fuzzy matching (`lib/quick-switcher-commands.ts`); adding pane/terminal commands surfaces actions that are currently buried in small toolbar icons and accelerates keyboard workflows.

**Effort:** **M**

**Stoa area**

- `lib/quick-switcher-commands.ts` – model new commands; add optional context guard so pane-only commands only appear when a pane is focused.
- `components/QuickSwitcher.tsx` – consume pane/terminal callbacks and render shortcut labels using `formatChord`.
- `contexts/PaneContext.tsx` / `components/Pane/index.tsx` – expose stable callbacks for the actions the palette will drive.
- `lib/keybindings.ts` – source of truth for the shortcut labels shown in the palette.

**Sources**

- VS Code Tips & Tricks: "You can see the default keyboard shortcut alongside the command in the Command Palette"[^6].
- VS Code Keyboard Shortcuts docs: command palette exposes all bindable commands[^7].

---

### 4. Live status dot on session tabs

**What**  
Render a small status indicator on each desktop and mobile tab reflecting the session's live state:

- idle / running / waiting / error
- Use existing `sessionStatuses` map and `statusGlyph` component.

Keep it tiny (a colored dot or the existing glyph) so the tab bar stays scannable.

**Why**  
With multiple agents running, users need to know which tab needs attention without clicking through. VS Code terminal tabs show status icons (bell, check, X, animated spinner)[^8]. TUICommander also advertises colored "tab status dots" as a differentiator[^9]. Stoa already computes status per session, so this is a pure UI affordance.

**Effort:** **S**

**Stoa area**

- `components/Pane/DesktopTabBar.tsx` – add status glyph/dot next to tab name.
- `components/Pane/MobileTabBar.tsx` – same for mobile.
- `components/status-glyph.tsx` – reuse existing status icon mapping.

**Sources**

- VS Code Terminal Appearance: "A terminal's 'status' ... is signified by an icon that appears on the right of the tab"[^8].
- TUICommander product page: "Tab status dots — 6 visual states: idle, running, unseen, awaiting, error"[^9].

---

## What Was Deliberately Not Recommended

- **Pane maximize/zoom** (VS Code panel maximize / Windows Terminal "Toggle pane zoom") – valuable, but requires layout state changes that are bigger than a KISS win.
- **Right-click terminal context menu** – useful, but conflicts with xterm mouse-event passthrough to TUIs (vim, etc.) and needs careful modality; lower value than link detection.
- **OSC 8 / shell integration hyperlinks** – high-value, but depends on shell-side cooperation from agent CLIs; start with regex file-link detection which works immediately.

---

## Source Footnotes

[^1]: VS Code, "Terminal Basics" – Links section, https://code.visualstudio.com/docs/terminal/basics

[^2]: VS Code, "Terminal Shell Integration" – Current working directory detection, https://code.visualstudio.com/docs/terminal/shell-integration

[^3]: Eliot Struyf, "Handle links in the terminal from your Visual Studio Code extension", https://www.eliostruyf.com/handle-links-in-the-terminal-from-your-vscode-extension/

[^4]: VS Code, "Terminal Basics" – Managing terminals / Groups (split panes), https://code.visualstudio.com/docs/terminal/basics

[^5]: NinjaOne / Windows Forum, "How to Manage Panes in Windows Terminal", https://www.ninjaone.com/blog/how-to-manage-panes-in-windows-terminal/

[^6]: VS Code, "Tips and Tricks" – Command Palette, https://code.visualstudio.com/docs/editing/tips-and-tricks

[^7]: VS Code, "Keyboard Shortcuts" – Command Palette exposes all commands, https://code.visualstudio.com/docs/configure/keybindings

[^8]: VS Code, "Terminal Appearance" – Status section, https://code.visualstudio.com/docs/terminal/appearance

[^9]: TUICommander product page, "And a full-featured terminal", https://tuicommander.com/

---

## Area: windmill

# Competitor UX Research: Windmill Flow/Script Builder → Stoa Visual Workflow Builder

**Date:** 2026-06-14  
**Scope:** Identify small, KISS, high-value usability/performance/feature wins for Stoa's visual workflow builder, based on Windmill's flow/script builder UX.  
**Stoa context:** Visual builder lives in `components/views/WorkflowsView/WorkflowBuilder.tsx`, `PipelineCanvas.tsx`, and `PipelineGraph.tsx`; model in `lib/pipeline/builder-model.ts`; executor/engine in `lib/pipeline/executor.ts` / `engine.ts`.

## Sources consulted

- Windmill, "Flow editor" docs: https://www.windmill.dev/docs/flows/flow_editor
- Windmill, "Workflow builder with built-in infrastructure": https://www.windmill.dev/platform/flow-editor
- Windmill, "Testing flows" docs: https://www.windmill.dev/docs/flows/test_flows
- Windmill, "Flows quickstart": https://www.windmill.dev/docs/getting_started/flows_quickstart
- Windmill, "Sticky notes" docs: https://www.windmill.dev/docs/flows/sticky_notes
- Windmill, "Flow editor components" docs: https://www.windmill.dev/docs/flows/editor_components
- Windmill, "Collapsible flow groups" changelog: https://www.windmill.dev/changelog/flow-groups

---

## 1. Inline output picker / autocomplete for `{{steps.<id>.output}}`

**What it is**  
Add a small picker inside the **Task** textarea that lets the user insert a reference to an upstream step's output without memorizing the placeholder syntax. A "plug" button or a `{{` trigger would list the available step ids and insert `{{steps.<id>.output}}`.

**Why it matters**  
Today Stoa users have to remember the exact placeholder syntax and step ids when wiring one agent's task to another's output. On mobile this is especially error-prone and breaks validation. Windmill solves the same problem with a "plug logo" picker plus autocomplete for `results.step_name` expressions, cutting wiring time and reducing typos.

**Estimated effort:** S  
**Stoa area:** `WorkflowBuilder.tsx` edit panel (Task textarea)  
**Sources:**

- Windmill Flows quickstart: "clicking on the plug logo that will let you pick flow inputs or previous steps' results".
- Windmill platform/flow-editor: "Steps are linked by referencing previous outputs with `results.step_name` or JavaScript expressions. The editor provides autocompletion for available variables and validates expressions before running."

---

## 2. Duplicate step from the canvas or edit panel

**What it is**  
Add a **Duplicate** action (right-click context menu on a node, plus a button in the edit panel) that clones the selected step with a fresh id, copying its agent, task, exit criteria, dependencies, and worktree policy. The clone is placed slightly offset so it doesn't stack.

**Why it matters**  
Multi-agent workflows often repeat the same shape of step with small edits. Re-typing task prompts and exit criteria for each new step is slow and error-prone. Windmill exposes this as a first-class canvas gesture and "inserts the clone right after the original."

**Estimated effort:** S  
**Stoa area:** `lib/pipeline/builder-model.ts` (add `duplicateStep`), `PipelineCanvas.tsx` (context menu), `WorkflowBuilder.tsx` (edit panel button)  
**Sources:**

- Windmill Flow editor docs, "Node context menu": "Duplicate — clones the node and all of its nested children, reassigning IDs, and inserts the clone right after the original."

---

## 3. Keyboard cancel + delete gestures

**What it is**

- Press **Escape** while dragging a node or a new connection to cancel the drag cleanly.
- Press **Delete** (or **Backspace**) when a node is selected to remove it (with confirmation if it has downstream dependents).

**Why it matters**  
Power users expect these affordances. Without Escape, a mis-dragged connection requires a precise click on empty canvas to clear. Without Delete, removing a node forces the user to scroll to the edit-panel trash icon. Windmill already models the interaction expectation: Escape cancels drags and the node context menu provides Delete.

**Estimated effort:** S  
**Stoa area:** `PipelineCanvas.tsx` (add `keydown` listeners), `WorkflowBuilder.tsx`  
**Sources:**

- Windmill Flow editor docs, "Drag-and-drop reordering": "Press `Escape` during a drag to cancel cleanly."
- Windmill Flow editor docs, "Node context menu": "Delete — removes the node (shown in red as a danger action)."

---

## 4. Color-coded agent badges on nodes

**What it is**  
Give each node a small colored accent (left border stripe, header bar, or agent chip) keyed to the step's agent (`claude`, `codex`, `hermes`, etc.). The color mapping would be defined once in the theme/provider registry.

**Why it matters**  
In multi-agent workflows, users need to see at a glance which agent owns each step, and spot misconfigurations before running. Windmill leans heavily on color for visual organization: colored flow groups, color picker for sticky notes, and color-coded statuses in the flow status viewer. Applying the same principle to agent identity is a cheap, high-readability win.

**Estimated effort:** S  
**Stoa area:** `PipelineCanvas.tsx` node rendering, `styles/themes.css` / provider registry  
**Sources:**

- Windmill Flow editor docs: flow groups use a "color picker" and "render as a colored border around its contained nodes."
- Windmill Sticky notes docs: notes have a "Color picker" for visual organization.
- Windmill changelog/status viewer: status colors are used to communicate node state in the graph.

---

## 5. "Test this step" / "Test up to this step" from the builder

**What it is**  
Add per-step test actions in the edit panel:

- **Test this step** — run only the selected step, using mocked or previously-captured upstream outputs.
- **Test up to this step** — run the DAG prefix up to and including the selected step.

This mirrors Windmill's editor-level testing, where users can test a single step or run the flow only until a given step.

**Why it matters**  
Iterating on an agent prompt currently requires starting the whole pipeline, which is slow and token-expensive. Testing one step or a prefix surfaces configuration errors earlier and dramatically tightens the edit-run-debug loop.

**Estimated effort:** M  
**Stoa area:** `lib/pipeline/executor.ts`, `lib/pipeline/engine.ts`, `WorkflowBuilder.tsx`, `data/pipelines/queries.ts`  
**Sources:**

- Windmill Testing flows docs: "`Test this step` is a way to test a single step of the flow." and "`Test up to step`... the flow will execute until a given step, included."
- Windmill Flow editor components docs: "Step configuration/Test this step" tab in the action editor.

---

## Summary

| #   | Idea                                | Effort | Stoa area                                 |
| --- | ----------------------------------- | ------ | ----------------------------------------- |
| 1   | Inline output picker / autocomplete | S      | `WorkflowBuilder.tsx` edit panel          |
| 2   | Duplicate step                      | S      | `builder-model.ts` + `PipelineCanvas.tsx` |
| 3   | Escape cancel / Delete key          | S      | `PipelineCanvas.tsx`                      |
| 4   | Agent color coding                  | S      | `PipelineCanvas.tsx` / themes             |
| 5   | Test this step / test up to step    | M      | pipeline executor + builder UI            |

**Suggested order:** Ship #1 and #2 first (tiny, high-frequency wins), follow with #3 and #4 as quick polish, then tackle #5 for the larger iterative-authoring payoff.

---
