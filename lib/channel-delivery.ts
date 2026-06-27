/**
 * Inter-agent channel delivery — the PUSH side of channels (the PULL side is
 * lib/channels.ts). This is the pure decision core + the hardened terminal wrapper
 * for amux's "safe injection": at a clean turn boundary the server may inject ONE
 * unread channel message into the recipient's terminal so a sibling worker doesn't
 * have to poll. It mirrors the rate-limit / watchdog modules — the policy lives
 * here (no I/O, unit-tested) and server.ts owns the side effect (the pasteText).
 *
 * OFF BY DEFAULT. Writing into a session unattended is the risky part (the same
 * stance as STOA_AUTO_RESUME / STOA_AUTO_ANSWER), so the push only happens when
 * STOA_AUTO_CHANNEL_DELIVER=1. With it off, channels are purely pull-based — an
 * agent reads its inbox on demand and nothing touches its terminal.
 *
 * amux's hard-won lesson (amux-server.py:8355-8461): make the injected wrapper
 * DIRECTIVE and unambiguous, or the agent reads the message as documentation and
 * narrates it to the user instead of acting/replying. Hence the explicit
 * "this is from another agent, here's the exact tool to reply" framing.
 */

/** Is the opt-in turn-boundary terminal delivery armed? Off by default
 * (STOA_AUTO_CHANNEL_DELIVER=1 enables). server.ts reads this ONCE at startup into
 * a const (like watchdogEnabled / autoResumeEnabled), so a running server's
 * behavior is fixed for its lifetime; it's a function only so a test can set the
 * env and call it directly. */
export function channelDeliverEnabled(): boolean {
  return process.env.STOA_AUTO_CHANNEL_DELIVER === "1";
}

/**
 * Pure: is this session at a clean turn boundary to receive a pushed message?
 * Deliver ONLY when the session is settled-and-ready ("idle") with no open prompt
 * — never mid-thought ("running"), never into a pending permission/input dialog
 * ("waiting"+prompt), never an errored/dead pane. This is the SAME gate the
 * prompt-queue dispatch uses, and the stricter Stoa reading of amux's
 * "waiting/idle only" turn-boundary steer queue. Unit-tested.
 */
export function isChannelDeliveryTurn(input: {
  status: string;
  hasPrompt: boolean;
}): boolean {
  return input.status === "idle" && !input.hasPrompt;
}

/**
 * Strip anything that could let a message body drive the recipient's terminal
 * rather than just be read by the agent: ANSI/escape sequences and C0 control
 * bytes (keep \n and \t — normal text/code). The stored body is untouched; only
 * the injected copy is sanitized, a defense-in-depth at the one boundary where a
 * message becomes keystrokes. Pure.
 */
export function sanitizeChannelBodyForTerminal(body: string): string {
  return (
    body
      // OSC/DCS/SOS/PM/APC string sequences: ESC + ] P X ^ _ then a payload up to
      // a BEL or ST terminator (or end of string). Stripped FIRST so the escape
      // rules below don't peel off just the introducer and leave the payload.
      .replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
      .replace(/\x1b\[[0-9;?]*[\x20-\x2f]*[@-~]/g, "") // CSI sequences
      // Any other (nF) escape sequence: ESC, optional intermediate bytes (0x20–
      // 0x2f, e.g. charset designation `ESC ( B`), then a final byte (0x30–0x7e —
      // wider than CSI's, covering the DEC screen test `ESC # 8` and 2-byte
      // escapes like the dangerous full-reset `ESC c`).
      .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
      .replace(/\x1b/g, "") // any stray/dangling ESC with no final byte
      // C0 controls except TAB (\x09) and LF (\x0a) — this DOES strip CR (\x0d) so
      // a CRLF body can't leave a visible ^M when pasted into a tmux pane.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
  );
}

/**
 * Build the hardened wrapper injected into the recipient's terminal for one
 * message. Directive and unambiguous (amux's lesson): it names the sender, states
 * plainly that this is an automated relay from another agent (not the human, not
 * docs), and gives the exact MCP call to reply. Pure → unit-tested.
 */
export function buildChannelDeliveryText(msg: {
  from_session_id: string;
  body: string;
}): string {
  const from = msg.from_session_id;
  const fromShort = from.slice(0, 8);
  const body = sanitizeChannelBodyForTerminal(msg.body);
  return [
    `[stoa channel] Message from teammate agent ${fromShort} (session ${from}).`,
    `This is an automated relay from ANOTHER Stoa agent — not from your human operator, and not documentation. It expects you to act on it or reply.`,
    `To reply, call the MCP tool channel_send with to:"${from}" and your message — do not narrate this to the user.`,
    ``,
    `Message:`,
    body,
  ].join("\n");
}
