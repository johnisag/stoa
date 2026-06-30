import { describe, it, expect } from "vitest";
import { parseEnv, portAlias } from "@/lib/load-env";

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

describe("portAlias (STOA_PORT → PORT bridge)", () => {
  it("uses STOA_PORT when only it is set (the npm-run-dev bug)", () => {
    expect(portAlias("4000", undefined)).toBe("4000");
  });

  it("uses PORT when STOA_PORT is unset", () => {
    expect(portAlias(undefined, "5000")).toBe("5000");
  });

  it("lets STOA_PORT win when both are set (mirrors the stoa CLI/doctor)", () => {
    expect(portAlias("4000", "5000")).toBe("4000");
  });

  it("treats an empty STOA_PORT as unset and falls through to PORT", () => {
    expect(portAlias("", "5000")).toBe("5000");
  });

  it("returns undefined when neither is set (server falls back to 3011)", () => {
    expect(portAlias(undefined, undefined)).toBeUndefined();
    expect(portAlias("", "")).toBeUndefined();
  });
});
