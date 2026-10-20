import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  executeProbe,
  loadInputs,
  parseArtifact,
  probeRequest,
  qemuArgv,
  validateReceipt,
  verifyBytes,
  verifyChecksum,
  type Expected,
} from "./rust-linux-guest.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const taskDirectory = "/nonexistent/unit-probe";
const expected: Expected = {
  nonce: "a".repeat(32),
  sourceSha: "b".repeat(40),
  kernelRelease: "7.2.6-070206-generic",
  configSha256: "c".repeat(64),
  hashes: { kernel: "d".repeat(64), modules: "e".repeat(64), probe: "f".repeat(64) },
};
function body() {
  return {
    v: 1,
    nonce: expected.nonce,
    sourceSha: expected.sourceSha,
    phase: "post-kernel-reboot",
    initialBootId: "11111111-1111-1111-1111-111111111111",
    bootId: "22222222-2222-2222-2222-222222222222",
    kernelRelease: expected.kernelRelease,
    arch: "aarch64",
    configSha256: expected.configSha256,
    lsm: "landlock,lockdown,yama,integrity,apparmor",
    hashes: expected.hashes,
    probeExit: 0,
    syscalls: {
      abi: 9,
      abiErrno: 0,
      createResult: 3,
      createErrno: 0,
      closeResult: 0,
      closeErrno: 0,
      attrBytes: 24,
      fsMask: 0x1ffff,
      netMask: 3,
      scopedMask: 3,
    },
  };
}
const frame = (value: unknown) => {
  const raw = JSON.stringify(value);
  return `boot logs\nUOS_LINUX_GUEST_RECEIPT ${raw}\nUOS_LINUX_GUEST_DONE ${expected.nonce} ${sha(raw)}\npoweroff\n`;
};
test("only explicit manual capability requests can select the isolated job", () => {
  for (const event of ["push", "pull_request", "merge_group", undefined]) assert.equal(probeRequest(event, true), false);
  assert.equal(probeRequest("workflow_dispatch", false), false);
  assert.equal(probeRequest("workflow_dispatch", "false"), false);
  assert.equal(probeRequest("workflow_dispatch", true), true);
  assert.equal(probeRequest("workflow_dispatch", "true"), true);
});
test("QEMU command uses real ARM64 TCG, selected UEFI and no NIC or directory exports", () => {
  const argv = qemuArgv(taskDirectory, "/usr/share/AAVMF/AAVMF_CODE.fd");
  assert.equal(argv[0], "/usr/bin/qemu-system-aarch64");
  assert(argv.includes("tcg,thread=multi"));
  assert(argv.includes("none"));
  assert.deepEqual(argv.slice(argv.indexOf("-nic"), argv.indexOf("-nic") + 2), ["-nic", "none"]);
  assert(!argv.some((item) => /virtfs|fsdev|netdev|kernel=|\.env|\.codex/.test(item)));
  assert.throws(() => qemuArgv(taskDirectory + ",file=host", "/usr/share/AAVMF/AAVMF_CODE.fd"));
});
test("pinned metadata rejects arbitrary hosts, paths, digest mismatch and unsigned membership", () => {
  const artifact = { name: "input.txt", url: "https://kernel.ubuntu.com/pinned/input.txt", sha256: sha("public"), maxBytes: 10 };
  verifyBytes(Buffer.from("public"), artifact);
  assert.throws(() => {
    verifyBytes(Buffer.from("changed"), artifact);
  });
  assert.throws(() => parseArtifact({ ...artifact, url: "https://untrusted.invalid/image" }));
  assert.throws(() => parseArtifact({ ...artifact, name: "../private" }));
  verifyChecksum(`${artifact.sha256}  input.txt\n`, artifact);
  assert.throws(() => {
    verifyChecksum(`${sha("wrong")}  input.txt\n`, artifact);
  });
  const inputs: unknown = JSON.parse(readFileSync(new URL("./rust-linux-guest/inputs.json", import.meta.url), "utf8"));
  assert.equal(loadInputs(inputs).kernelRelease, expected.kernelRelease);
});
test("a complete nonce/source/hash-bound post-reboot receipt requires exact syscall results", () => {
  assert.equal(validateReceipt(frame(body()), expected, 0).kernelRelease, expected.kernelRelease);
  for (const changed of [
    { ...body(), kernelRelease: "7.0.0-stock" },
    { ...body(), initialBootId: body().bootId },
    { ...body(), nonce: "foreign" },
    { ...body(), arch: "x86_64" },
    { ...body(), probeExit: 1 },
    { ...body(), extra: true },
  ])
    assert.throws(() => validateReceipt(frame(changed), expected, 0));
  for (const changed of [{ abi: 8 }, { createResult: -1 }, { closeResult: -1 }, { fsMask: 0xffff }, { attrBytes: 16 }, { scopedMask: 0 }])
    assert.throws(() => validateReceipt(frame({ ...body(), syscalls: { ...body().syscalls, ...changed } }), expected, 0));
});
test("partial, duplicate, corrupted, provisioning-error and failed-QEMU results never pass", async () => {
  const good = frame(body());
  for (const serial of [
    good + good,
    good.replace("UOS_LINUX_GUEST_DONE", "truncated"),
    good.replace(sha(JSON.stringify(body())), "0".repeat(64)),
    good + "UOS_LINUX_GUEST_ERROR failure\n",
  ])
    assert.throws(() => validateReceipt(serial, expected, 0));
  await assert.rejects(executeProbe(["mock-qemu"], expected, taskDirectory, () => Promise.resolve({ code: 1, stdout: good, stderr: "failed" })));
  assert.equal(
    (await executeProbe(["mock-qemu"], expected, taskDirectory, () => Promise.resolve({ code: 0, stdout: good, stderr: "" }))).phase,
    "post-kernel-reboot"
  );
});
test("normal CI keeps its required criteria and probe cannot cancel or impersonate it", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deno-deploy.yml", import.meta.url), "utf8");
  assert(workflow.includes("default: false"));
  assert(workflow.includes("format('probe-{0}', github.run_id)"));
  assert(workflow.includes("if: ${{ !(github.event_name == 'workflow_dispatch' && inputs.linux_capability_probe == true) }}"));
  for (const job of ["scope", "docs", "rust-native", "rust-wasm", "validate", "native", "mac-containment", "darwin-native", "verify-artifact"])
    assert(workflow.includes(`'probe-only / ${job} (not required CI)' || '${job}'`));
  assert(workflow.includes('if [ "$RUST_NATIVE_REQUIRED" = true ]; then test "$RUST_NATIVE_RESULT" = success; fi'));
  assert(workflow.includes("needs.scope.result == 'success' && needs.scope.outputs.needs_validate == 'true'"));
  assert(workflow.includes("persist-credentials: false"));
  assert(!workflow.includes("upload-artifact@", workflow.indexOf("  linux-capability-probe:")));
});
test("guest provisioning is offline and arms a separate reboot service without a guest compiler", () => {
  const provision = readFileSync(new URL("./rust-linux-guest/provision.sh", import.meta.url), "utf8");
  const receipt = readFileSync(new URL("./rust-linux-guest/receipt.py", import.meta.url), "utf8");
  const probe = readFileSync(new URL("./rust-linux-guest/probe.c", import.meta.url), "utf8");
  assert(provision.includes('dpkg -i "$seed/modules.deb" "$seed/kernel.deb"'));
  assert(provision.includes("systemctl enable uos-guest-probe.service"));
  assert(provision.includes("systemctl reboot --no-block"));
  assert(receipt.includes("boot == initial"));
  assert(receipt.includes("release != expected['kernelRelease']"));
  assert(!/apt-get|curl|wget|gcc/.test(provision));
  assert(!/restrict_self|prctl/.test(probe));
});

test("retained authenticated checksum documents bind each exact download before boot", () => {
  const inputs = loadInputs(JSON.parse(readFileSync(new URL("./rust-linux-guest/inputs.json", import.meta.url), "utf8")) as unknown);
  for (const group of inputs.signatures) {
    const sums = readFileSync(new URL("./rust-linux-guest/" + group.checksums.name, import.meta.url));
    verifyBytes(sums, group.checksums);
    verifyBytes(readFileSync(new URL("./rust-linux-guest/" + group.signature.name, import.meta.url)), group.signature);
    for (const [name, item] of [
      ["kernel", inputs.kernel],
      ["modules", inputs.modules],
      ["disk", inputs.disk],
    ] as const)
      if (group.members.includes(name)) verifyChecksum(sums.toString("utf8"), item);
  }
});
