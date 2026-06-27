/**
 * Inter-agent channel delivery — the pure PUSH-side policy + the hardened terminal
 * wrapper (no I/O). Locks the turn-boundary gate, the env flag, the control-byte
 * sanitizer (so a message can't drive the recipient's terminal), and the directive
 * wrapper framing.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  channelDeliverEnabled,
  isChannelDeliveryTurn,
  sanitizeChannelBodyForTerminal,
  buildChannelDeliveryText,
} from "@/lib/channel-delivery";

describe("channelDeliverEnabled", () => {
  const prev = process.env.STOA_AUTO_CHANNEL_DELIVER;
  afterEach(() => {
    if (prev === undefined) delete process.env.STOA_AUTO_CHANNEL_DELIVER;
    else process.env.STOA_AUTO_CHANNEL_DELIVER = prev;
  });

  it("is off unless explicitly '1'", () => {
    delete process.env.STOA_AUTO_CHANNEL_DELIVER;
    expect(channelDeliverEnabled()).toBe(false);
    process.env.STOA_AUTO_CHANNEL_DELIVER = "0";
    expect(channelDeliverEnabled()).toBe(false);
    process.env.STOA_AUTO_CHANNEL_DELIVER = "true";
    expect(channelDeliverEnabled()).toBe(false);
    process.env.STOA_AUTO_CHANNEL_DELIVER = "1";
    expect(channelDeliverEnabled()).toBe(true);
  });
});

describe("isChannelDeliveryTurn", () => {
  it("delivers only at a settled, prompt-free idle turn", () => {
    expect(isChannelDeliveryTurn({ status: "idle", hasPrompt: false })).toBe(
      true
    );
  });

  it("never mid-thought, into a prompt, or an errored/dead pane", () => {
    expect(isChannelDeliveryTurn({ status: "running", hasPrompt: false })).toBe(
      false
    );
    expect(isChannelDeliveryTurn({ status: "waiting", hasPrompt: false })).toBe(
      false
    );
    expect(isChannelDeliveryTurn({ status: "idle", hasPrompt: true })).toBe(
      false
    );
    expect(isChannelDeliveryTurn({ status: "error", hasPrompt: false })).toBe(
      false
    );
    expect(isChannelDeliveryTurn({ status: "dead", hasPrompt: false })).toBe(
      false
    );
  });
});

describe("sanitizeChannelBodyForTerminal", () => {
  it("strips ANSI/escape sequences and C0 controls but keeps tabs/newlines", () => {
    const dirty = "a\x1b[31mred\x1b[0m\tb\nc\x07\x00d";
    const clean = sanitizeChannelBodyForTerminal(dirty);
    expect(clean).toBe("ared\tb\ncd");
    expect(clean).not.toMatch(/\x1b/);
  });

  it("leaves a plain code snippet intact", () => {
    const code = "function f() {\n\treturn 1;\n}";
    expect(sanitizeChannelBodyForTerminal(code)).toBe(code);
  });

  it("strips OSC string sequences (introducer + payload + terminator)", () => {
    // OSC set-window-title with a BEL terminator, and one with an ST terminator.
    expect(sanitizeChannelBodyForTerminal("a\x1b]0;pwned\x07b")).toBe("ab");
    expect(sanitizeChannelBodyForTerminal("a\x1b]0;pwned\x1b\\b")).toBe("ab");
    // An unterminated OSC (no BEL/ST) is consumed to end-of-string, not left raw.
    expect(sanitizeChannelBodyForTerminal("ok\x1b]0;dangling")).toBe("ok");
  });

  it("strips escapes with intermediate bytes (charset designation, DEC screen test)", () => {
    expect(sanitizeChannelBodyForTerminal("x\x1b(Bcharset")).toBe("xcharset"); // ESC ( B
    expect(sanitizeChannelBodyForTerminal("x\x1b#8fill")).toBe("xfill"); // ESC # 8
    expect(sanitizeChannelBodyForTerminal("ok\x1bc")).toBe("ok"); // ESC c (full reset) — 2-byte escape stripped
    expect(sanitizeChannelBodyForTerminal("trailing\x1b")).toBe("trailing"); // a lone trailing ESC
  });

  it("strips carriage returns (no visible ^M when pasted into a tmux pane)", () => {
    expect(sanitizeChannelBodyForTerminal("line1\r\nline2")).toBe(
      "line1\nline2"
    );
    expect(sanitizeChannelBodyForTerminal("a\rb")).toBe("ab");
  });
});

describe("buildChannelDeliveryText", () => {
  it("is directive: names the sender, frames it as another agent, gives the reply call", () => {
    const text = buildChannelDeliveryText({
      from_session_id: "abcdef0123456789",
      body: "use the column name agent_id",
    });
    expect(text).toContain("abcdef01"); // short id
    expect(text).toContain("abcdef0123456789"); // full id (for the reply)
    expect(text).toMatch(/another Stoa agent/i);
    expect(text).toContain('channel_send with to:"abcdef0123456789"');
    expect(text).toContain("use the column name agent_id");
  });

  it("sanitizes the body it injects", () => {
    const text = buildChannelDeliveryText({
      from_session_id: "s1",
      body: "evil\x1b[2J\x1b[Hclear",
    });
    expect(text).not.toMatch(/\x1b/);
    expect(text).toContain("evilclear");
  });
});
