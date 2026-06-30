import { describe, it, expect } from "vitest";
import {
  parseNetstatListening,
  parseLsofListening,
} from "@/lib/listening-ports";

describe("parseNetstatListening (Windows netstat -ano)", () => {
  it("extracts {port, pid} from TCP LISTENING rows (IPv4 + IPv6), skips the rest", () => {
    const out = parseNetstatListening(
      [
        "Active Connections",
        "",
        "  Proto  Local Address      Foreign Address    State        PID",
        "  TCP    0.0.0.0:3000       0.0.0.0:0          LISTENING    1234",
        "  TCP    [::]:3000          [::]:0             LISTENING    1234",
        "  TCP    127.0.0.1:8080     0.0.0.0:0          LISTENING    5678",
        "  TCP    127.0.0.1:54321    93.184.216.34:443  ESTABLISHED  9999", // not LISTENING
        "  UDP    0.0.0.0:5353       *:*                            4242", // UDP
      ].join("\r\n")
    );
    expect(out).toEqual([
      { port: 3000, pid: 1234 },
      { port: 3000, pid: 1234 }, // IPv6 dup — dedup happens at attribution time
      { port: 8080, pid: 5678 },
    ]);
  });

  it("is empty for header-only / garbage output", () => {
    expect(parseNetstatListening("Active Connections\n\n")).toEqual([]);
    expect(parseNetstatListening("")).toEqual([]);
  });
});

describe("parseLsofListening (POSIX lsof -F field output)", () => {
  it("associates each n<addr> with the preceding p<pid> record", () => {
    const out = parseLsofListening(
      [
        "p1234",
        "n*:3000",
        "p5678",
        "n127.0.0.1:8080",
        "n[::1]:8080",
        "p9012",
        "n[fe80::1%lo0]:5173",
      ].join("\n")
    );
    expect(out).toEqual([
      { port: 3000, pid: 1234 },
      { port: 8080, pid: 5678 },
      { port: 8080, pid: 5678 }, // IPv6 dup
      { port: 5173, pid: 9012 },
    ]);
  });

  it("ignores n-lines with no preceding pid and unparseable addresses", () => {
    expect(parseLsofListening("n*:3000\np1234\nnGARBAGE\nn*:80")).toEqual([
      { port: 80, pid: 1234 },
    ]);
    expect(parseLsofListening("")).toEqual([]);
  });
});
