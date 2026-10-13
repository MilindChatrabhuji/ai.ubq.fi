import { createVpsDeploymentDriver, type VpsDeploymentDriver } from "../vps-release-driver.ts";
import { ImmutableVpsReleaseStore, vpsBytesDigest } from "../vps-release-store.ts";
import { vpsDigest, type VpsBinding, type VpsMutation, type VpsPrepare, type VpsReceipt, type VpsSelector } from "../vps-release-contract.ts";

export type VpsDriverFixture = {
  root: string;
  priorSha: string;
  candidateSha: string;
  driver: VpsDeploymentDriver;
  driverDigest: string;
  prior: VpsSelector;
  system: FakeVpsSystem;
  now: number;
  prepare(binding?: VpsBinding): Promise<VpsReceipt>;
  cleanup(): Promise<void>;
};
export async function fixtureCommand(program: string, args: string[], cwd: string): Promise<string> {
  const result = await new Deno.Command(program, {
    args,
    cwd,
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(`Fixture ${program} failed`);
  return new TextDecoder().decode(result.stdout).trim();
}
export class FakeVpsSystem {
  serviceSha = "";
  failDaemonReload = false;
  failPublic = false;
  publicFailureRevision: string | null = null;
  calls: string[] = [];
  settlementAllowed = true;
  settlementProof: ((receipt: VpsReceipt, input: import("../vps-release-contract.ts").VpsSettlement) => Promise<boolean>) | null = null;
  constructor(private readonly _root: string) {}
  run = async (program: string, args: string[], cwd: string): Promise<string> => {
    if (program !== "sudo") return fixtureCommand(program, args, cwd);
    this.calls.push(args.join(" "));
    if (args.includes("show")) return "42";
    if (args.includes("daemon-reload") && this.failDaemonReload) throw new Error("fake daemon reload refusal");
    if (args.includes("restart")) this.serviceSha = (await Deno.readLink(`${this._root}/.data/current`)).split("/").at(-1) ?? "";
    return "";
  };
  fetch: typeof fetch = (input) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    const revision =
      url.startsWith("https:") && this.failPublic && (this.publicFailureRevision === null || this.publicFailureRevision === this.serviceSha)
        ? "f".repeat(40)
        : this.serviceSha;
    return Promise.resolve(
      new Response(JSON.stringify({ status: "available", release: { git_sha: revision, deployment_id: `vps-${revision}` } }), {
        status: 200,
        headers: { "x-uos-git-sha": revision, "x-uos-deployment-id": `vps-${revision}`, "x-uos-router-origin": "vps" },
      })
    );
  };
}
export async function mutation(receipt: VpsReceipt): Promise<VpsMutation> {
  return {
    operationId: receipt.operationId,
    requestDigest: receipt.binding.requestDigest,
    expectedSequence: receipt.sequence,
    expectedDigest: await vpsDigest(receipt),
  };
}
export async function makeVpsDriverFixture(): Promise<VpsDriverFixture> {
  const parent = new URL("../../.cleanup-evidence/vps-driver-fixtures/", import.meta.url).pathname;
  await Deno.mkdir(parent, { recursive: true });
  const root = await Deno.makeTempDir({ dir: parent, prefix: "operation-" });
  try {
    await Deno.mkdir(`${root}/src`);
    await Deno.mkdir(`${root}/ops`);
    await Deno.mkdir(`${root}/scripts`);
    await Deno.writeTextFile(`${root}/.gitignore`, ".data/\n");
    await Deno.copyFile(new URL("../ai-ubq-fi.service", import.meta.url), `${root}/ops/ai-ubq-fi.service`);
    await Deno.copyFile(new URL("../../scripts/serve-vps.ts", import.meta.url), `${root}/scripts/serve-vps.ts`);
    await Deno.copyFile(new URL("../Caddyfile", import.meta.url), `${root}/ops/Caddyfile`);
    await Deno.writeTextFile(`${root}/src/app.ts`, "export const release = 1;\n");
    const git = (...args: string[]) => fixtureCommand("git", args, root);
    await git("init", "--initial-branch=development");
    await git("config", "user.name", "Sentinel VPS fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await git("add", ".");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "prior");
    const priorSha = await git("rev-parse", "HEAD");
    await Deno.writeTextFile(`${root}/src/app.ts`, "export const release = 2;\n");
    await git("add", ".");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "candidate");
    const candidateSha = await git("rev-parse", "HEAD");
    await git("update-ref", "refs/remotes/origin/development", candidateSha);
    await Deno.mkdir(`${root}/.data/releases`, { recursive: true, mode: 0o700 });
    const store = new ImmutableVpsReleaseStore(root, fixtureCommand);
    await store.checkedRelease(priorSha, true);
    await store.selectRelease(`releases/${priorSha}`);
    const system = new FakeVpsSystem(root);
    system.serviceSha = priorSha;
    const driverDigest = await vpsBytesDigest(await Deno.readFile(new URL("../vps-release-driver.ts", import.meta.url)));
    const fixture = { root, priorSha, candidateSha, driverDigest, system, now: 1_800_000_000_000 } as VpsDriverFixture;
    fixture.driver = createVpsDeploymentDriver({
      root,
      installationId: 1,
      environment: "isolated",
      driverSha256: driverDigest,
      run: system.run,
      fetch: system.fetch,
      now: () => fixture.now,
      verifySource: (binding) => Promise.resolve(binding.revision === candidateSha),
      verifySettlement: (receipt, input) => (system.settlementProof ? system.settlementProof(receipt, input) : Promise.resolve(system.settlementAllowed)),
    });
    fixture.prior = await fixture.driver.inspectPrior();
    fixture.prepare = async (
      binding = {
        requestId: "release-fixture",
        requestDigest: "b".repeat(64),
        repository: "ubiquity/ai.ubq.fi",
        installationId: 1,
        environment: "isolated",
        revision: candidateSha,
        source: { pullRequest: 7, head: candidateSha, base: priorSha, reviewRequestId: "review-fixture", reviewReceiptId: "review-receipt-fixture" },
      }
    ): Promise<VpsReceipt> => {
      const input: VpsPrepare = {
        binding,
        controllerSha: "c".repeat(40),
        expectedDriverSha256: driverDigest,
        expectedPrior: fixture.prior,
        priorHealth: {
          loopback: await fixture.driver.sampleHealth(fixture.prior.identity, "loopback"),
          public: await fixture.driver.sampleHealth(fixture.prior.identity, "public"),
        },
      };
      return fixture.driver.prepare(input);
    };
    fixture.cleanup = () => Deno.remove(root, { recursive: true });
    return fixture;
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}
