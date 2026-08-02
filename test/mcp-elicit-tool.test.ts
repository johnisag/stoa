/**
 * MCP elicitation tool formatter (#48) — the tool's text result. A decline /
 * cancel / expiry / timeout is a NORMAL outcome and must NOT be rendered with an
 * "Error:" prefix (else toolResultStatus in orchestration-server counts a routine
 * operator refusal as a tool failure, inflating error rates).
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { formatElicitResult, handleToolCall } from "../mcp/orchestration-tools";

afterEach(() => vi.unstubAllGlobals());

describe("formatElicitResult", () => {
  it("renders accepted input as a readable list (no Error prefix)", () => {
    const text = formatElicitResult({
      status: "answered",
      action: "accept",
      content: { target: "prod", count: 7, confirm: true },
    });
    expect(text).toContain("- target: prod");
    expect(text).toContain("- count: 7");
    expect(text).toContain("- confirm: true");
    expect(text.startsWith("Error:")).toBe(false);
  });

  it("renders decline / cancel / expired / timeout as non-error outcomes", () => {
    for (const r of [
      { status: "answered", action: "decline", content: null },
      { status: "answered", action: "cancel", content: null },
      { status: "expired", action: null, content: null },
      { status: "timeout", action: null, content: null },
      { status: "unknown", action: null, content: null },
    ]) {
      const text = formatElicitResult(r);
      expect(text.length).toBeGreaterThan(0);
      expect(text.startsWith("Error:")).toBe(false);
    }
  });

  it("stops a pending poll when SDK v2 cancels the request context", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (fetchMock.mock.calls.length === 1) {
          return {
            json: async () => ({ elicitationId: "elicit-1" }),
          } as Response;
        }
        expect(init?.signal).toBe(controller.signal);
        return {
          json: async () => ({
            status: "pending",
            action: null,
            content: null,
          }),
        } as Response;
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = handleToolCall(
      {
        params: {
          name: "request_operator_input",
          arguments: {
            conductorId: "session-1",
            message: "Continue?",
            fields: [{ key: "confirm", type: "boolean" }],
          },
        },
      },
      { signal: controller.signal }
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort(new Error("client disconnected"));
    await expect(pending).rejects.toThrow("client disconnected");
  });
});
