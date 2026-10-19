import assert from "node:assert/strict";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function failureCaptureCase(url: (path: string) => string, requestId: string, successfulId: string, cases: string[]): Promise<void> {
  let captured: ObjectValue | undefined;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const response = await fetch(url(`/admin/sentinel/replay-captures?request_id=${encodeURIComponent(requestId)}`), {
      headers: { authorization: "Bearer fixture-admin", connection: "close" },
    });
    assert.equal(response.status, 200);
    const page: unknown = await response.json();
    assert(object(page) && Array.isArray(page.data));
    if (page.data.length > 0) {
      captured = page;
      break;
    }
    await Bun.sleep(25);
  }
  assert(captured && Array.isArray(captured.data) && captured.data.length === 1, "The real terminal owner must persist encrypted capture rows.");
  const capture: unknown = captured.data[0];
  assert(object(capture) && object(capture.manifest) && Array.isArray(capture.chunks));
  assert(!("request_id" in capture.manifest) && !("stored_bytes" in capture.manifest), "Private capture fields must not enter the frozen public manifest.");
  assert(object(captured.capture_status));
  assert.equal(captured.capture_status.request_id, requestId);
  assert.equal(captured.capture_status.fingerprint, capture.manifest.fingerprint);
  assert.deepEqual(captured.capture_status.manifest_key, [
    "uos_ai",
    "sentinel_replay",
    "v1",
    "manifest",
    capture.manifest.captured_at_ms,
    capture.manifest.fingerprint,
    capture.manifest.capture_id,
  ]);
  assert.equal(capture.manifest.chunk_count, capture.chunks.length);
  assert(typeof capture.manifest.ciphertext_bytes === "number" && capture.manifest.ciphertext_bytes > 0);
  assert(capture.chunks.length > 0 && capture.chunks.every((chunk: unknown) => typeof chunk === "string" && chunk.length > 0));
  assert(object(captured.capture_status) && ["ready", "incomplete"].includes(String(captured.capture_status.status)));
  cases.push("actual_encrypted_failure_capture_persisted_and_authenticated_exported_without_artifact_claim");
  await captureSuppressionCase(url, successfulId, cases);
}

export async function captureSuppressionCase(url: (path: string) => string, requestId: string, cases: string[]): Promise<void> {
  const response = await fetch(url(`/admin/sentinel/replay-captures?request_id=${encodeURIComponent(requestId)}`), {
    headers: { authorization: "Bearer fixture-admin", connection: "close" },
  });
  assert.equal(response.status, 200);
  const page: unknown = await response.json();
  assert(
    object(page) && Array.isArray(page.data) && page.data.length === 0,
    "Successful or cancelled source requests must not create encrypted failure captures."
  );
  cases.push("actual_success_or_cancellation_suppresses_failure_capture");
}
