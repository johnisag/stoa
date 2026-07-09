export const FLEET_RUN_JSON_BODY_MAX = 16 * 1024;
export const FLEET_APPROVAL_JSON_BODY_MAX = 2 * 1024;
export const FLEET_PLAN_JSON_BODY_MAX = 32 * 1024;
export const FLEET_ARTIFACT_JSON_BODY_MAX = 12 * 1024;

export async function readCappedJsonBody(
  request: Request,
  maxBytes: number
): Promise<{ body: unknown } | { error: string; status: number }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > maxBytes) {
      return { error: "Request body too large", status: 413 };
    }
  }

  if (!request.body) {
    return { error: "Invalid JSON body", status: 400 };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { error: "Request body too large", status: 413 };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { error: "Invalid JSON body", status: 400 };
  }
}
