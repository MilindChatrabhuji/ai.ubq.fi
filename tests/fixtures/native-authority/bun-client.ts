import { NativeAuthorityClient } from "../../../src/authority/native-authority-rpc.ts";
import { NativeAuthorityError, type NativeCommand } from "../../../src/authority/native-authority-contracts.ts";
const task: {
  url: string;
  principal: string;
  epoch: string;
  operations: (Pick<NativeCommand, "method" | "args"> & Partial<Pick<NativeCommand, "operationId">>)[];
} = await Bun.stdin.json();
const client = new NativeAuthorityClient(
  {
    async execute(command) {
      const response = await fetch(task.url + "/rpc/" + task.principal, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (response.status !== 200) throw new Error(`fixture RPC HTTP ${response.status}`);
      return await response.json();
    },
  },
  task.epoch
);
const results: unknown[] = [];
for (const operation of task.operations) {
  try {
    results.push(await client.call(operation.method, operation.args, operation.operationId));
  } catch (error) {
    if (!(error instanceof NativeAuthorityError)) throw error;
    results.push({ fixtureError: { code: error.code } });
  }
}
console.log(JSON.stringify({ runtime: Bun.version, results }));
