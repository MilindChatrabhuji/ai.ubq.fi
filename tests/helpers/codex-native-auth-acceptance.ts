import { lstat, mkdir, readFile, readdir, readlink, rm, realpath, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { openKv, type Kv } from "#kv";
// Manual, hermetic acceptance: real codex-cli 0.160.0, synthetic auth, loopback only.
// This standalone capture requires the authorized native subprocess profile.
import assert from "node:assert/strict";
import type WebSocket from "ws";
import type { CodexAuthPoolState, CodexAuthState } from "../../src/types.ts";

const NATIVE_CODEX = "/Users/nv/.codex/bin/codex";
const EMAIL = "native-fixture@example.invalid";
const ACCOUNT = "uos-native-fixture-account";
const MODEL = "gpt-6.1-sol";
const PROOF_ROOT = `${process.cwd()}/.data/native-auth-acceptance/${crypto.randomUUID()}`;
const TLS_DIRECTORY = `${process.cwd()}/.data/native-auth-acceptance/tls-v6`;
const TLS_CA_PATH = `${TLS_DIRECTORY}/ca.pem`;
const TLS_CA_SHA256 = "ede418068bd26e8c4eba427f88ed0b353ba630c997af43f9abf1ebe354d5dadf";
let fixtureCaHash = "";
const RPC_TIMEOUT_MS = 8_000;
const decoder = new TextDecoder();
const isMissingPath = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const pollUntil = async (predicate: () => Promise<boolean>, label: string, signal?: AbortSignal): Promise<void> => {
  const deadline = performance.now() + RPC_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (signal?.aborted) throw new Error(`${label} cancelled`);
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`${label} timed out`);
};
const bounded = async <T>(work: Promise<T>, label: string, milliseconds = RPC_TIMEOUT_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out`));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const jwt = (generation: number, expired = false): string => {
  const exp = Math.floor(Date.now() / 1000) + (expired ? -60 : 3600);
  const claims = {
    exp,
    email: EMAIL,
    generation,
    "https://api.openai.com/profile": { email: EMAIL },
    "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: "pro", chatgpt_user_id: "uos-fixture-user" },
  };
  const encode = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.fixture`;
};

type FakeAuth = {
  auth_mode: string;
  OPENAI_API_KEY: null;
  tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string };
  last_refresh: string;
};
const fakeAuth = (generation: number, expired = false): FakeAuth => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: jwt(generation), access_token: jwt(generation, expired), refresh_token: `uos-fixture-refresh-${generation}`, account_id: ACCOUNT },
  last_refresh: new Date().toISOString(),
});
const readAuth = async (home: string): Promise<FakeAuth> => {
  const value: unknown = JSON.parse(await readFile(`${home}/auth.json`, "utf8"));
  assert(isRecord(value) && isRecord(value.tokens));
  assert.equal(value.tokens.account_id, ACCOUNT);
  assert.equal(typeof value.tokens.access_token, "string");
  assert.equal(typeof value.tokens.refresh_token, "string");
  return value as FakeAuth;
};
const authState = (auth: FakeAuth): CodexAuthState => ({
  access_token: auth.tokens.access_token,
  refresh_token: auth.tokens.refresh_token,
  account_id: auth.tokens.account_id,
  updated_at_ms: Date.now(),
});

