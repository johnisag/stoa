import { describe, it, expect } from "vitest";
import { parseEnv } from "@/lib/load-env";

describe("parseEnv (.env parser)", () => {
  it("parses KEY=VALUE, skips comments/blanks, strips quotes, trims", () => {
    const out = parseEnv(
      [
        "# a comment",
        "",
        "STOA_PORT=3012",
        'STOA_PTY_HOST_NAME="stoa-dev"',
        "DB_PATH='./d.db'",
        "NO_EQUALS_LINE",
        "  SPACED  =  value  ",
        "=missing-key",
      ].join("\n")
    );
    expect(out).toEqual({
      STOA_PORT: "3012",
      STOA_PTY_HOST_NAME: "stoa-dev",
      DB_PATH: "./d.db",
      SPACED: "value",
    });
  });

  it("keeps '=' that appear inside the value", () => {
    expect(parseEnv("TOKEN=a=b=c")).toEqual({ TOKEN: "a=b=c" });
  });

  it("does not strip a LONE quote char into an empty string", () => {
    // Regression: a one-char value of just `"` satisfied startsWith+endsWith and
    // sliced to "". A real pair needs length >= 2.
    expect(parseEnv('FOO="')).toEqual({ FOO: '"' });
    expect(parseEnv("BAR='")).toEqual({ BAR: "'" });
    // A real quoted pair still strips.
    expect(parseEnv('BAZ="x"')).toEqual({ BAZ: "x" });
  });
});
