/**
 * OpenTelemetry GenAI trace export (Roadmap #45).
 *
 * A NO-OP-unless-configured OTLP/HTTP-JSON exporter that emits GenAI
 * semantic-convention spans for orchestration events (a run, a turn/step, a
 * tool call, a model invocation).
 *
 * ## Default OFF — zero overhead when unconfigured
 * Nothing is emitted, no timers spin, and no network is touched unless
 * `STOA_OTEL_ENDPOINT` is set. `otelEnabled()` is the single guard every emit
 * path checks FIRST, so an unconfigured deployment pays only a cheap env read.
 *
 * ## Dependency-light on purpose
 * The repo does not ship the (heavy) `@opentelemetry` SDK, so this is a
 * hand-rolled OTLP/HTTP-JSON producer: pure builders shape the exact
 * `resourceSpans` JSON the OTLP/HTTP endpoint expects, and the transport is a
 * single `fetch` POST. No new dependency is added.
 *
 * ## Best-effort — never throws into a run
 * Every exported emit is fire-and-forget and fully swallowed: a bad endpoint, a
 * DNS failure, or a non-2xx response can NOT surface as an exception inside the
 * orchestration path (AGENTS.md: don't break a run for telemetry).
 *
 * The span BUILDERS are pure (timestamps injected, never `Date.now()` inside)
 * so they are unit-testable without a clock or a network.
 */
import { PROVIDER_MAP, type ProviderId } from "../providers/registry";

/** The GenAI operation a span describes (OTel `gen_ai.operation.name`). */
export type GenAiOperation =
  "run" | "turn" | "tool" | "chat" | "invoke_agent" | "execute_tool";

/** A single OTLP key/value attribute (string|int|bool|double variants). */
export interface OtlpAttribute {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { boolValue: boolean }
    | { doubleValue: number };
}

/** The minimal OTLP span shape we emit (subset of the OTLP/HTTP JSON schema). */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** SpanKind — 3 = CLIENT (a call the agent makes out to a model/tool). */
  kind: number;
  /** Unix nanoseconds as a decimal string (OTLP requires string, not number). */
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}

/** Fields describing one GenAI event, fed to the pure span builder. */
export interface GenAiSpanInput {
  operation: GenAiOperation;
  /** The GenAI system, e.g. "anthropic" / "openai" (gen_ai.system). */
  system: string;
  /** The requested model id (gen_ai.request.model). Omit if unknown. */
  model?: string | null;
  /** Human span name; defaults to "<operation> <model|system>". */
  name?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Injected — the builders NEVER read the clock themselves. */
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  /** Token usage (gen_ai.usage.input_tokens / output_tokens). */
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Tool name for a tool/execute_tool span (gen_ai.tool.name). */
  toolName?: string | null;
  /** OTel status code: 0 UNSET, 1 OK, 2 ERROR. Default UNSET. */
  statusCode?: 0 | 1 | 2;
  statusMessage?: string;
  /** Extra flat string attributes (e.g. stoa.session.id). */
  extra?: Record<string, string | number | boolean | null | undefined>;
}

const SERVICE_NAME = "stoa";

/**
 * Map a Stoa provider id to a GenAI `gen_ai.system` value. The OTel registry
 * uses vendor names ("anthropic", "openai") rather than product names, so
 * claude→anthropic and codex→openai; agents without a registry entry fall back
 * to their own id (a stable, if non-registry, system label).
 */
export function genAiSystemForProvider(provider: string): string {
  switch (provider) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    default:
      // hermes / kilo / kimi / anything new: use the provider id verbatim.
      return provider;
  }
}

/** True when a provider id is a known Stoa provider (kept for callers). */
export function isKnownProvider(id: string): id is ProviderId {
  return PROVIDER_MAP.has(id as ProviderId);
}

/** Build a string-valued OTLP attribute. */
function strAttr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/** Build an int-valued OTLP attribute (OTLP encodes ints as decimal strings). */
function intAttr(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

/**
 * Build the OTLP attributes for a GenAI span, per the GenAI semantic
 * conventions. Pure and deterministic — no clock, no env, no I/O. Only the
 * fields that are present are emitted (no `null`/`undefined` attributes).
 */
export function buildGenAiAttributes(input: GenAiSpanInput): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [
    strAttr("gen_ai.system", input.system),
    strAttr("gen_ai.operation.name", input.operation),
  ];
  if (input.model != null && input.model !== "") {
    attrs.push(strAttr("gen_ai.request.model", input.model));
  }
  if (input.toolName != null && input.toolName !== "") {
    attrs.push(strAttr("gen_ai.tool.name", input.toolName));
  }
  if (typeof input.inputTokens === "number") {
    attrs.push(intAttr("gen_ai.usage.input_tokens", input.inputTokens));
  }
  if (typeof input.outputTokens === "number") {
    attrs.push(intAttr("gen_ai.usage.output_tokens", input.outputTokens));
  }
  if (input.extra) {
    for (const [key, value] of Object.entries(input.extra)) {
      if (value == null || value === "") continue;
      if (typeof value === "boolean") {
        attrs.push({ key, value: { boolValue: value } });
      } else if (typeof value === "number") {
        attrs.push(intAttr(key, value));
      } else {
        attrs.push(strAttr(key, String(value)));
      }
    }
  }
  return attrs;
}

/**
 * Build a single GenAI OTLP span from an event. PURE — timestamps are injected
 * by the caller (never `Date.now()` here), so the same input always yields the
 * same span. This is the seam the unit tests exercise without a network.
 */