type RpcMessage = Record<string, unknown>;
type Rpc = { call: (method: string, params?: Record<string, unknown>) => Promise<unknown>; events: RpcMessage[]; close: () => void };
const verifyNativeAccount = (account: unknown): void => {
  assert(isRecord(account) && isRecord(account.account));
  assert.equal(account.account.type, "chatgpt");
  assert.equal(account.account.email, EMAIL);
  assert(isRecord(account.workspaceRouting), "native routing identity must be present");
  assert.equal(account.workspaceRouting.chatgptAccountId, ACCOUNT);
};
const openRpc = async (socketPath: string, home: string, verifyIdentity = true): Promise<Rpc> => {
  const { default: SOCKET_CONSTRUCTOR } = await import("ws");
  const socket: WebSocket = new SOCKET_CONSTRUCTOR(`ws+unix://${socketPath}:/`, {
    headers: { Host: "localhost" },
    perMessageDeflate: false,
    handshakeTimeout: 2_000,
  });
  const pending = new Map<number, PromiseWithResolvers<unknown>>();
  const events: RpcMessage[] = [];
  let serial = 0;
  socket.on("message", (bytes: unknown) => {
    if (!(bytes instanceof Uint8Array)) return;
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!isRecord(value)) return;
    events.push(value);
    if (typeof value.id !== "number") return;
    const call = pending.get(value.id);
    if (!call) return;
    pending.delete(value.id);
    if (value.error) call.reject(new Error(JSON.stringify(value.error)));
    else call.resolve(value.result);
  });
  socket.on("error", () => {
    for (const call of pending.values()) call.reject(new Error("native socket error"));
  });
  socket.on("close", () => {
    for (const call of pending.values()) call.reject(new Error("native socket closed"));
  });
  await bounded(
    new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    "native socket open"
  );
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const id = ++serial;
    const deferred = Promise.withResolvers<unknown>();
    pending.set(id, deferred);
    socket.send(JSON.stringify({ id, method, params }));
    try {
      return await bounded(deferred.promise, method);
    } finally {
      pending.delete(id);
    }
  };
  try {
    const initialized = await call("initialize", { clientInfo: { name: "uos_native_auth_fixture", version: "1" }, capabilities: { experimentalApi: true } });
    assert(isRecord(initialized));
    assert.equal(await realpath(String(initialized.codexHome)), await realpath(home), "initialize must identify the isolated home");
    socket.send(JSON.stringify({ method: "initialized" }));
    if (verifyIdentity) verifyNativeAccount(await call("account/read", { refreshToken: false }));
    return {
      call,
      events,
      close: () => {
        socket.terminate();
      },
    };
  } catch (error) {
    socket.terminate();
    throw error;
  }
};

