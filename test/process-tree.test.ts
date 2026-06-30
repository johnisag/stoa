import { describe, it, expect } from "vitest";
import {
  parsePosixPs,
  parseWindowsProcList,
  collectDescendants,
  mcpServerName,
  fanoutFor,
  WINDOWS_SNAPSHOT_PS,
  type ProcInfo,
} from "@/lib/process-tree";

describe("parsePosixPs", () => {
  it("parses pid/ppid/command from padded `ps` lines (command may have spaces)", () => {
    const out = parsePosixPs(
      [
        "    1     0 /sbin/launchd",
        "  234     1 /usr/bin/node /app/server.js --port 3011",
        "  999   234 npx mcp-server-filesystem /work",
      ].join("\n")
    );
    expect(out).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      {
        pid: 234,
        ppid: 1,
        command: "/usr/bin/node /app/server.js --port 3011",
      },
      { pid: 999, ppid: 234, command: "npx mcp-server-filesystem /work" },
    ]);
  });

  it("skips header/blank/garbage lines (only two-leading-integers lines count)", () => {
    const out = parsePosixPs("  PID  PPID COMMAND\n\n  not a row\n  5  1 sh");
    expect(out).toEqual([{ pid: 5, ppid: 1, command: "sh" }]);
  });
});

describe("parseWindowsProcList", () => {
  it("parses the |||-delimited PowerShell output, tolerating a null CommandLine", () => {
    const out = parseWindowsProcList(
      [
        "4|||0|||",
        "1200|||4|||C:\\Windows\\System32\\node.exe server.js",
        "3400|||1200|||npx @modelcontextprotocol/server-everything",
        "garbage line",
      ].join("\r\n")
    );
    expect(out).toEqual([
      { pid: 4, ppid: 0, command: "" },
      {
        pid: 1200,
        ppid: 4,
        command: "C:\\Windows\\System32\\node.exe server.js",
      },
      {
        pid: 3400,
        ppid: 1200,
        command: "npx @modelcontextprotocol/server-everything",
      },
    ]);
  });

  it("re-joins a command line that itself contained the delimiter", () => {
    const out = parseWindowsProcList("10|||2|||a |||b");
    expect(out[0].command).toBe("a |||b");
  });
});

describe("collectDescendants", () => {
  const tree: ProcInfo[] = [
    { pid: 1, ppid: 0, command: "init" },
    { pid: 100, ppid: 1, command: "pty-root" }, // the session root
    { pid: 101, ppid: 100, command: "claude" },
    { pid: 102, ppid: 101, command: "mcp-server-a" },
    { pid: 103, ppid: 101, command: "subagent" },
    { pid: 104, ppid: 103, command: "grandchild" },
    { pid: 200, ppid: 1, command: "unrelated" },
  ];

  it("returns ALL transitive descendants, excluding the root, not unrelated siblings", () => {
    const ids = collectDescendants(tree, 100)
      .map((p) => p.pid)
      .sort((a, b) => a - b);
    expect(ids).toEqual([101, 102, 103, 104]); // not 100 (root), not 200 (sibling)
  });

  it("is empty for a leaf or an unknown root", () => {
    expect(collectDescendants(tree, 104)).toEqual([]);
    expect(collectDescendants(tree, 99999)).toEqual([]);
  });

  it("is cycle-safe (a ppid loop can't hang or double-count)", () => {
    const cyclic: ProcInfo[] = [
      { pid: 100, ppid: 0, command: "root" },
      { pid: 101, ppid: 100, command: "a" },
      { pid: 102, ppid: 101, command: "b" },
      { pid: 101, ppid: 102, command: "a-dup" }, // 101 ← 102 ← 101 cycle
    ];
    const ids = collectDescendants(cyclic, 100).map((p) => p.pid);
    expect(new Set(ids)).toEqual(new Set([101, 102]));
    expect(ids.length).toBe(2); // no duplicate / infinite loop
  });

  it("ignores a self-parented process (pid === ppid) so it can't self-loop", () => {
    const self: ProcInfo[] = [
      { pid: 100, ppid: 0, command: "root" },
      { pid: 5, ppid: 5, command: "self" },
    ];
    expect(collectDescendants(self, 100)).toEqual([]);
  });
});

