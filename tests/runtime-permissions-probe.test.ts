import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPermissionsNative } from "../scripts/build-permissions.ts";

const linuxArm64Test = process.platform === "linux" && process.arch === "arm64" ? test : test.skip;

linuxArm64Test("Linux confinement has a real unrestricted Bun baseline and thread-sync support", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "m13-permissions-baseline-"));
  try {
    await mkdir(join(fixture, "home"));
    await mkdir(join(fixture, "tmp"));
    const artifact = await buildPermissionsNative(join(fixture, "native"));
    const module = new URL("../src/runtime/permissions-linux.ts", import.meta.url).href;
    const source = `
      import assert from "node:assert/strict";
      import { readFile, writeFile } from "node:fs/promises";
      import { getLinuxPermissionsSupport } from ${JSON.stringify(module)};
      const root = ${JSON.stringify(fixture)};
      for (const key of ["CEREBRAS_API_KEY", "DEEPSEEK_API_KEY", "LITHOSAI_API_KEY", "SURPLUS_API_KEY", "UOS_AI_TOKEN", "DENO_DEPLOY_TOKEN"])
        assert.equal(process.env[key], undefined);
      await Bun.write(root + "/bun.txt", "bun-baseline");
      assert.equal(await Bun.file(root + "/bun.txt").text(), "bun-baseline");
      await writeFile(root + "/node.txt", "node-baseline");
      assert.equal(await readFile(root + "/node.txt", "utf8"), "node-baseline");
      const child = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "pipe", stderr: "pipe" });
      assert.equal(await child.exited, 0);
      const support = getLinuxPermissionsSupport(${JSON.stringify(artifact)});
      assert(support.landlockThreadSync, "Landlock ABI8 TSYNC is required for already-running Bun threads");
      assert(support.seccomp);
      console.log(JSON.stringify({ support, baseline: "passed", childSettled: true }));
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
      cwd: fixture,
      env: { PATH: "/usr/bin:/bin", HOME: join(fixture, "home"), TMPDIR: join(fixture, "tmp"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const proof = JSON.parse(stdout.trim()) as { baseline: string; childSettled: boolean; support: { landlockAbi: number; seccomp: boolean } };
    expect(proof.baseline).toBe("passed");
    expect(proof.childSettled).toBe(true);
    expect(proof.support.landlockAbi).toBeGreaterThanOrEqual(8);
    console.log(stdout.trim());
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
