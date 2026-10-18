import { test } from "bun:test";
import assert from "node:assert/strict";

import { redactSupervisorSecretParts, redactSupervisorSecrets } from "../src/codex/supervisor-secret.ts";

test("backtick quoting adds a reading without narrowing the original bracket scan", () => {
  for (const [prefix, expected] of [
    ["tokens: [", "[redacted]"],
    ['{"api_keys": [', '{"[redacted]'],
    ["api_key: {a: ", "[redacted]"],
  ]) {
    assert.equal(redactSupervisorSecrets(`${prefix}\`A 'B \\'C \`D ]E `).text, expected, prefix);
  }
  assert.equal(redactSupervisorSecrets('tokens = [`a]`, "zqalpha"] done').text, "[redacted] done");
});

test("credential-named arrow parameters do not redact their callbacks", () => {
  const callbacks = [
    "const lengths = tokens.map(token => token.trim().length);",
    "apiKeys.forEach(key => {\n  const label = describe(key);\n  console.log(label);\n});\nnext();",
    "tokens.map(token=>token.trim().length);",
    "visit(items, secret=>{ describe(secret); });",
    'visit("(", token=>token.trim());',
  ];
  for (const text of callbacks) assert.deepEqual(redactSupervisorSecrets(text), { text, redactions: 0 });
  for (const text of [
    "'password' => 'zqsecretvalue'",
    ":api_key => 'zqsecretvalue'",
    "client_secret => zqsecretvalue",
    'items,api_key=>"zqsecretvalue"',
    "log('('), api_key=>zqsecretvalue",
  ]) {
    assert.equal(redactSupervisorSecrets(text).text.includes("zqsecretvalue"), false, text);
  }
});

test("Perl, Ruby and Elixir string prefixes keep bracket characters inside their credential strings", () => {
  for (const prefix of ["q", "qq", "%q", "%Q", "~s", "~S"]) {
    const text = `api_keys: [${prefix}'zq]alpha', 'zqbravo'] done`;
    assert.equal(redactSupervisorSecrets(text).text, "[redacted] done", prefix);
    const parts = [`api_keys: [${prefix}'zq]alpha',`, " 'zqbravo'] done"];
    assert.equal(
      redactSupervisorSecretParts(parts).some((part) => part.text.includes("zq")),
      false,
      prefix
    );
  }
  assert.equal(redactSupervisorSecrets("api_keys: [it's, 'zqsecretvalue'] done").text, "[redacted] done");
});

test("quoted credential keys redact bare values without consuming adjacent fields", () => {
  const cases = [
    ['"password": hunter2hunter2', '"[redacted]'],
    ['{"password": 12345678, "model": "m"}', '{"[redacted], "model": "m"}'],
    ["'password' => SECRETCONSTANT1", "'[redacted]"],
    ["'password'=>SECRETCONSTANT1;next();", "'[redacted];next();"],
    ['{"password":12345678,"model":"m"}', '{"[redacted],"model":"m"}'],
    ['{"password":"zqsecretvalue","model":"m"}', '{"[redacted],"model":"m"}'],
    ['{"password":["zqsecretvalue"],"model":"m"}', '{"[redacted],"model":"m"}'],
    ['["password":12345678] done', '["[redacted]] done'],
  ];
  for (const [text, expected] of cases) assert.equal(redactSupervisorSecrets(text).text, expected, text);
  assert.equal(redactSupervisorSecrets("token=Bearer abcdefghijklmnop").redactions, 2);
});

test("closed credential values are redacted across records before their keys are lost", () => {
  const cases = [
    ["tool output: -----BEGIN OPENSSH PRIVATE KEY-----\nzqfirstsecretvalue", "tool output: zqsecondsecretvalue\n-----END OPENSSH PRIVATE KEY----- done"],
    ['{"api_keys": ["zqfirstsecretvalue", ', '"zqsecondsecretvalue"]} done'],
    ['password: "zqfirstsecretvalue', 'zqsecondsecretvalue" done'],
    ["password: 'zqfirstsecretvalue", "zqsecondsecretvalue' done"],
    ["password: `zqfirstsecretvalue", "zqsecondsecretvalue` done"],
    ['api_key: {a: "zqfirstsecretvalue",', 'b: "zqsecondsecretvalue"} done'],
    ['{"api_keys": [', '"zqfirstsecretvalue", ', '"zqsecondsecretvalue"]} done'],
    // The closed inner credential must not disappear into an unclosed outer scan.
    ['tokens: [ api_keys: ["zqfirstsecretvalue",', '"zqsecondsecretvalue"] done'],
  ];
  for (const parts of cases) {
    const redacted = redactSupervisorSecretParts(parts);
    assert.equal(redacted.length, parts.length);
    assert.equal(
      redacted.some((part) => part.text.includes("zq")),
      false,
      JSON.stringify(parts)
    );
    assert.ok(redacted.at(-1)?.text.endsWith(" done"), JSON.stringify(redacted));
  }
});

test("unclosed cross-record readings cannot consume later records", () => {
  for (const text of ['api_keys: ["zqsecretvalue', 'password: "zqsecretvalue', "password: 'zqsecretvalue", "password: `zqsecretvalue"]) {
    const parts = [text, "Working on the refresh loop"];
    assert.deepEqual(redactSupervisorSecretParts(parts), parts.map(redactSupervisorSecrets));
  }
  // Projected closed spans cannot suppress a broader per-record fallback.
  const parts = ['password: "zqsecretvalue"zqtailrun', "Working on the refresh loop"];
  assert.deepEqual(redactSupervisorSecretParts(parts), parts.map(redactSupervisorSecrets));
  assert.equal(redactSupervisorSecretParts(["token=Bearer abcdefghijklmnop", "done"])[0].redactions, 2);
});

test("cross-record bracket readings stay linear with many unclosed outer credentials", () => {
  const started = performance.now();
  const redacted = redactSupervisorSecretParts(["tokens: [".repeat(25_000) + "zqsecretvalue", "] done"]);
  assert.equal(
    redacted.some((part) => part.text.includes("zq")),
    false
  );
  assert.ok(redacted[1].text.endsWith(" done"));
  assert.ok(performance.now() - started < 2_000);
});