describe("mcpServerName", () => {
  it("recognizes common MCP server command lines and names them (incl. python underscore)", () => {
    expect(mcpServerName("npx mcp-server-filesystem /work")).toBe(
      "mcp-server-filesystem"
    );
    expect(mcpServerName("npx @modelcontextprotocol/server-everything")).toBe(
      "server-everything"
    );
    expect(mcpServerName("uvx some-mcp")).toBe("some-mcp");
    expect(mcpServerName("python -m mcp_server_fetch")).toBe(
      "mcp_server_fetch"
    );
    expect(
      mcpServerName("node /home/u/.stoa/repo/mcp/orchestration-server.ts")
    ).toBe("orchestration-server");
  });

  it("returns null for an ordinary process (no MCP marker)", () => {
    expect(mcpServerName("/usr/bin/node /app/server.js")).toBeNull();
    expect(mcpServerName("bash")).toBeNull();
    expect(mcpServerName("")).toBeNull();
    // A bare 'mcp' substring inside another word does NOT trip it (segment-anchored).
    expect(mcpServerName("/usr/bin/decompressor")).toBeNull();
  });

  it("does NOT classify mcp-ish FILES or FLAGS as servers (Gate D red-team)", () => {
    // A file the agent merely touches is not a server.
    expect(mcpServerName("vim src/mcp.ts")).toBeNull();
    expect(mcpServerName("cat /etc/mcp.conf")).toBeNull();
    expect(mcpServerName("tail -f /var/log/mcp.log")).toBeNull();
    expect(mcpServerName("node /app/.mcp/index.js")).toBeNull();
    // The agent's OWN `--mcp-config <file>` flag is config-loading, not a server.
    expect(mcpServerName("claude --mcp-config /x/config.json")).toBeNull();
    expect(mcpServerName("claude --mcp-config=/x/config.json")).toBeNull();
  });
});

describe("fanoutFor", () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, command: "pty-root" },
    { pid: 101, ppid: 100, command: "claude" },
    { pid: 102, ppid: 101, command: "npx mcp-server-filesystem" },
    { pid: 103, ppid: 101, command: "npx mcp-server-github" },
    { pid: 104, ppid: 101, command: "rg --json pattern" },
    { pid: 105, ppid: 102, command: "node helper.js" },
  ];

  it("counts descendants and lists the deduped, sorted MCP servers", () => {
    expect(fanoutFor(procs, 100)).toEqual({
      childCount: 5, // 101,102,103,104,105
      mcpServers: ["mcp-server-filesystem", "mcp-server-github"],
    });
  });

  it("dedupes identical MCP server names across siblings", () => {
    const dup: ProcInfo[] = [
      { pid: 100, ppid: 1, command: "root" },
      { pid: 101, ppid: 100, command: "npx mcp-server-git" },
      { pid: 102, ppid: 100, command: "npx mcp-server-git" },
    ];
    expect(fanoutFor(dup, 100).mcpServers).toEqual(["mcp-server-git"]);
  });

  it("is an empty fan-out for a null/invalid/zero root pid", () => {
    expect(fanoutFor(procs, null)).toEqual({ childCount: 0, mcpServers: [] });
    expect(fanoutFor(procs, undefined)).toEqual({
      childCount: 0,
      mcpServers: [],
    });
    expect(fanoutFor(procs, 0)).toEqual({ childCount: 0, mcpServers: [] });
    expect(fanoutFor(procs, -1)).toEqual({ childCount: 0, mcpServers: [] });
  });
});

describe("WINDOWS_SNAPSHOT_PS (locked command)", () => {
  it("uses Get-CimInstance and emits the |||-delimited triplet", () => {
    expect(WINDOWS_SNAPSHOT_PS).toContain("Get-CimInstance Win32_Process");
    expect(WINDOWS_SNAPSHOT_PS).toContain(
      "$($_.ProcessId)|||$($_.ParentProcessId)|||$($_.CommandLine)"
    );
  });
});
