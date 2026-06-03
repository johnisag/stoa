import { describe, it, expect } from "vitest";
import {
  conversationToMarkdown,
  conversationToJSON,
  exportFileStem,
  buildExport,
} from "@/lib/export";
import type { Session, Message } from "@/lib/db";

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    name: "My Session",
    tmux_name: "claude-sess-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    status: "idle",
    working_directory: "/work/proj",
    parent_session_id: null,
    claude_session_id: null,
    model: "opus",
    system_prompt: null,
    group_path: "",
    project_id: null,
    agent_type: "claude",
    auto_approve: false,
    worktree_path: null,
    branch_name: null,
    base_branch: null,
    dev_server_port: null,
    pr_url: null,
    pr_number: null,
    pr_status: null,
    conductor_session_id: null,
    worker_task: null,
    worker_status: null,
    mcp_launch_args: null,
    ...over,
  };
}

function mkMsg(
  role: Message["role"],
  content: string,
  over: Partial<Message> = {}
): Message {
  return {
    id: 1,
    session_id: "sess-1",
    role,
    content,
    timestamp: "2026-01-01T00:00:01Z",
    duration_ms: null,
    ...over,
  };
}

const textMsg = (role: Message["role"], text: string) =>
  mkMsg(role, JSON.stringify([{ type: "text", text }]));

describe("conversationToMarkdown", () => {
  it("renders a header with session metadata and role sections in order", () => {
    const md = conversationToMarkdown(mkSession(), [
      textMsg("user", "build me a thing"),
      textMsg("assistant", "done, here it is"),
    ]);
    expect(md).toContain("# My Session");
    expect(md).toContain("- **Agent:** claude");
    expect(md).toContain("- **Model:** opus");
    expect(md).toContain("- **Directory:** /work/proj");
    expect(md).toContain("## User");
    expect(md).toContain("build me a thing");
    expect(md).toContain("## Assistant");
    expect(md).toContain("done, here it is");
    // ordering: user section precedes assistant section
    expect(md.indexOf("## User")).toBeLessThan(md.indexOf("## Assistant"));
  });

  it("shows (default) when no model and includes the system prompt when set", () => {
    const md = conversationToMarkdown(
      mkSession({ model: "", system_prompt: "  be terse  " }),
      []
    );
    expect(md).toContain("- **Model:** (default)");
    expect(md).toContain("## System prompt");
    expect(md).toContain("be terse"); // trimmed
  });

  it("notes when there are no messages", () => {
    const md = conversationToMarkdown(mkSession(), []);
    expect(md).toContain("_No messages recorded for this session._");
  });

  it("treats non-JSON legacy content as raw text", () => {
    const md = conversationToMarkdown(mkSession(), [
      mkMsg("user", "just a plain string, not JSON"),
    ]);
    expect(md).toContain("just a plain string, not JSON");
  });

  it("represents tool blocks compactly instead of dumping or crashing", () => {
    const content = JSON.stringify([
      { type: "text", text: "let me check" },
      { type: "tool_use", name: "bash", input: { cmd: "ls" } },
    ]);
    const md = conversationToMarkdown(mkSession(), [
      mkMsg("assistant", content),
    ]);
    expect(md).toContain("let me check");
    expect(md).toContain("[tool: bash]");
  });

  it("strips backticks from a tool name so it can't break the code span", () => {
    const content = JSON.stringify([{ type: "tool_use", name: "ev`il" }]);
    const md = conversationToMarkdown(mkSession(), [
      mkMsg("assistant", content),
    ]);
    expect(md).toContain("[tool: evil]");
  });

  it("does not crash on a JSON array of non-object primitives", () => {
    const md = conversationToMarkdown(mkSession(), [
      mkMsg("assistant", "[null, 1, true]"),
    ]);
    expect(md).toContain("## Assistant");
  });
});

describe("conversationToJSON", () => {
  it("emits valid, parseable JSON with session + parsed message blocks", () => {
    const json = conversationToJSON(mkSession(), [
      textMsg("user", "hello"),
      mkMsg("assistant", "legacy raw"),
    ]);
    const parsed = JSON.parse(json);
    expect(parsed.session).toMatchObject({
      id: "sess-1",
      agent_type: "claude",
      model: "opus",
    });
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({ role: "user" });
    expect(parsed.messages[0].content).toEqual([
      { type: "text", text: "hello" },
    ]);
    // legacy raw string is wrapped as a text block
    expect(parsed.messages[1].content).toEqual([
      { type: "text", text: "legacy raw" },
    ]);
  });

  it("maps an empty model to null", () => {
    const parsed = JSON.parse(conversationToJSON(mkSession({ model: "" }), []));
    expect(parsed.session.model).toBeNull();
    expect(parsed.messages).toEqual([]);
  });
});

describe("exportFileStem", () => {
  it("slugifies the session name", () => {
    expect(exportFileStem(mkSession({ name: "My Cool Session!" }))).toBe(
      "my-cool-session"
    );
  });

  it("falls back to session-<id> when the name has no usable characters", () => {
    expect(exportFileStem(mkSession({ name: "!!!", id: "abc" }))).toBe(
      "session-abc"
    );
  });

  it("falls back to session-<id> for an empty name", () => {
    expect(exportFileStem(mkSession({ name: "", id: "xyz" }))).toBe(
      "session-xyz"
    );
  });
});

describe("buildExport", () => {
  it("routes md vs json to the right body, content type, and filename", () => {
    const md = buildExport(mkSession(), [], "md");
    expect(md.contentType).toBe("text/markdown; charset=utf-8");
    expect(md.filename).toBe("my-session.md");
    expect(md.body).toContain("# My Session");

    const json = buildExport(mkSession(), [], "json");
    expect(json.contentType).toBe("application/json; charset=utf-8");
    expect(json.filename).toBe("my-session.json");
    expect(() => JSON.parse(json.body)).not.toThrow();
  });
});
