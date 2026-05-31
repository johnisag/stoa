import { describe, it, expect } from "vitest";
import {
  encode,
  createDecoder,
  type HostMessage,
} from "@/lib/session-backend/pty/protocol";

function collect() {
  const got: HostMessage[] = [];
  const decode = createDecoder<HostMessage>((m) => got.push(m));
  return { got, decode };
}

describe("pty-host IPC protocol framing", () => {
  it("encode appends a newline; decoder round-trips one message", () => {
    const { got, decode } = collect();
    decode(encode({ t: "res", id: 1, ok: true }));
    expect(got).toEqual([{ t: "res", id: 1, ok: true }]);
  });

  it("reassembles a message split across chunks", () => {
    const { got, decode } = collect();
    const s = encode({ t: "output", key: "k", data: "hello world" });
    decode(s.slice(0, 6));
    expect(got).toHaveLength(0);
    decode(s.slice(6));
    expect(got).toEqual([{ t: "output", key: "k", data: "hello world" }]);
  });

  it("decodes multiple messages in one chunk and skips blank/malformed lines", () => {
    const { got, decode } = collect();
    decode(
      encode({ t: "res", id: 1, ok: true }) +
        "\n" + // blank line
        "{not valid json}\n" + // malformed
        encode({ t: "res", id: 2, ok: true })
    );
    expect(got).toEqual([
      { t: "res", id: 1, ok: true },
      { t: "res", id: 2, ok: true },
    ]);
  });

  it("preserves newlines and ANSI control chars inside data (JSON-escaped)", () => {
    const { got, decode } = collect();
    const data = "row1\r\nrow2[2J[H";
    decode(encode({ t: "output", key: "k", data }));
    expect(got).toHaveLength(1);
    expect((got[0] as { data: string }).data).toBe(data);
  });

  it("resets an oversized buffer with no delimiter, then keeps decoding", () => {
    const { got, decode } = collect();
    decode("x".repeat(17 * 1024 * 1024)); // > 16MB cap, no newline -> dropped
    decode(encode({ t: "res", id: 9, ok: true }));
    expect(got).toEqual([{ t: "res", id: 9, ok: true }]);
  });
});
