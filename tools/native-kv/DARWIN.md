# Darwin ARM64 native KV

This separate producer preserves the existing Linux input manifest, native source, patches, lock, and artifacts.

It uses Rust/Cargo 1.98.1 and the same pinned `@deno/kv@0.14.0` source, with target `aarch64-apple-darwin` and N-API 4.

Official component archives were verified and inspected on Linux; no Darwin binary was executed there.

The archive and compiler-byte pins are frozen in `inputs-darwin-arm64.json`.

Each component tree is SHA-256 of JSON entries `{path,sha256}`, sorted by path, without a trailing newline.

The compiler entry points are ARM64 Mach-O files. Matching these bytes does not prove Mac execution or acceptance.

Run explicit preparation on an actual Darwin ARM64 host with pinned Bun 1.4.0:

```sh
bun --no-env-file --no-install scripts/build-native-kv-darwin.ts
```

The CLI writes `.tmp/native-kv-darwin/native-kv.node` and its provenance; it accepts no product arguments.

Packaging calls `buildNativeKvDarwin(outputDirectory)` with the fresh release's `.native/kv` directory.

The receipt uses the same `NativeKvArtifact` fields as the Linux producer, including independent provenance SHA-256.

The builder verifies and extracts official Rust components into a fresh `RUNNER_TEMP` child directory.

Outside CI it uses the host temporary directory. Source, Cargo caches, targets, toolchain, and logs remain task-local.

It invokes the verified compiler binaries directly and installs no global or home toolchain, profile, or package.

The actual Apple Clang binary, SDK, and deployment target are recorded in hash-bound build provenance.

The source is patched with zero fuzz; Cargo uses the unchanged frozen lock, release LTO, and one build job.

Cargo's Darwin `.dylib` is copied to `native-kv.node`; application startup only verifies and loads prepared bytes.

The producer refuses other platforms before output, download, or process creation. It has no npm or compiler fallback.

Commands enter a detached, stopped process group before admission, then resume only after the group is verified.

The deadline sends SIGTERM to that group, followed by SIGKILL after ten seconds, with exit and descendant settlement.

This process-group behavior still requires actual Darwin proof; the Linux rejection test cannot establish it.

Mac bootstrap passes the tracked Darwin manifest through the existing `inputsManifest` binding seam.

Its expected provenance SHA comes from the parent producer receipt or independently verified release manifest.

An adjacent manifest's self-hash cannot authorize native loading. Existing Linux binding and manifest stay unchanged.

Linux CI can use `buildNativeKv(output, {toolchainDirectory: verifiedCompilerBin})` without changing HOME.

That optional preparation API retains its original default and exact Linux compiler pins, target, and locked graph.

Actual Mac gates remain required: pinned Bun load, raw budgets and rollback, CAS/contention, and first-party facade.

Prove context, value/key/cursor/restart behavior, missing/corrupt artifact refusal, and no eager original addon load.

The exact Mac startup must pass Seatbelt allow/deny probes for filesystem, network, and process creation.

Retain source/runtime/native identity and settled children. Linux proofs do not count as Mac or Seatbelt acceptance.

No service activation, live database, credential, private SSH, or production change is authorized by this producer.
