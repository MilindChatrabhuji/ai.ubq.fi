import { readFile } from "node:fs/promises";
import type { UbqAiAdminContext, UbqAiCommandContext, UbqAiRuntime } from "./ubq-ai-core.ts";
import {
  classifyToken,
  describeSecret,
  describeTokenSource,
  doFetch,
  getFlagString,
  normalizeBaseUrl,
  parseArgs,
  readStdin,
  resolveAdminToken,
  resolveClientToken,
  usageText,
  writeErrText,
  writeOutText,
  writeUsageError,
} from "./ubq-ai-core.ts";
import { runChatCommand, runHealthCommand, runInfoCommand, runModelsCommand, runResponsesCommand, runWhoamiCommand } from "./ubq-ai-chat.ts";
import { runAdminKeysCommand, runAdminKernelPubkeysCommand, runAdminKernelUsageCommand, runAdminUploadAuthCommand } from "./ubq-ai-admin.ts";

const runAdminCommand = async (ctx: UbqAiCommandContext): Promise<number> => {
  const { runtime, flags } = ctx;
  const adminToken = resolveAdminToken(flags, runtime);
  if (!adminToken) {
    await writeErrText(runtime, "Missing admin token. Set DENO_DEPLOY_TOKEN or pass --admin-token.\n");
    return 2;
  }

  const sub = ctx.args[0] ?? "";
  const adminContext: UbqAiAdminContext = { ...ctx, adminToken, subArgs: ctx.args.slice(1) };

  if (sub === "upload-auth") return await runAdminUploadAuthCommand(adminContext);
  if (sub === "keys") return await runAdminKeysCommand(adminContext);
  if (sub === "kernel-pubkeys") return await runAdminKernelPubkeysCommand(adminContext);
  if (sub === "kernel-usage") return await runAdminKernelUsageCommand(adminContext);

  return await writeUsageError(runtime, `Unknown admin command: ${sub || "(missing)"}\n`);
};

export const runUbqAi = async (argv: string[], runtime: UbqAiRuntime): Promise<number> => {
  const parsed = parseArgs(argv);
  const flags = parsed.flags;

  if (flags.help === true || flags.h === true || parsed._.length === 0) {
    await writeOutText(runtime, await usageText(runtime));
    return parsed._.length === 0 ? 2 : 0;
  }

  const baseUrl = normalizeBaseUrl(getFlagString(flags, "url") ?? "https://ai.ubq.fi");
  const homeDir = runtime.envGet("HOME");
  const wantsJson = flags.json === true;
  const wantsStream = flags.stream === true;
  const wantsRaw = flags.raw === true;
  const wantsVerbose = flags.verbose === true;

  const debug = async (line: string): Promise<void> => {
    if (!wantsVerbose) return;
    await writeErrText(runtime, line);
  };

  await debug(`[ubq-ai] url=${baseUrl}\n`);
  await debug(`[ubq-ai] env UOS_AI_TOKEN=${await describeSecret(runtime.envGet("UOS_AI_TOKEN"))}\n`);
  // The DENO_DEPLOY_TOKEN line is emitted twice by the original CLI; kept verbatim so `-v` output stays byte-identical.
  await debug(`[ubq-ai] env DENO_DEPLOY_TOKEN=${await describeSecret(runtime.envGet("DENO_DEPLOY_TOKEN"))}\n`);
  await debug(`[ubq-ai] env DENO_DEPLOY_TOKEN=${await describeSecret(runtime.envGet("DENO_DEPLOY_TOKEN"))}\n`);
  const clientSource = describeTokenSource(runtime, flags, { flag: "token", env: "UOS_AI_TOKEN", fallback: () => resolveAdminToken(flags, runtime) });
  const adminSource = describeTokenSource(runtime, flags, { flag: "admin-token", env: "DENO_DEPLOY_TOKEN" });
  await debug(`[ubq-ai] token_sources client=${clientSource} admin=${adminSource}\n`);
  const resolvedClientToken = resolveClientToken(flags, runtime) ?? undefined;
  const resolvedAdminToken = resolveAdminToken(flags, runtime) ?? undefined;
  await debug(`[ubq-ai] resolved client_token=${await describeSecret(resolvedClientToken)}\n`);
  await debug(`[ubq-ai] resolved admin_token=${await describeSecret(resolvedAdminToken)}\n`);
  await debug(`[ubq-ai] client_token_shape=${resolvedClientToken ? classifyToken(resolvedClientToken) : "unset"}\n`);
  await debug(`[ubq-ai] admin_token_shape=${resolvedAdminToken ? classifyToken(resolvedAdminToken) : "unset"}\n`);
  await debug(`[ubq-ai] flags json=${wantsJson} stream=${wantsStream} raw=${wantsRaw}\n`);

  const cmd = parsed._[0] ?? "";
  const rest = parsed._.slice(1);

  const endpoint = (path: string): URL => new URL(path, baseUrl);

  const doFetchWithDebug = async (req: Request): Promise<Awaited<ReturnType<typeof doFetch>>> => {
    await debug(`[ubq-ai] -> ${req.method} ${req.url}\n`);
    const result = await doFetch(runtime, req);
    await debug(`[ubq-ai] <- ${result.status}\n`);
    return result;
  };

  const context: UbqAiCommandContext = {
    runtime,
    flags,
    args: rest,
    baseUrl,
    homeDir,
    endpoint,
    wantsJson,
    wantsStream,
    wantsRaw,
    debug,
    doFetchWithDebug,
  };

  if (cmd === "health") return await runHealthCommand(context);
  if (cmd === "info") return await runInfoCommand(context);
  if (cmd === "whoami") return await runWhoamiCommand(context);
  if (cmd === "models") return await runModelsCommand(context);
  if (cmd === "chat") return await runChatCommand(context);
  if (cmd === "responses") return await runResponsesCommand(context);
  if (cmd === "admin") return await runAdminCommand(context);

  return await writeUsageError(runtime, `Unknown command: ${cmd}\n`);
};

const getDefaultRuntime = (): UbqAiRuntime => ({
  fetch,
  envGet: (key: string) => process.env[key],
  readTextFile: (path: string) => readFile(path, "utf8"),
  stdinIsTerminal: process.stdin.isTTY,
  readStdin,
  out: async (chunk: Uint8Array) => {
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(chunk, (error) => {
        if (error) reject(error);
        else resolve();
      })
    );
  },
  err: async (chunk: Uint8Array) => {
    await new Promise<void>((resolve, reject) =>
      process.stderr.write(chunk, (error) => {
        if (error) reject(error);
        else resolve();
      })
    );
  },
});

if (import.meta.main) {
  const code = await runUbqAi(process.argv.slice(2), getDefaultRuntime());
  process.exitCode = code;
}
export type { UbqAiRuntime };
