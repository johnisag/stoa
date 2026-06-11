/**
 * Upload a file to temporary storage and return its path.
 * Converts the file to base64 and POSTs to /api/files/upload-temp.
 *
 * @param file - The file to upload
 * @returns The path to the uploaded file, or null if upload failed
 */
export async function uploadFileToTemp(file: File): Promise<string | null> {
  const buffer = await file.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(buffer).reduce(
      (data, byte) => data + String.fromCharCode(byte),
      ""
    )
  );

  const res = await fetch("/api/files/upload-temp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name || `file-${Date.now()}`,
      base64,
      mimeType: file.type || "application/octet-stream",
    }),
  });

  const data = await res.json();
  if (data.path) {
    return data.path;
  }

  console.error("Upload failed:", data.error);
  return null;
}

/**
 * Fetch a web page as context: POST the URL to /api/web-fetch, which reduces the
 * page to readable text, strips control chars, writes it to a temp file, and
 * returns the path. The FilePicker injects that path like an uploaded file.
 *
 * @param url - The http(s) URL to fetch
 * @returns The path to the temp file. THROWS with the route's specific message
 *   (timeout / blocked host / 404 / no readable text) so the caller can toast it.
 */
export async function fetchUrlToTemp(url: string): Promise<string> {
  const res = await fetch("/api/web-fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  const data = await res.json().catch(() => ({}));
  if (res.ok && data.path) return data.path;
  throw new Error(data.error || "Couldn't fetch that URL");
}

/**
 * Partition the settled results of a batch of `uploadFileToTemp` calls into the
 * successfully uploaded paths and a count of failures, so a bulk attach can
 * survive a partial failure: inject every path that landed and still report how
 * many didn't. A failure is a rejected upload OR one that resolved to `null`
 * (the server returned no path). Pure — order is preserved.
 */
export function partitionUploads(
  results: PromiseSettledResult<string | null>[]
): { paths: string[]; failures: number } {
  const paths: string[] = [];
  let failures = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      paths.push(r.value);
    } else {
      failures++;
    }
  }
  return { paths, failures };
}
