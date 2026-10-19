import assert from "node:assert/strict";

type RecordValue = Record<string, unknown>;
type LiveFixture = {
  url: (path: string) => string;
  read: (key: string) => Promise<RecordValue | null>;
  tuple: (...parts: string[]) => string;
  restart: () => Promise<void>;
  cases: string[];
};

function object(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function liveCases(input: LiveFixture): Promise<void> {
  const { url, read, tuple, restart, cases } = input;
  // Read, but never manufacture, the source installed by the typed Rust fixture.
  const source = await read(tuple("ubq_ai", "codex_auth"));
  assert(source && object(source.value) && Array.isArray(source.value.accounts) && source.value.accounts.length === 2);
  const account = source.value.accounts[0];
  assert(object(account) && typeof account.account_id === "string");
  const send = (form: FormData): Promise<Response> =>
    fetch(url("/v1/live///"), { method: "POST", headers: { authorization: "Bearer fixture-access", "x-session-id": "fixture-live-session" }, body: form });
  const form = new FormData();
  form.append("sdp", new Blob(["fixture SDP offer"], { type: "text/plain" }), "offer.txt");
  form.append("sdp", "ignored second offer");
  form.append("session", JSON.stringify({ model: "gpt-matrix-test", unknown: "\ud800" }));
  form.append("session", "ignored second session");
  const created = await send(form);
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(created.statusText, "Fixture Accepted");
  assert.equal(created.headers.get("location"), "/v1/live/rtc_fixture_live");
  assert.equal(created.headers.get("content-type"), "application/sdp");
  assert.equal(await created.text(), "fixture SDP answer\u0000tail");
  const requestId = created.headers.get("x-uos-request-id");
  assert(requestId);
  assert.equal(await read(tuple("uos_ai", "routing_runtime", "v1", "session", requestId)), null);
  const key = tuple("uos_ai", "codex_live_calls", "v1", "rtc_fixture_live");
  const mapping = await read(key);
  assert(mapping && object(mapping.value));
  assert.equal(mapping.value.account_id, account.account_id);
  assert.equal(mapping.value.principal_id, "auth-method:auth_tokens_allowlist");
  assert(typeof mapping.value.created_at_ms === "number" && typeof mapping.expires_at_ms === "number");
  assert.equal(mapping.expires_at_ms - mapping.value.created_at_ms, 3_600_000);
  cases.push("actual_live_file_first_parts_utf16_raw_answer_status_text_and_no_inference_admission");
  await restart();
  assert.deepEqual(await read(key), mapping);
  const join = await fetch(url("/v1/live/rtc_fixture_live/"), { headers: { authorization: "Bearer fixture-access" } });
  assert.equal(join.status, 426);
  await join.arrayBuffer();
  cases.push("actual_live_mapping_persists_across_workerd_restart_and_same_principal_join");
  const invalidSession = new FormData();
  invalidSession.append("sdp", "offer");
  invalidSession.append("session", "[]");
  const invalid = await send(invalidSession);
  assert.equal(invalid.status, 400);
  await invalid.arrayBuffer();
  const large = new FormData();
  large.append("sdp", "x".repeat(1_048_577));
  large.append("session", "{}");
  const oversized = await send(large);
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
  cases.push("actual_live_multipart_object_and_one_mib_limits");
}
