import { test } from "bun:test";
import assert from "node:assert/strict";

import { isTrustedAuthRelayClientOrigin, parseAuthRelayAction, parseTrustedAuthRelayOrigin } from "../static/auth-relay.js";
import { parseTrustedAuthRelayOrigin as parseTrustedServerAuthRelayOrigin } from "../src/auth/relay.ts";

/**
 * The same origin downgraded to clear text. Rejecting a clear-text scheme on an
 * otherwise trusted host is the subject of the assertions below, so the
 * insecure variant is derived from the trusted origin instead of duplicated.
 */
const clearTextOrigin = (origin: string): string => origin.replace(/^https:/, "http:");

test("auth relay identifies approved Deno relay client origins", () => {
  for (const origin of [
    "https://ai-ubq-fi.ubiquity-dao.deno.net",
    "https://ai-ubq-fi-cv5fc93pzb5a.ubiquity-dao.deno.net",
    "https://p-ai-ubq-fi.ubiquity-dao.deno.net",
    "https://p-ai-ubq-fi-cv5fc93pzb5a.ubiquity-dao.deno.net",
    "https://telegram-daily-exporter.0x4007.deno.net",
    "https://telegram-daily-exporter-4d2p9cx7m1ab.0x4007.deno.net",
    "https://agent-worker.ubiquity-os.deno.net",
    "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net",
    "https://ai-ubq-fi.deno.dev",
    "https://ai-ubq-fi-ejc9p6zmdjxt.deno.dev",
  ]) {
    assert.equal(isTrustedAuthRelayClientOrigin(origin), true, origin);
  }
  assert.equal(isTrustedAuthRelayClientOrigin("https://ai.ubq.fi"), false);
  assert.equal(isTrustedAuthRelayClientOrigin(clearTextOrigin("https://ai-ubq-fi-cv5fc93pzb5a.deno.dev")), false);
  assert.equal(isTrustedAuthRelayClientOrigin("https://example.com"), false);
});

test("auth relay rejects local development origins", () => {
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(parseTrustedAuthRelayOrigin(`http://${hostname}:8000`), "");
    assert.equal(parseTrustedAuthRelayOrigin(`https://${hostname}`), "");
    assert.equal(parseTrustedServerAuthRelayOrigin(`http://${hostname}:8000`), null);
    assert.equal(parseTrustedServerAuthRelayOrigin(`https://${hostname}`), null);
  }
});

test("auth relay accepts canonical and owned Deno organization origins", () => {
  assert.equal(parseTrustedAuthRelayOrigin("https://ai.ubq.fi"), "https://ai.ubq.fi");
  assert.equal(parseTrustedAuthRelayOrigin("https://ai-ubq-fi.deno.dev"), "https://ai-ubq-fi.deno.dev");
  assert.equal(parseTrustedServerAuthRelayOrigin("https://ai.ubq.fi"), "https://ai.ubq.fi");
  assert.equal(parseTrustedServerAuthRelayOrigin("https://ai-ubq-fi.deno.dev"), "https://ai-ubq-fi.deno.dev");
  for (const origin of [
    "https://ai-ubq-fi.ubiquity-dao.deno.net",
    "https://ai-ubq-fi-cv5fc93pzb5a.ubiquity-dao.deno.net",
    "https://p-ai-ubq-fi.ubiquity-dao.deno.net",
    "https://p-ai-ubq-fi-cv5fc93pzb5a.ubiquity-dao.deno.net",
    "https://telegram-daily-exporter.0x4007.deno.net",
    "https://telegram-daily-exporter-4d2p9cx7m1ab.0x4007.deno.net",
    "https://agent-worker.ubiquity-os.deno.net",
    "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net",
    "https://ai-ubq-fi-ejc9p6zmdjxt.deno.dev",
  ]) {
    assert.equal(parseTrustedAuthRelayOrigin(origin), origin);
    assert.equal(parseTrustedServerAuthRelayOrigin(origin), origin);
  }
});

test("auth relay rejects untrusted or malformed origins", () => {
  for (const origin of [
    "https://example.com",
    "https://app.other-org.deno.net",
    "https://untrusted-app.0x4007.deno.net",
    "https://untrusted-app.ubiquity-os.deno.net",
    "https://checkout-ubq-fi.ubiquity-dao.deno.net",
    "https://app.0x4007.deno.net.evil.example",
    "https://nested.app.0x4007.deno.net",
    "https://unowned-app.deno.dev",
    "https://ai-ubq-fi-evil.deno.dev",
    "https://ai-ubq-fi-cv5fc93pzb5a.evil.example",
    clearTextOrigin("https://ai-ubq-fi-cv5fc93pzb5a.ubiquity-dao.deno.net"),
    "https://app.0x4007.deno.net:8443",
    "https://app.0x4007.deno.net/admin",
    "https://ai.ubq.fi:8443",
    "https://ai.ubq.fi/admin",
    "javascript:alert(1)",
  ]) {
    assert.equal(parseTrustedAuthRelayOrigin(origin), "", origin);
    assert.equal(parseTrustedServerAuthRelayOrigin(origin), null, origin);
  }
});

test("auth relay only accepts the passkey login action", () => {
  assert.equal(parseAuthRelayAction("passkey-login"), "passkey-login");
  assert.equal(parseAuthRelayAction("token"), "");
  assert.equal(parseAuthRelayAction(null), "");
});