export function buildGenAiSpan(input: GenAiSpanInput): OtlpSpan {
  const name =
    input.name && input.name.trim()
      ? input.name
      : `${input.operation} ${input.model || input.system}`;
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    name,
    // CLIENT: the agent is the caller reaching out to a model/tool.
    kind: 3,
    startTimeUnixNano: input.startTimeUnixNano,
    endTimeUnixNano: input.endTimeUnixNano,
    attributes: buildGenAiAttributes(input),
    status: {
      code: input.statusCode ?? 0,
      ...(input.statusMessage ? { message: input.statusMessage } : {}),
    },
  };
}

/**
 * Wrap one or more spans into a full OTLP/HTTP-JSON `resourceSpans` payload —
 * exactly the body an OTLP/HTTP `/v1/traces` endpoint accepts. Pure: the shape
 * is fully determined by its inputs, so a test can assert the JSON directly.
 */
export function buildOtlpPayload(
  spans: OtlpSpan[],
  serviceName: string = SERVICE_NAME
): {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
} {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [strAttr("service.name", serviceName)],
        },
        scopeSpans: [
          {
            scope: { name: "stoa.orchestration", version: "1.0.0" },
            spans,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Runtime guard + transport (the impure edge). Everything above is pure.
// ---------------------------------------------------------------------------

/**
 * The configured OTLP endpoint, or null when telemetry is OFF. Read live (not
 * cached at import) so a test can toggle the env var, and so the module has zero
 * side effects at import time.
 */
export function otelEndpoint(): string | null {
  const raw = process.env.STOA_OTEL_ENDPOINT;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** True when export is configured. The single guard every emit path checks. */
export function otelEnabled(): boolean {
  return otelEndpoint() !== null;
}

/**
 * The full traces URL. Accepts either a base endpoint (…:4318) — to which the
 * standard `/v1/traces` path is appended — or an already-complete traces URL
 * (ending in `/v1/traces`), which is used as-is.
 */
export function tracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

/** Optional OTLP headers from STOA_OTEL_HEADERS ("k1=v1,k2=v2"). Never throws. */
export function otelHeaders(
  raw: string | undefined = process.env.STOA_OTEL_HEADERS
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

/**
 * The transport seam. Real impl POSTs the OTLP JSON with `fetch`; tests inject
 * a fake to capture the payload without a network. Any implementation MUST be
 * best-effort (never reject in a way that escapes `emitSpan`).
 */
export type OtlpTransport = (
  url: string,
  body: string,
  headers: Record<string, string>
) => Promise<void>;

/** The default transport: a fire-and-forget `fetch` POST. */
const fetchTransport: OtlpTransport = async (url, body, headers) => {
  // `fetch` is global on Node 18+ (the repo's runtime). Guard anyway so a
  // stripped runtime degrades to a silent no-op rather than a ReferenceError.
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== "function") return;
  await f(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
};

let transport: OtlpTransport = fetchTransport;

/** Override the transport (tests). Returns a restore fn. */
export function setOtlpTransportForTesting(t: OtlpTransport): () => void {
  const prev = transport;
  transport = t;
  return () => {
    transport = prev;
  };
}

/** 16 random bytes hex → a 128-bit OTLP trace id. */
export function newTraceId(): string {
  return randomHex(16);
}

/** 8 random bytes hex → a 64-bit OTLP span id. */
export function newSpanId(): string {
  return randomHex(8);
}

function randomHex(bytes: number): string {
  let out = "";
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

/** Convert a Unix-millisecond timestamp to the OTLP nanosecond string. */
export function msToUnixNano(ms: number): string {
  // Avoid float precision loss for large values: do the *1e6 in integer space.
  return `${Math.trunc(ms)}000000`;
}

/**
 * Emit a single GenAI span, best-effort. NO-OP (returns immediately, builds
 * nothing) when telemetry is unconfigured — this is the hot path guard.
 * Any error from building or transport is swallowed: a run must never fail
 * because of telemetry.
 *
 * Fire-and-forget: returns a resolved promise once the POST is dispatched (the
 * caller does not await delivery), and the promise NEVER rejects.
 */
export async function emitSpan(input: GenAiSpanInput): Promise<void> {
  try {
    const endpoint = otelEndpoint();
    if (endpoint === null) return; // OFF — zero work, zero deps loaded.
    const span = buildGenAiSpan(input);
    const payload = buildOtlpPayload([span]);
    const body = JSON.stringify(payload);
    const url = tracesUrl(endpoint);
    await transport(url, body, otelHeaders());
  } catch {
    // Swallow — telemetry is best-effort and must not throw into the run.
  }
}

/**
 * Convenience emit for a GenAI event using millisecond timings and a Stoa
 * provider id. Resolves system + span ids for the caller and forwards to
 * `emitSpan` (still a no-op when unconfigured). Never throws.
 */
export async function emitGenAiEvent(event: {
  operation: GenAiOperation;
  provider: string;
  model?: string | null;
  startMs: number;
  endMs: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolName?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  statusCode?: 0 | 1 | 2;
  statusMessage?: string;
  extra?: Record<string, string | number | boolean | null | undefined>;
}): Promise<void> {
  // Guard BEFORE minting ids / computing anything — keep the OFF path free.
  if (!otelEnabled()) return;
  await emitSpan({
    operation: event.operation,
    system: genAiSystemForProvider(event.provider),
    model: event.model,
    traceId: event.traceId ?? newTraceId(),
    spanId: event.spanId ?? newSpanId(),
    parentSpanId: event.parentSpanId,
    startTimeUnixNano: msToUnixNano(event.startMs),
    endTimeUnixNano: msToUnixNano(event.endMs),
    toolName: event.toolName,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    statusCode: event.statusCode,
    statusMessage: event.statusMessage,
    extra: event.extra,
  });
}
