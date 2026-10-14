import { readLocalPool, repairExternalNativePool, resolveFlags } from "./codex-auth-repair.ts";

type ExternalOnlyHooks = {
  readPool?: typeof readLocalPool;
  external?: NonNullable<Parameters<typeof repairExternalNativePool>[2]>;
  output?: (message: string) => void;
};

/** Fixed watchdog entrypoint: there is no managed repair or peer collection dispatch. */
export const runExternalNativeRepair = async (args: readonly string[], hooks: ExternalOnlyHooks = {}): Promise<number> => {
  const output =
    hooks.output ??
    ((message: string) => {
      console.log(message);
    });
  if (args.includes("--help") || args.includes("-h")) {
    output("codex-external-auth-repair.ts [--apply] [--json] [--auth-json <fixed-native-leaf>] [--kv <local-kv>]");
    return 0;
  }
  const flags = resolveFlags(args);
  const local = await (hooks.readPool ?? readLocalPool)(flags.kv);
  if ("error" in local) throw new Error(local.error);
  const result = await repairExternalNativePool(flags, local, hooks.external);
  if (!result) throw new Error("A current official external native leaf is required; managed repair and peer collection are forbidden");
  if (flags.json) output(JSON.stringify({ ...result, accounts: [], candidates: [], notes: ["Only the current external native leaf was considered"] }));
  else output(`codex-external-auth-repair: external native consumer ${result.status}`);
  return result.status === "repair_available" ? 1 : 0;
};

if (import.meta.main) {
  try {
    process.exit(await runExternalNativeRepair(process.argv.slice(2)));
  } catch (error) {
    console.error(`codex-external-auth-repair: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
