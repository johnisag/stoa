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

describe("pty-host IPC protocol framing (length-prefixed binary)", () => {
  it("round-trips a control message", () => {
    const { got, decode } = collect();
    decode(encode({ t: "res", id: 1, ok: true }));
    expect(got).toEqual([{ t: "res", id: 1, ok: true }]);
  });

  it("reassembles a frame split across two chunks", () => {
    const { got, decode } = collect();
    const buf = encode({ t: "output", key: "k", data: "hello world" });
    decode(buf.subarray(0, 6)); // split mid-frame (after the length prefix)
    expect(got).toHaveLength(0);
    decode(buf.subarray(6));
    expect(got).toEqual([{ t: "output", key: "k", data: "hello world" }]);
  });

  it("decodes multiple frames delivered in one chunk", () => {
    const { got, decode } = collect();
    decode(
      Buffer.concat([
        encode({ t: "res", id: 1, ok: true }),
        encode({ t: "output", key: "k", data: "hi" }),
        encode({ t: "exit", key: "k", code: 0 }),
      ])
    );
    expect(got).toEqual([
      { t: "res", id: 1, ok: true },
      { t: "output", key: "k", data: "hi" },
      { t: "exit", key: "k", code: 0 },
    ]);
  });

  it("carries raw ANSI/control bytes in output verbatim (no JSON escaping)", () => {
    const { got, decode } = collect();
    // ESC, clear-screen, cursor-home, CR/LF, NUL, BEL — the bytes a terminal
    // actually streams. These round-trip exactly; this is the whole point of the
    // raw output frame vs the old JSON-escaped path.
    const data = "\x1b[2J\x1b[Hrow1\r\nrow2\x00\x07";
    decode(encode({ t: "output", key: "term-1", data }));
    expect(got).toEqual([{ t: "output", key: "term-1", data }]);
  });

  it("reassembles a frame fed one byte at a time (multi-byte UTF-8 safe)", () => {
    const { got, decode } = collect();
    // 1-, 2-, 3-, and 4-byte UTF-8 code points. Feeding one byte at a time
    // crosses every boundary, including mid-character — the decoder must only
    // stringify a fully-buffered payload, so this never corrupts a code point.
    const data = "héllo → 🚀 末";
    const buf = encode({ t: "output", key: "k", data });
    for (let i = 0; i < buf.length; i++) decode(buf.subarray(i, i + 1));
    expect(got).toEqual([{ t: "output", key: "k", data }]);
  });

  it("skips a malformed JSON frame and keeps decoding", () => {
    const { got, decode } = collect();
    // Hand-craft a KIND_JSON (tag byte 1) frame whose body is invalid JSON.
    const body = Buffer.from("{not json}", "utf8");
    const payload = Buffer.concat([Buffer.from([1]), body]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length, 0);
    decode(Buffer.concat([len, payload]));
    decode(encode({ t: "res", id: 2, ok: true }));
    expect(got).toEqual([{ t: "res", id: 2, ok: true }]);
  });

  it("skips a short/corrupt OUTPUT-tagged frame without throwing, then keeps decoding", () => {
    const { got, decode } = collect();
    // length prefix = 1, then a single payload byte 0x02 (KIND_OUTPUT). The old
    // unguarded code did payload.readUInt16BE(1) on a 1-byte buffer -> throw,
    // uncaught in the socket 'data' handler -> daemon crash. Must be skipped.
    const bogus = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x02]);
    expect(() => decode(bogus)).not.toThrow();
    decode(encode({ t: "res", id: 7, ok: true }));
    expect(got).toEqual([{ t: "res", id: 7, ok: true }]);
  });

  it("skips an OUTPUT frame whose keyLen exceeds the payload (no mis-split), then keeps decoding", () => {
    const { got, decode } = collect();
    // [tag=0x02][keyLen=200][A][B] — keyLen far exceeds the 2 available bytes,
    // which would silently mis-split key/data; the decoder must drop it instead.
    const payload = Buffer.from([0x02, 0x00, 0xc8, 0x41, 0x42]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length, 0);
    decode(Buffer.concat([len, payload]));
    expect(got).toHaveLength(0);
    decode(encode({ t: "output", key: "k", data: "ok" }));
    expect(got).toEqual([{ t: "output", key: "k", data: "ok" }]);
  });

  it("drops a frame whose length prefix exceeds the cap, then keeps decoding", () => {
    const { got, decode } = collect();
    const bogus = Buffer.alloc(4);
    bogus.writeUInt32BE(17 * 1024 * 1024, 0); // > 16 MB cap
    decode(bogus);
    decode(encode({ t: "res", id: 9, ok: true }));
    expect(got).toEqual([{ t: "res", id: 9, ok: true }]);
  });
});
