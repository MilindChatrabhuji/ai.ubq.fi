import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import {
  executeProbe,
  captureCommand,
  CommandFailure,
  loadInputs,
  parseArtifact,
  probeRequest,
  qemuArgv,
  overlayResizeArgv,
  ROOT_GROWTH_CONFIG,
  validateReceipt,
  verifyBytes,
  verifyChecksum,
  type Expected,
  type Runner,
} from "./rust-linux-guest.ts";

import { tmpdir } from "node:os";
import { join } from "node:path";

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
  assert.deepEqual(argv.slice(argv.indexOf("-cpu"), argv.indexOf("-cpu") + 2), ["-cpu", "cortex-a57"]);
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
  await assert.rejects(
    executeProbe(["/usr/bin/qemu-system-aarch64"], expected, taskDirectory, () => Promise.resolve({ code: 1, stdout: good, stderr: "failed" }))
  );
  assert.equal(
    (await executeProbe(["/usr/bin/qemu-system-aarch64"], expected, taskDirectory, () => Promise.resolve({ code: 0, stdout: good, stderr: "" }))).phase,
    "post-kernel-reboot"
  );
});
test("the retired guest interface cannot replace required Mac-native and WASM validation", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deno-deploy.yml", import.meta.url), "utf8");
  assert(!workflow.includes("linux_capability_probe") && !workflow.includes("linux-capability-probe:") && !workflow.includes("probe-only /"));
  const native = workflow.slice(workflow.indexOf("  rust-native:"), workflow.indexOf("  rust-wasm:"));
  assert(native.includes("runs-on: macos-26") && native.includes("--prepare-ci native") && native.includes("--stage native"));
  assert(!native.includes("apt-get") && native.includes('test "$(uname -m)" = arm64'));
  assert(workflow.includes('if [ "$RUST_NATIVE_REQUIRED" = true ]; then test "$RUST_NATIVE_RESULT" = success; fi'));
  assert(workflow.includes('if [ "$RUST_WASM_REQUIRED" = true ]; then test "$RUST_WASM_RESULT" = success; fi'));
  assert(workflow.includes("needs.scope.result == 'success' && needs.scope.outputs.needs_validate == 'true'"));
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

// Real portable child fixtures exercise the same capture/settlement path, not QEMU or Linux syscalls.
async function fixture(code: string, timeout: number, observe?: Parameters<typeof captureCommand>[3]) {
  const work = mkdtempSync(join(tmpdir(), "uos-probe-diagnostics-"));
  try {
    return await captureCommand([process.execPath, "--no-env-file", "--no-install", "-e", code], work, timeout, observe);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
function absent(pid: number | undefined) {
  assert(pid !== undefined);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}
test("timeout preserves public serial/stderr, original cause and exact signal after actual child settlement", async () => {
  const events: string[] = [];
  const run: Runner = (_argv, _cwd, _timeout, observe) =>
    fixture('console.log("partial-boot"); console.error("fixture-stderr"); setInterval(() => {}, 1000)', 150, observe);
  await assert.rejects(
    executeProbe(["/usr/bin/qemu-system-aarch64"], expected, taskDirectory, run, (line) => {
      events.push(line);
    }),
    (error: unknown) => {
      assert(error instanceof CommandFailure);
      assert(!Object.keys(error).includes("result"), "Generic errors must not publish captured command output");
      assert(error.cause instanceof Error && error.cause.message === "Command deadline exceeded");
      assert.equal(error.result.timedOut, true);
      assert.equal(error.result.signal, "SIGKILL");
      assert(error.result.code !== 0 && error.result.stdout.includes("partial-boot") && error.result.stderr.includes("fixture-stderr"));
      absent(error.result.pid);
      assert.deepEqual(error.result.cleanup, { childExited: true, streamsSettled: true, groupAbsent: true });
      return true;
    }
  );
  assert(events.some((event) => event.startsWith("UOS_LINUX_GUEST_QEMU_SERIAL ") && event.includes("partial-boot")));
  assert(events.some((event) => event.startsWith("UOS_LINUX_GUEST_QEMU_STDERR ") && event.includes("fixture-stderr")));
  assert(events.at(-1)?.includes('"timedOut":true'));
});
test("actual nonzero child and partial receipt retain diagnostics and cannot count as success", async () => {
  const events: string[] = [];
  let captured: Awaited<ReturnType<typeof captureCommand>> | undefined;
  const run: Runner = async (_argv, _cwd, _timeout, observe) => {
    captured = await fixture('console.log("UOS_LINUX_GUEST_RECEIPT partial"); console.error("boot-failed"); process.exit(7)', 2000, observe);
    return captured;
  };
  await assert.rejects(
    executeProbe(["/usr/bin/qemu-system-aarch64"], expected, taskDirectory, run, (line) => {
      events.push(line);
    })
  );
  assert(captured);
  assert.equal(captured.code, 7);
  assert.equal(captured.signal, null);
  absent(captured.pid);
  assert(events.at(-1)?.includes('"exit":7') && events.at(-1)?.includes("boot-failed"));
  await assert.rejects(
    executeProbe(["arbitrary-private-command"], expected, taskDirectory, run, (line) => {
      events.push(line);
    }),
    /fixed QEMU/
  );
});
test("oversize actual child output is capped, original log-limit error survives settlement", async () => {
  let bytes = 0,
    terminal = "";
  const run: Runner = (_argv, _cwd, _timeout, observe) =>
    fixture('console.error("before-limit"); process.stdout.write("x".repeat(8*1024*1024+65536)); setInterval(() => {}, 1000)', 2000, (stream, chunk) => {
      bytes += chunk.length;
      observe?.(stream, chunk);
    });
  await assert.rejects(
    executeProbe(["/usr/bin/qemu-system-aarch64"], expected, taskDirectory, run, (line) => {
      if (line.startsWith("UOS_LINUX_GUEST_QEMU_FAILURE ")) terminal = line;
    }),
    (error: unknown) => {
      assert(error instanceof CommandFailure, String(error) + terminal);
      assert(error.cause instanceof Error && error.cause.message === "Command log limit exceeded");
      assert.equal(Buffer.byteLength(error.result.stdout), 8 * 1024 * 1024);
      assert(error.result.stderr.includes("before-limit"));
      assert.equal(error.result.timedOut, false);
      absent(error.result.pid);
      assert.deepEqual(error.result.cleanup, { childExited: true, streamsSettled: true, groupAbsent: true });
      return true;
    }
  );
  assert(bytes <= 2 * 8 * 1024 * 1024);
  assert(terminal.includes('"serialBytes":8388608') && terminal.includes('"groupAbsent":true') && terminal.includes("Command log limit exceeded"));
});

test("disk growth is fixed at eight GiB and can resize only the private overlay with sufficient remaining headroom", () => {
  const work = "/nonexistent/uos-linux-guest-owned",
    target = join(work, "overlay.qcow2"),
    base = join(work, "disk.img"),
    capacity = 8 * 1024 ** 3;
  assert.deepEqual(overlayResizeArgv(work, target, base, capacity / 2, capacity), ["/usr/bin/qemu-img", "resize", "-f", "qcow2", target, "8589934592"]);
  assert.throws(() => overlayResizeArgv(work, base, base, capacity / 2, capacity));
  assert.throws(() => overlayResizeArgv(work, "/unowned/overlay.qcow2", base, capacity / 2, capacity));
  assert.throws(() => overlayResizeArgv("/unowned", "/unowned/overlay.qcow2", base, capacity / 2, capacity));
  assert.throws(() => overlayResizeArgv(work, target, base, capacity + 1, capacity));
  assert.throws(() => overlayResizeArgv(work, target, base, capacity / 2, capacity - 1));
  assert.equal(ROOT_GROWTH_CONFIG, "growpart:\n  mode: auto\n  devices: [/]\n  ignore_growroot_disabled: false\nresize_rootfs: true\n");
  const controller = readFileSync(new URL("./rust-linux-guest.ts", import.meta.url), "utf8");
  const resize = controller.indexOf("await checked(overlayResizeArgv("),
    boot = controller.indexOf('console.log("UOS_LINUX_GUEST_STAGE qemu:start")');
  assert(resize >= 0 && boot > resize);
  assert(
    controller.includes("metadata.isFile()") && controller.includes("metadata.nlink === 1") && controller.includes("metadata.uid === process.geteuid?.()")
  );
  const provision = readFileSync(new URL("./rust-linux-guest/provision.sh", import.meta.url), "utf8");
  const install = provision.indexOf('dpkg -i "$seed/modules.deb"');
  for (const marker of ["findmnt -n -o SOURCE,FSTYPE /", "df -k /"]) {
    const diagnostic = provision.indexOf(marker);
    assert(diagnostic >= 0 && install > diagnostic);
  }
});
