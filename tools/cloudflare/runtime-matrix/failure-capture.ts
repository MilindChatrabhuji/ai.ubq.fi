// Controlled synthetic matrix traffic only; never register live requests or credential documents.
const cases = new WeakMap<Response, string>();
const MAX_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 2000;
const fixtureMarker = (value: unknown): value is string => typeof value === "string" && /^fixture:[\w:.-]{1,150}$/.test(value);

function fixtureCase(value: unknown, depth = 0): string | undefined {
  if (fixtureMarker(value)) return value;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 32)) {
      const found = fixtureCase(item, depth + 1);
      if (found) return found;
    }
  } else if (value !== null && typeof value === "object") {
    if ("text" in value) return fixtureCase(value.text, depth + 1);
    if ("content" in value) return fixtureCase(value.content, depth + 1);
  }
  return undefined;
}

export function registerFixtureResponse(response: Response, body: unknown): Response {
  if (body === null || typeof body !== "object") return response;
  let caseId: string | undefined;
  if ("input" in body) caseId = fixtureCase(body.input);
  else if ("messages" in body) caseId = fixtureCase(body.messages);
  if (caseId) cases.set(response, caseId);
  return response;
}

/** Preserve the caller's original assertion; diagnostic failures must never replace it. */
export async function captureUnexpectedStatus(response: Response, expected: number): Promise<void> {
  const caseId = cases.get(response);
  if (response.status === expected || !caseId) return;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  let readError: string | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.clone().body?.getReader();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, READ_TIMEOUT_MS);
    });
    while (reader) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part === null) {
        timedOut = true;
        break;
      }
      if (part.done) break;
      const keep = part.value.subarray(0, MAX_BYTES - bytes);
      chunks.push(keep);
      bytes += keep.byteLength;
      if (bytes === MAX_BYTES) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    readError = error instanceof Error ? error.name : "UnknownError";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (reader) {
      // A clone's tee cancellation may await the untouched original branch: never await it.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  try {
    console.error(
      "RUNTIME_MATRIX_HTTP_FAILURE=" +
        JSON.stringify({
          case: caseId,
          expected_status: expected,
          actual_status: response.status,
          content_type: response.headers.get("content-type"),
          body_bytes: bytes,
          truncated,
          timed_out: timedOut,
          read_error: readError,
          body: Buffer.concat(chunks, bytes).toString("utf8"),
        })
    );
  } catch {
    // Logging is best effort; the unchanged expected-status assertion remains authoritative.
  }
}
