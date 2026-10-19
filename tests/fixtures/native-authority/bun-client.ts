import {
  NativeAuthorityClient,
  NativePrincipalControlClient,
  parseNativeCommand,
  parseNativeControlCommand,
} from "../../../src/authority/native-authority-rpc.ts";
import { NativeAuthorityError } from "../../../src/authority/native-authority-contracts.ts";
import type { NativeControlRpcResult } from "../../../src/authority/native-authority-rpc.ts";
const task: {
  url: string;
  principal: string;
  epoch: string;
  operations: unknown[];
  surface?: "principal" | "native-bindings";
  raw?: boolean;
} = await Bun.stdin.json();
class FixtureFault extends Error {}
const results: unknown[] = [];
if (task.surface === "native-bindings") {
  const [{ defaultPaidFallbackPolicy }, { LOCAL_DEVELOPMENT_KEY_ID }, { MeteredError }, { getDefaultExpiryMs, DEFAULT_USAGE_LIMIT_REQUESTS }] =
    await Promise.all([
      import("../../../src/paid-fallback/index.ts"),
      import("../../../src/auth/local-development-key.ts"),
      import("../../../src/provider/metered.ts"),
      import("../../../src/api-keys.ts"),
    ]);
  const error = new MeteredError("synthetic native pricing refusal", "metered_pricing_invalid", 503);
  results.push({
    localDevelopmentKeyId: LOCAL_DEVELOPMENT_KEY_ID,
    defaults: { expiryMs: getDefaultExpiryMs(1_800_000_000_000), usageLimitRequests: DEFAULT_USAGE_LIMIT_REQUESTS },
    defaultPaidPolicy: defaultPaidFallbackPolicy(),
    pricingFailure: { kind: "refused", status: error.status, message: error.message, code: error.code },
    unknownPricingFailure: { kind: "refused", status: 502, message: "Failed to initialize Metered paid fallback", code: "metered_pricing_unavailable" },
  });
} else {
  const send = async (command: unknown, surface: string) => {
    const response = await fetch(task.url + surface + task.principal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    if (response.status !== 200) throw new Error(`fixture RPC HTTP ${response.status}`);
    const reply = await response.json();
    if (reply.fixtureFault) throw new FixtureFault(String(reply.fixtureFault.message));
    return reply;
  };
  const client = new NativeAuthorityClient({ execute: (command) => send(command, "/rpc/") }, task.epoch);
  const control = new NativePrincipalControlClient({ control: (command): Promise<NativeControlRpcResult> => send(command, "/control-rpc/") }, task.epoch);
  for (const operation of task.operations) {
    try {
      const input = typeof operation === "object" && operation !== null ? { epoch: task.epoch, operationId: crypto.randomUUID(), ...operation } : operation;
      if (task.surface === "principal") {
        if (task.raw) results.push(await send(input, "/control-rpc/"));
        else {
          const command = parseNativeControlCommand(input);
          results.push(await control.call(command.method, command.args, command.operationId));
        }
      } else {
        const command = parseNativeCommand(input);
        results.push(await client.call(command.method, command.args, command.operationId));
      }
    } catch (error) {
      if (error instanceof FixtureFault) results.push({ fixtureFault: { message: error.message } });
      else if (error instanceof NativeAuthorityError) results.push({ fixtureError: { code: error.code, status: error.status } });
      else throw error;
    }
  }
}
console.log(JSON.stringify({ runtime: Bun.version, results }));