const failureDetails = (value: unknown): Record<string, unknown> => {
  if (!(value instanceof Error)) return { message: String(value) };
  const details: Record<string, unknown> = { name: value.name, message: value.message, stack: value.stack };
  if (value instanceof AggregateError) details.errors = (value.errors as unknown[]).map(failureDetails);
  if (value.cause !== undefined) details.cause = failureDetails(value.cause);
  return details;
};
const writeDiagnostic = async (filename: string, value: unknown): Promise<unknown[]> => {
  try {
    await writeFile(`${PROOF_ROOT}/${filename}`, `${JSON.stringify(value, null, 2)}\n`);
    return [];
  } catch (error) {
    return [error];
  }
};
type NativeProcess = {
  pid: number;
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output: Promise<{ code: number; signal: Bun.Subprocess["signalCode"]; stdout: string; stderr: string }>;
};
const activeProcesses = new Set<NativeProcess>();
const launch = (home: string, endpoint: string, args: string[]): NativeProcess => {
  const child = Bun.spawn([NATIVE_CODEX, ...args], {
    cwd: PROOF_ROOT,
    env: {
      HOME: home,
      CODEX_HOME: home,
      PATH: "/usr/bin:/bin",
      TMPDIR: home,
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${endpoint}/oauth/token`,
      CODEX_CA_CERTIFICATE: TLS_CA_PATH,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const metadata = {
    pid: child.pid,
    argv: [NATIVE_CODEX, ...args],
    home,
    startedAt: new Date().toISOString(),
    clearEnv: true,
    stdin: "null",
    trustedCa: { path: TLS_CA_PATH, sha256: fixtureCaHash },
  };
  const process: NativeProcess = {
    pid: child.pid,
    child,
    output: Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(async ([code, stdout, stderr]) => {
      activeProcesses.delete(process);
      const result = { code, signal: child.signalCode, stdout, stderr };
      const failures = await writeDiagnostic(`native-process-${child.pid}.json`, {
        ...metadata,
        state: "exited",
        exitedAt: new Date().toISOString(),
        ...result,
      });
      if (failures.length) throw new AggregateError(failures, "Native process exited but its diagnostic could not be retained");
      return result;
    }),
  };
  activeProcesses.add(process);
  void process.output.catch(() => {});
  writeFileSync(`${PROOF_ROOT}/native-process-${child.pid}.json`, `${JSON.stringify({ ...metadata, state: "spawned" }, null, 2)}\n`);
  return process;
};
const settleProcess = async (process: NativeProcess): Promise<Awaited<NativeProcess["output"]>> => {
  try {
    process.child.kill("SIGTERM");
  } catch {
    /* already exited */
  }
  try {
    return await bounded(process.output, "native process settlement", 3_000);
  } catch {
    try {
      process.child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    return await bounded(process.output, "native SIGKILL settlement", 3_000);
  }
};
const nativeConfig = (endpoint: string): string[] => [
  "-c",
  "analytics.enabled=false",
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  `chatgpt_base_url="${endpoint}/backend-api"`,
  "-c",
  'model_provider="fixture"',
  "-c",
  'model_providers.fixture.name="Hermetic fixture"',
  "-c",
  `model_providers.fixture.base_url="${endpoint}/codex"`,
  "-c",
  'model_providers.fixture.wire_api="responses"',
  "-c",
  "model_providers.fixture.requires_openai_auth=true",
  "-c",
  "model_providers.fixture.supports_websockets=false",
  "-c",
  'model_reasoning_effort="none"',
];
const recordSocketEvidence = async (pid: number, rendezvous: string): Promise<unknown[]> => {
  let evidence: Record<string, unknown> = { pid, rendezvous, observedAt: new Date().toISOString() };
  let present = false;
  try {
    const info = await lstat(rendezvous);
    present = true;
    evidence = {
      ...evidence,
      present: true,
      isSymlink: info.isSymbolicLink(),
      linkTarget: info.isSymbolicLink() ? await readlink(rendezvous) : null,
    };
    evidence.physicalTarget = await realpath(rendezvous);
  } catch (error) {
    evidence = { ...evidence, present, inspectionFailure: failureDetails(error) };
  }
  return await writeDiagnostic(`native-socket-${pid}.json`, evidence);
};
const startManager = async (home: string, socket: string, endpoint: string, verifyIdentity = true): Promise<{ process: NativeProcess; rpc: Rpc }> => {
  assert(new TextEncoder().encode(socket).length < 104, "Unix socket exceeds macOS SUN_LEN");
  const process = launch(home, endpoint, [...nativeConfig(endpoint), "app-server", "--listen", `unix://${socket}`]);
  const readiness = new AbortController();
  try {
    await Promise.race([
      pollUntil(
        async () => {
          try {
            await stat(socket);
            return true;
          } catch (error) {
            if (!isMissingPath(error)) throw error;
            return false;
          }
        },
        "app-server socket readiness",
        readiness.signal
      ),
      process.output.then((output) => {
        throw new Error(`Native app-server exited ${output.code} before socket readiness`);
      }),
    ]);
    const evidenceFailures = await recordSocketEvidence(process.pid, socket);
    if (evidenceFailures.length) throw new AggregateError(evidenceFailures, "Native rendezvous evidence could not be retained");
    return { process, rpc: await openRpc(socket, home, verifyIdentity) };
  } catch (error) {
    const evidenceFailures = await recordSocketEvidence(process.pid, socket);
    const output = await settleProcess(process);
    throw new AggregateError(
      [error, ...evidenceFailures],
      `${error instanceof Error ? error.message : String(error)}; native PID ${process.pid} exited ${output.code}; diagnostic ${PROOF_ROOT}/native-process-${process.pid}.json; native stderr: ${output.stderr}`,
      { cause: error }
    );
  } finally {
    readiness.abort();
  }
};
const stopManager = async (manager: { process: NativeProcess; rpc: Rpc }): Promise<void> => {
  manager.rpc.close();
  const output = await settleProcess(manager.process);
  await writeFile(`${PROOF_ROOT}/manager-${manager.process.pid}.json`, JSON.stringify({ pid: manager.process.pid, ...output }));
};

type RefreshAttempt = { tokenGeneration: number; arrivedAt: number; repliedAt: number | null; outcome: "waiting" | "rotated" | "reused" };
type Inference = { generation: number; accountMatches: boolean; status: number; path: string };
type VoidDeferred = PromiseWithResolvers<void>;
class MockAuthority {
  generation = 0;
  readonly attempts: RefreshAttempt[] = [];
  readonly inference: Inference[] = [];
  readonly requests: { method: string; path: string }[] = [];
  readonly arrivals: VoidDeferred = Promise.withResolvers();
  readonly release: VoidDeferred = Promise.withResolvers();
  barrierCount = 1;
  routingIdentityAvailable = true;
  home = "";
  winner: FakeAuth | null = null;

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    this.requests.push({ method: request.method, path });
    if (path === "/oauth/token") return await this.refresh(request);
    if (path.endsWith("/responses")) return await this.respond(request);
    if (path.endsWith("/models")) return Response.json({ models: [] });
    if (path.endsWith("/accounts/check"))
      return Response.json({
        accounts: this.routingIdentityAvailable
          ? [{ id: ACCOUNT, plan_type: "pro", structure: "personal", workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" }]
          : [],
        account_ordering: this.routingIdentityAvailable ? [ACCOUNT] : [],
        default_account_id: this.routingIdentityAvailable ? ACCOUNT : null,
      });
    // Every unimplemented route is observable; no proxying or external transport exists.
    return Response.json({ error: { code: "fixture_route_missing", message: path } }, { status: 404 });
  }

  async refresh(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    assert(isRecord(body));
    assert.equal(body.grant_type, "refresh_token");
    const token = body.refresh_token;
    assert.equal(typeof token, "string");
    const generation = Number(String(token).replace("uos-fixture-refresh-", ""));
    const attempt: RefreshAttempt = { tokenGeneration: generation, arrivedAt: performance.now(), repliedAt: null, outcome: "waiting" };
    this.attempts.push(attempt);
    if (this.attempts.length === this.barrierCount) this.arrivals.resolve();
    await bounded(this.release.promise, "OAuth barrier");
    if (generation === this.generation) {
      this.generation += 1;
      this.winner = fakeAuth(this.generation);
      attempt.outcome = "rotated";
      attempt.repliedAt = performance.now();
      return Response.json({ ...this.winner.tokens, expires_in: 3600, token_type: "Bearer" });
    }
    // The losing manager sees reuse only after the winner is on disk, not merely returned by OAuth.
    await pollUntil(async () => {
      try {
        return (await readAuth(this.home)).tokens.refresh_token === this.winner?.tokens.refresh_token;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return false;
      }
    }, "winner persistence before reused response");
    attempt.outcome = "reused";
    attempt.repliedAt = performance.now();
    return Response.json({ error: "refresh_token_reused", error_description: "Synthetic refresh token already used" }, { status: 400 });
  }

  async respond(request: Request): Promise<Response> {
    const bearer = request.headers.get("authorization")?.replace("Bearer ", "");
    const generation = this.winner && bearer === this.winner.tokens.access_token ? this.generation : -1;
    const accountMatches = request.headers.get("chatgpt-account-id") === ACCOUNT;
    const status = generation >= 1 && accountMatches ? 200 : 401;
    this.inference.push({ generation, accountMatches, status, path: new URL(request.url).pathname });
    if (status !== 200) return Response.json({ error: { code: "invalid_token", message: "Fixture requires the persisted winner" } }, { status });
    const text = `native-generation-${generation}`;
    const message = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const response = {
      id: "resp_fixture",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: MODEL,
      status: "completed",
      output: [message],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: message.id, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: message.id, delta: text },
      { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: message.id, text },
      { type: "response.content_part.done", output_index: 0, content_index: 0, item_id: message.id, part: message.content[0] },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response },
    ];
    const bytes = events
      .map((event, sequenceNumber) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequenceNumber })}\n\n`)
      .join("");
    await request.arrayBuffer();
    return new Response(bytes, { headers: { "content-type": "text/event-stream" } });
  }
}

const nativePreflightRefusals = async (home: string, mock: MockAuthority, rpc: Rpc): Promise<Record<string, unknown>> => {
  const { requestNativeCodexRefresh } = await import("../../src/codex/native-auth-transport.ts");
  const initialBytes = await readFile(`${home}/auth.json`, "utf8");
  const refused = async (expectedAccountId: string): Promise<string> => {
    let message: string | null = null;
    try {
      await requestNativeCodexRefresh(home, EMAIL, expectedAccountId);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message, "native refresh must fail closed before OAuth");
    assert.equal(mock.attempts.length, 0, "preflight refusal must send zero OAuth requests");
    assert.equal(await readFile(`${home}/auth.json`, "utf8"), initialBytes, "preflight refusal must preserve credential bytes");
    return message;
  };
  // The manager starts while matching routing is absent, preventing a positive cache from hiding this control.
  assert.equal(mock.routingIdentityAvailable, false);
  const unavailable = await refused(ACCOUNT);
  mock.routingIdentityAvailable = true;
  verifyNativeAccount(await rpc.call("account/read", { refreshToken: false }));
  const foreignAccount = await refused(`${ACCOUNT}-foreign`);
  return {
    routingIdentityUnavailable: { refused: true, message: unavailable },
    foreignAccountId: { refused: true, message: foreignAccount },
    attemptedRefreshes: 0,
    credentialBytesUnchanged: true,
  };
};

type Gateway = {
  seed: (home: string, initial: FakeAuth) => Promise<void>;
  refresh: () => Promise<CodexAuthState>;
  inference: () => Promise<void>;
  pool: () => Promise<CodexAuthPoolState>;
  reset: () => void;
};
const createGateway = async (endpoint: string, kv: Kv): Promise<Gateway> => {
  process.env.CODEX_BASE_URL = `${endpoint}/codex`;
  const auth = await import("../../src/codex/auth.ts");
  const refresh = await import("../../src/codex/auth-refresh.ts");
  const native = await import("../../src/codex/native-auth.ts");
  const { fetchCodexResponses } = await import("../../src/codex/index.ts");
  const { setKvForTest } = await import("../../src/kv.ts");
  setKvForTest(kv);
  const sibling: CodexAuthState = {
    access_token: "uos-sibling-access",
    refresh_token: "uos-sibling-refresh",
    account_id: "uos-sibling-account",
    updated_at_ms: 1,
  };
  return {
    seed: async (home, initial) => {
      auth.resetCodexAuthCacheForTest();
      native.setNativeCodexAuthHooksForTest({ codexHome: home, readAuth: () => readAuth(home) });
      await kv.set(auth.CODEX_AUTH_POOL_KV_KEY, { accounts: [authState(initial), sibling], updated_at_ms: Date.now() });
      const pool = (await auth.getAuthPoolEntry(true)).pool;
      assert.deepEqual(pool.accounts[1], sibling);
      assert.equal(pool.accounts[0].native_owner?.codex_home, home, "real bootstrap must establish native ownership");
    },
    refresh: async () => {
      const entry = await auth.getAuthPoolEntry(true);
      const account = entry.pool.accounts[0];
      return await refresh.refreshAuthCoordinated({ ...entry, auth: account });
    },
    inference: async () => {
      const response = await bounded(fetchCodexResponses({ model: MODEL, input: "Return the synthetic generation", stream: true }), "gateway inference");
      assert.equal(response.status, 200);
      const body = await response.text();
      assert(body.includes("response.completed") && body.includes("native-generation-"));
    },
    pool: async () => {
      const pool = (await auth.getAuthPoolEntry(true)).pool;
      assert.deepEqual(pool.accounts[1], sibling, "sibling credentials must remain byte-equivalent");
      return pool;
    },
    reset: () => {
      native.setNativeCodexAuthHooksForTest(null);
      auth.resetCodexAuthCacheForTest();
      setKvForTest(null);
    },
  };
};

const nativeInference = async (rpc: Rpc): Promise<void> => {
  const result = await rpc.call("thread/start", {
    model: MODEL,
    modelProvider: "fixture",
    cwd: PROOF_ROOT,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
  });
  assert(isRecord(result) && isRecord(result.thread));
  const threadId = result.thread.id;
  assert.equal(typeof threadId, "string");
  const startIndex = rpc.events.length;
  await rpc.call("turn/start", { threadId, input: [{ type: "text", text: "Return the synthetic generation" }] });
  await pollUntil(() => {
    const terminal = rpc.events.slice(startIndex).find((event) => event.method === "turn/completed");
    if (!terminal) return Promise.resolve(false);
    assert(isRecord(terminal.params) && isRecord(terminal.params.turn));
    assert.equal(terminal.params.turn.status, "completed");
    assert(JSON.stringify(rpc.events.slice(startIndex)).includes("native-generation-"));
    return Promise.resolve(true);
  }, "native inference terminal");
};

const cliInference = async (home: string, endpoint: string): Promise<{ pid: number; code: number; completed: boolean }> => {
  const process = launch(home, endpoint, [
    ...nativeConfig(endpoint),
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-m",
    MODEL,
    "Return the synthetic generation",
  ]);
  let output: Awaited<NativeProcess["output"]>;
  try {
    output = await bounded(process.output, "native CLI inference", 15_000);
  } catch (error) {
    try {
      process.child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    await bounded(process.output, "CLI timeout settlement", 3_000);
    throw error;
  }
  await writeFile(`${PROOF_ROOT}/cli-${process.pid}.json`, JSON.stringify({ pid: process.pid, ...output }));
  assert.equal(output.code, 0, output.stderr);
  assert(output.stdout.includes('"type":"turn.completed"'));
  assert(output.stdout.includes("native-generation-"));
  return { pid: process.pid, code: output.code, completed: true };
};

const persistedProof = async (home: string, mock: MockAuthority, gateway: Gateway): Promise<Record<string, unknown>> => {
  const auth = await readAuth(home);
  assert(mock.winner);
  assert.equal(auth.tokens.access_token, mock.winner.tokens.access_token);
  assert.equal(auth.tokens.refresh_token, mock.winner.tokens.refresh_token);
  const mode = (await stat(`${home}/auth.json`)).mode;
  assert.equal(mode & 0o777, 0o600);
  const pool = await gateway.pool();
  assert.equal(pool.accounts[0].access_token, auth.tokens.access_token);
  assert.equal(pool.accounts[0].refresh_token, auth.tokens.refresh_token);
  const bytes = new TextEncoder().encode(JSON.stringify([auth.tokens.account_id, auth.tokens.access_token, auth.tokens.refresh_token]));
  const generationHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(pool.accounts[0].native_owner?.generation_hash, generationHash);
  return { generation: mock.generation, generationHash, mode: "0600", accountPreserved: true, siblingUntouched: true };
};

const runCase = async (
  kind: "one-manager" | "two-managers",
  endpoint: string,
  mock: MockAuthority,
  gateway: Gateway,
  aliasRoot: string
): Promise<Record<string, unknown>> => {
  const directory = `${PROOF_ROOT}/${kind}`;
  const home = `${aliasRoot}/${kind === "one-manager" ? "a" : "b"}`;
  await mkdir(directory, { recursive: true });
  await mkdir(home);
  const initial = fakeAuth(0);
  await writeFile(`${home}/auth.json`, JSON.stringify(initial), { mode: 0o600 });
  mock.home = home;
  mock.barrierCount = kind === "one-manager" ? 1 : 2;
  await gateway.seed(home, initial);
  const managers: { process: NativeProcess; rpc: Rpc }[] = [];
  let preflightRefusals: Record<string, unknown> | null = null;
  let acceptanceFailure: unknown;
  let result: Record<string, unknown> | null = null;
  let cleanupFailures: unknown[];
  const progress = { phase: "manager-start" };
  try {
    await mkdir(`${home}/app-server-control`);
    const needsPreflightControls = kind === "one-manager";
    mock.routingIdentityAvailable = !needsPreflightControls;
    managers.push(await startManager(home, `${home}/app-server-control/app-server-control.sock`, endpoint, !needsPreflightControls));
    progress.phase = "native-preflight-refusals";
    if (needsPreflightControls) preflightRefusals = await nativePreflightRefusals(home, mock, managers[0].rpc);
    progress.phase = "second-manager-start";
    if (kind === "two-managers") managers.push(await startManager(home, `${home}/second.sock`, endpoint));
    const native = managers.at(-1);
    assert(native);
    progress.phase = "overlapping-refresh";
    // A gateway refresh and a native account/read begin before either OAuth reply is released.
    const startedAt = performance.now();
    const outcome = (error: unknown): { status: string; message: string } => ({
      status: "rejected",
      message: error instanceof Error ? error.message : String(error),
    });
    const gatewayRefresh = gateway.refresh().then(() => ({ status: "fulfilled" }), outcome);
    if (kind === "one-manager") await bounded(mock.arrivals.promise, "gateway entered native semaphore");
    const nativeRefresh = native.rpc.call("account/read", { refreshToken: true }).then(() => ({ status: "fulfilled" }), outcome);
    await bounded(mock.arrivals.promise, "all required OAuth arrivals");
    if (kind === "one-manager") await delay(50); // Let the second native request queue while the first authority reply is held.
    assert(mock.attempts.every((attempt) => attempt.repliedAt === null));
    if (kind === "two-managers")
      assert.deepEqual(
        mock.attempts.map((attempt) => attempt.tokenGeneration),
        [0, 0]
      );
    mock.release.resolve();
    const initialConsumerOutcomes = await bounded(Promise.all([gatewayRefresh, nativeRefresh]), "overlapping refresh completion");
    // account/read ignores refresh errors, so neither successful RPC nor a swallowed reuse establishes convergence.
    const successfulRotations = mock.attempts.filter((attempt) => attempt.outcome === "rotated").length;
    if (kind === "one-manager") {
      assert.deepEqual(
        mock.attempts.map((attempt) => attempt.tokenGeneration),
        [0, 1],
        "one semaphore must serialize onto the new generation"
      );
      assert.equal(successfulRotations, 2);
      const first = mock.attempts[0];
      assert(first.repliedAt !== null && mock.attempts[1].arrivedAt >= first.repliedAt);
    }
    if (kind === "two-managers") assert.equal(successfulRotations, 1);
    if (kind === "two-managers") assert.equal(mock.attempts.filter((attempt) => attempt.outcome === "reused").length, 1);
    const attemptsBeforeRecovery = mock.attempts.length;
    // Do not force-refresh the winning manager again: its normal inference already has usable tokens.
    // The losing manager must use native UnauthorizedRecovery's guarded reload if its cache is stale.
    progress.phase = "gateway-inference";
    await gateway.inference();
    progress.phase = "native-manager-inference";
    await Promise.all(managers.map((manager) => nativeInference(manager.rpc)));
    assert.equal(mock.attempts.length, attemptsBeforeRecovery, "guarded reload must recover the winner without another rotation");
    progress.phase = "native-cli-inference";
    const cli = await cliInference(home, endpoint);
    const successfulInference = mock.inference.filter((entry) => entry.status === 200);
    assert(successfulInference.length >= managers.length + 2);
    assert(successfulInference.every((entry) => entry.generation === mock.generation && entry.accountMatches));
    progress.phase = "persisted-generation-proof";
    result = {
      kind,
      isolatedHome: home,
      managerPids: managers.map((manager) => manager.process.pid),
      overlappingConsumers: true,
      elapsedMs: performance.now() - startedAt,
      attemptedRefreshes: mock.attempts.length,
      successfulRotations,
      reusedFailures: mock.attempts.filter((attempt) => attempt.outcome === "reused").length,
      initialConsumerOutcomes,
      preflightRefusals,
      attempts: mock.attempts,
      inference: mock.inference,
      cli,
      persisted: await persistedProof(home, mock, gateway),
    };
  } catch (error) {
    acceptanceFailure = error;
  } finally {
    mock.release.resolve();
    const stopped = await Promise.allSettled(managers.map(stopManager));
    cleanupFailures = stopped.flatMap((stoppedProcess) => (stoppedProcess.status === "rejected" ? [stoppedProcess.reason] : []));
  }
  const failures: unknown[] = [acceptanceFailure, ...cleanupFailures].filter((failure) => failure !== undefined);
  failures.push(
    ...(await writeDiagnostic(`${kind}-diagnostic.json`, {
      phase: progress.phase,
      home,
      managerPids: managers.map((manager) => manager.process.pid),
      attempts: mock.attempts,
      inference: mock.inference,
      requests: mock.requests,
      trustedCa: { path: TLS_CA_PATH, sha256: fixtureCaHash },
      failures: failures.map(failureDetails),
    }))
  );
  if (failures.length) throw new AggregateError(failures, "Native acceptance and process cleanup results");
  return requireAcceptanceResult(result);
};

const requireAcceptanceResult = (result: Record<string, unknown> | null): Record<string, unknown> => {
  if (result === null) throw new Error("Native acceptance completed without a result");
  return result;
};

const requireFixtureBase = async (): Promise<string> => {
  assert.equal(process.argv.slice(2).length, 1, "Provide exactly one preallocated fixture base directory");
  const base = process.argv.slice(2)[0];
  assert.equal(/^\/tmp\/uos268-[a-zA-Z0-9_-]+/u.exec(base)?.[0], base, "Fixture base must be one absolute /tmp/uos268-* directory");
  const info = await lstat(base);
  assert(info.isDirectory() && !info.isSymbolicLink(), "Fixture base must be an existing real directory");
  assert.equal(info.uid, 501, "Fixture base must belong to the authorized Mac fixture owner");
  assert.equal(info.mode & 0o777, 0o700, "Fixture base must have mode 0700");
  for (const entry of await readdir(base, { withFileTypes: true })) throw new Error(`Fixture base is not empty: ${entry.name}`);
  return base;
};

const main = async (): Promise<void> => {
  const aliasRoot = await requireFixtureBase();
  await mkdir(PROOF_ROOT, { recursive: true });
  let kv: Kv | null = null;
  let server: Bun.Server<undefined> | null = null;
  let activeMock = new MockAuthority();
  let gateway: Gateway | null = null;
  let receipt: Record<string, unknown> | null = null;
  let acceptanceFailure: unknown;
  const cleanupFailures: unknown[] = [];
  const progress = { phase: "fixture-setup" };
  try {
    progress.phase = "fixture-tls";
    const ca = await readFile(TLS_CA_PATH);
    fixtureCaHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ca)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    assert.equal(fixtureCaHash, TLS_CA_SHA256, "Task-owned fixture CA must match the verified certificate");
    const [cert, key] = await Promise.all([readFile(`${TLS_DIRECTORY}/server.pem`, "utf8"), readFile(`${TLS_DIRECTORY}/server.key`, "utf8")]);
    kv = await openKv(`${PROOF_ROOT}/fixture.sqlite3`);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert, key }, fetch: (request) => activeMock.handle(request) });
    const endpoint = `https://127.0.0.1:${server.port}`;
    progress.phase = "native-version";
    const versionProcess = launch(aliasRoot, endpoint, ["--version"]);
    const version = await bounded(versionProcess.output, "native version", 3_000);
    assert.equal(version.code, 0);
    assert.equal(version.stdout.trim(), "codex-cli 0.160.0");
    progress.phase = "gateway-bootstrap";
    gateway = await createGateway(endpoint, kv);
    progress.phase = "one-manager-case";
    const oneManager = await runCase("one-manager", endpoint, activeMock, gateway, aliasRoot);
    activeMock = new MockAuthority();
    progress.phase = "two-manager-case";
    const twoManagers = await runCase("two-managers", endpoint, activeMock, gateway, aliasRoot);
    receipt = {
      version: "native-auth-acceptance.v1",
      installedCli: version.stdout.trim(),
      executable: NATIVE_CODEX,
      isolatedHomeAlias: aliasRoot,
      loopbackEndpoint: endpoint,
      trustedCa: { path: TLS_CA_PATH, sha256: fixtureCaHash },
      oneManager,
      twoManagers,
    };
  } catch (error) {
    acceptanceFailure = error;
  } finally {
    try {
      gateway?.reset();
    } catch (error) {
      cleanupFailures.push(error);
    }
    const stopped = await Promise.allSettled(Array.from(activeProcesses, settleProcess));
    for (const result of stopped) if (result.status === "rejected") cleanupFailures.push(result.reason);
    try {
      kv?.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await bounded(server?.stop(true) ?? Promise.resolve(), "mock server shutdown", 3_000);
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (activeProcesses.size === 0) {
      try {
        await rm(aliasRoot, { recursive: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    } else cleanupFailures.push(new Error(`Unsettled fixture native processes; isolated home retained at ${aliasRoot}`));
  }
  const failures: unknown[] = [acceptanceFailure, ...cleanupFailures].filter((failure) => failure !== undefined);
  failures.push(
    ...(await writeDiagnostic("run-diagnostic.json", {
      phase: progress.phase,
      isolatedHome: aliasRoot,
      activeNativePids: Array.from(activeProcesses, (process) => process.pid),
      attempts: activeMock.attempts,
      inference: activeMock.inference,
      requests: activeMock.requests,
      trustedCa: { path: TLS_CA_PATH, sha256: fixtureCaHash },
      failures: failures.map(failureDetails),
    }))
  );
  if (failures.length) throw new AggregateError(failures, "Native authentication acceptance failed");
  assert(receipt);
  try {
    await stat(aliasRoot);
    throw new Error("Isolated fixture home remains after cleanup");
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  receipt.nativeProcessesSettled = true;
  receipt.isolatedHomeRemoved = true;
  receipt.cleanupComplete = true;
  await writeFile(`${PROOF_ROOT}/receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ receiptPath: `${PROOF_ROOT}/receipt.json`, ...receipt }));
};

if (import.meta.main) await main();
