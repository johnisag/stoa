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
});
