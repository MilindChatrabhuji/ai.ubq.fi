import assert from "node:assert/strict";
import { object, responseObject, stringKey, type MatrixContext } from "./contracts.ts";

/** This negative case needs no native capability; complete cycles require the real registered-owner fixture. */
export async function cacheBodyRejection(context: MatrixContext): Promise<void> {
  const keys = [stringKey("uos_ai", "runtime_config", "v2"), stringKey("uos_ai", "codex_active_account", "v1")];
  const before = await Promise.all(keys.map((key) => context.read(key)));
  const events = await context.events();
  for (const body of [{}, null, { model: "gpt-matrix-test" }, { cycle: 1, refresh: true }]) {
    const response = await context.post("/admin/providers/codex/cache-scope-experiment", body, context.adminToken ?? "fixture-admin");
    const refused = await responseObject(response, 400);
    assert.equal(object(refused.error).message, "Prompt-cache scope experiment does not accept request fields");
  }
  assert.deepEqual(await context.events(), events, "Rejected raw bodies cannot call provider or native bindings");
  assert.deepEqual(await Promise.all(keys.map((key) => context.read(key))), before, "Body rejection cannot change runtime defaults or global active account");
  context.cases.push("matrix_cache_experiment_nonempty_raw_body_rejected_before_dispatch_preserves_defaults_and_active");
}
