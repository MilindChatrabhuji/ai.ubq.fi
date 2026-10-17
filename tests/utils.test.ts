import { test } from "bun:test";
import assert from "node:assert/strict";

import { base64UrlDecode, decodeBase64ToString } from "../src/utils.ts";

test("base64 helpers tolerate whitespace", () => {
  assert.equal(decodeBase64ToString(" aG\nk= "), "hi");
  assert.equal(new TextDecoder().decode(base64UrlDecode(" aG\nk ")), "hi");
});
