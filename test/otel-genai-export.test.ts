/**
 * OpenTelemetry GenAI trace export (Roadmap #45).
 *
 * Covers the PURE span builders (correct GenAI attributes, injected timestamps),
 * the endpoint-unset no-op (emits nothing, mints nothing), and the OTLP payload
 * shape via a mocked transport (no network). Cross-platform: pure JS/env only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildGenAiAttributes,
  buildGenAiSpan,
  buildOtlpPayload,
  genAiSystemForProvider,
  otelEnabled,
  otelEndpoint,
  otelHeaders,
  tracesUrl,
  msToUnixNano,
  emitSpan,
  emitGenAiEvent,
  setOtlpTransportForTesting,
  type GenAiSpanInput,
  type OtlpTransport,
} from "@/lib/telemetry/otel";

// A fixed, clock-free input the pure builders can be asserted against.
const BASE_INPUT: GenAiSpanInput = {
  operation: "run",
  system: "anthropic",
  model: "claude-opus-4-8",
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000001000000000",
  inputTokens: 1200,
  outputTokens: 340,
};

function attrMap(attrs: ReturnType<typeof buildGenAiAttributes>) {
  const m: Record<string, unknown> = {};
  for (const a of attrs) {
    m[a.key] = Object.values(a.value)[0];
  }
  return m;
}

describe("buildGenAiAttributes (pure)", () => {
  it("emits the GenAI semantic-convention attributes", () => {
    const m = attrMap(buildGenAiAttributes(BASE_INPUT));
    expect(m["gen_ai.system"]).toBe("anthropic");
    expect(m["gen_ai.operation.name"]).toBe("run");
    expect(m["gen_ai.request.model"]).toBe("claude-opus-4-8");
    // OTLP encodes ints as decimal STRINGS.
    expect(m["gen_ai.usage.input_tokens"]).toBe("1200");
    expect(m["gen_ai.usage.output_tokens"]).toBe("340");
  });

  it("omits model / token attributes when not provided", () => {
    const m = attrMap(
      buildGenAiAttributes({
        operation: "turn",
        system: "openai",
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
      })
    );
    expect(m["gen_ai.request.model"]).toBeUndefined();
    expect(m["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(m["gen_ai.usage.output_tokens"]).toBeUndefined();
    expect(m["gen_ai.system"]).toBe("openai");
    expect(m["gen_ai.operation.name"]).toBe("turn");
  });

  it("emits gen_ai.tool.name for a tool span", () => {
    const m = attrMap(
      buildGenAiAttributes({
        operation: "tool",
        system: "anthropic",
        toolName: "spawn_worker",
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
      })
    );
    expect(m["gen_ai.tool.name"]).toBe("spawn_worker");
  });

  it("encodes extra attributes by JS type (string/int/bool) and drops empties", () => {
    const m = attrMap(
      buildGenAiAttributes({
        ...BASE_INPUT,
        extra: {
          "stoa.session.id": "sess-1",
          "stoa.count": 3,
          "stoa.flag": true,
          "stoa.skip": "",
          "stoa.also-skip": null,
        },
      })
    );
    expect(m["stoa.session.id"]).toBe("sess-1");
    expect(m["stoa.count"]).toBe("3"); // intValue → decimal string
    expect(m["stoa.flag"]).toBe(true);
    expect(m["stoa.skip"]).toBeUndefined();
    expect(m["stoa.also-skip"]).toBeUndefined();
  });

  it("treats input tokens of 0 as present (not falsy-dropped)", () => {
    const m = attrMap(
      buildGenAiAttributes({ ...BASE_INPUT, inputTokens: 0, outputTokens: 0 })
    );
    expect(m["gen_ai.usage.input_tokens"]).toBe("0");
    expect(m["gen_ai.usage.output_tokens"]).toBe("0");
  });
});

describe("buildGenAiSpan (pure, timestamps injected)", () => {
  it("uses the injected timestamps verbatim, not Date.now()", () => {
    const span = buildGenAiSpan(BASE_INPUT);
    expect(span.startTimeUnixNano).toBe("1700000000000000000");
    expect(span.endTimeUnixNano).toBe("1700000001000000000");
  });

  it("is deterministic — same input yields byte-identical spans", () => {
    expect(JSON.stringify(buildGenAiSpan(BASE_INPUT))).toBe(
      JSON.stringify(buildGenAiSpan(BASE_INPUT))
    );
  });

  it("defaults the span name to '<operation> <model>' and kind=CLIENT", () => {
    const span = buildGenAiSpan(BASE_INPUT);
    expect(span.name).toBe("run claude-opus-4-8");
    expect(span.kind).toBe(3); // CLIENT
  });

  it("falls back to the system in the name when no model", () => {
    const span = buildGenAiSpan({ ...BASE_INPUT, model: undefined });
    expect(span.name).toBe("run anthropic");
  });

  it("carries trace/span/parent ids and status through", () => {
    const span = buildGenAiSpan({
      ...BASE_INPUT,
      parentSpanId: "ffffffffffffffff",
      statusCode: 2,
      statusMessage: "boom",
    });
    expect(span.traceId).toBe(BASE_INPUT.traceId);
    expect(span.spanId).toBe(BASE_INPUT.spanId);
    expect(span.parentSpanId).toBe("ffffffffffffffff");
    expect(span.status).toEqual({ code: 2, message: "boom" });
  });

  it("omits parentSpanId when not set and defaults status to UNSET", () => {
    const span = buildGenAiSpan(BASE_INPUT);
    expect(span.parentSpanId).toBeUndefined();
    expect(span.status).toEqual({ code: 0 });
  });
});

describe("buildOtlpPayload (pure, OTLP/HTTP JSON shape)", () => {
  it("wraps spans in the resourceSpans/scopeSpans envelope", () => {
    const span = buildGenAiSpan(BASE_INPUT);
    const payload = buildOtlpPayload([span]);
    expect(payload.resourceSpans).toHaveLength(1);
    const rs = payload.resourceSpans[0];
    // service.name resource attribute is required by OTLP consumers.
    expect(rs.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "stoa" },
    });
    expect(rs.scopeSpans).toHaveLength(1);
    expect(rs.scopeSpans[0].spans).toEqual([span]);
    expect(rs.scopeSpans[0].scope.name).toBe("stoa.orchestration");
  });

  it("honors a custom service name", () => {
    const payload = buildOtlpPayload([buildGenAiSpan(BASE_INPUT)], "custom");
    expect(payload.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "custom" },
    });
  });
});

describe("genAiSystemForProvider", () => {
  it("maps claude→anthropic and codex→openai (OTel vendor names)", () => {
    expect(genAiSystemForProvider("claude")).toBe("anthropic");
    expect(genAiSystemForProvider("codex")).toBe("openai");
  });
  it("passes an unregistered provider id through verbatim", () => {
    expect(genAiSystemForProvider("hermes")).toBe("hermes");
    expect(genAiSystemForProvider("kilo")).toBe("kilo");
  });
});

describe("tracesUrl / otelHeaders / msToUnixNano (pure helpers)", () => {
  it("appends /v1/traces to a base endpoint but not to a full traces URL", () => {
    expect(tracesUrl("http://localhost:4318")).toBe(
      "http://localhost:4318/v1/traces"
    );
    expect(tracesUrl("http://localhost:4318/")).toBe(
      "http://localhost:4318/v1/traces"
    );
    expect(tracesUrl("http://collector/v1/traces")).toBe(
      "http://collector/v1/traces"
    );
  });

  it("parses k=v header pairs and ignores malformed entries", () => {
    expect(otelHeaders("Authorization=Bearer x,x-tenant=acme")).toEqual({
      Authorization: "Bearer x",
      "x-tenant": "acme",
    });
    expect(otelHeaders("=novalue,noequals,ok=1")).toEqual({ ok: "1" });
    expect(otelHeaders(undefined)).toEqual({});
    expect(otelHeaders("")).toEqual({});
  });

  it("converts ms to the OTLP nanosecond string without float loss", () => {
    expect(msToUnixNano(1700000000000)).toBe("1700000000000000000");
    expect(msToUnixNano(0)).toBe("0000000"); // 0 * 1e6 as string
  });
});

describe("endpoint-unset no-op (default OFF)", () => {
  const OLD = process.env.STOA_OTEL_ENDPOINT;
  beforeEach(() => {
    delete process.env.STOA_OTEL_ENDPOINT;
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.STOA_OTEL_ENDPOINT;
    else process.env.STOA_OTEL_ENDPOINT = OLD;
  });

  it("otelEnabled() is false and otelEndpoint() is null when unset/blank", () => {
    expect(otelEndpoint()).toBeNull();
    expect(otelEnabled()).toBe(false);
    process.env.STOA_OTEL_ENDPOINT = "   ";
    expect(otelEndpoint()).toBeNull();
    expect(otelEnabled()).toBe(false);
  });

  it("emitSpan touches the transport ZERO times when unconfigured", async () => {
    const transport = vi.fn<OtlpTransport>(async () => {});
    const restore = setOtlpTransportForTesting(transport);
    try {
      await emitSpan(BASE_INPUT);
      await emitGenAiEvent({
        operation: "run",
        provider: "claude",
        startMs: 1,
        endMs: 2,
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("emit via mocked transport (configured)", () => {
  const OLD = process.env.STOA_OTEL_ENDPOINT;
  beforeEach(() => {
    process.env.STOA_OTEL_ENDPOINT = "http://localhost:4318";
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.STOA_OTEL_ENDPOINT;
    else process.env.STOA_OTEL_ENDPOINT = OLD;
  });

  it("POSTs a well-formed OTLP payload to /v1/traces", async () => {
    const calls: { url: string; body: string }[] = [];
    const restore = setOtlpTransportForTesting(async (url, body) => {
      calls.push({ url, body });
    });
    try {
      await emitSpan(BASE_INPUT);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:4318/v1/traces");
      const parsed = JSON.parse(calls[0].body);
      const span = parsed.resourceSpans[0].scopeSpans[0].spans[0];
      expect(span.traceId).toBe(BASE_INPUT.traceId);
      const attrs = attrMap(span.attributes);
      expect(attrs["gen_ai.system"]).toBe("anthropic");
      expect(attrs["gen_ai.request.model"]).toBe("claude-opus-4-8");
    } finally {
      restore();
    }
  });

  it("emitGenAiEvent maps provider→system and mints ids when absent", async () => {
    let captured: string | null = null;
    const restore = setOtlpTransportForTesting(async (_url, body) => {
      captured = body;
    });
    try {
      await emitGenAiEvent({
        operation: "tool",
        provider: "codex",
        model: "gpt-5.5",
        startMs: 1_700_000_000_000,
        endMs: 1_700_000_000_500,
        toolName: "run_pipeline",
      });
      expect(captured).not.toBeNull();
      const span = JSON.parse(captured!).resourceSpans[0].scopeSpans[0]
        .spans[0];
      // A 128-bit trace id and 64-bit span id were minted (hex).
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      const attrs = attrMap(span.attributes);
      expect(attrs["gen_ai.system"]).toBe("openai");
      expect(attrs["gen_ai.tool.name"]).toBe("run_pipeline");
    } finally {
      restore();
    }
  });

  it("NEVER throws when the transport rejects (best-effort, swallowed)", async () => {
    const restore = setOtlpTransportForTesting(async () => {
      throw new Error("network down");
    });
    try {
      // Must resolve, not reject.
      await expect(emitSpan(BASE_INPUT)).resolves.toBeUndefined();
      await expect(
        emitGenAiEvent({
          operation: "run",
          provider: "claude",
          startMs: 1,
          endMs: 2,
        })
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });
});
