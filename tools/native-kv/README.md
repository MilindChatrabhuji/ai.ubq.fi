# Pinned native KV backend

This auxiliary backend keeps the `@deno/kv@0.14.0` native API and its ten-check atomic limit.

The source is denoland/denokv commit `9fe65cc138ff56ca5bfe7a1bf8c53e832246f9d5`.

`atomic-write-rollback.patch` adds a savepoint around each atomic write in the existing SQLite batch transaction.

A mutation error rolls back that write's earlier mutations, expiry changes, and data-version increment.

Other writes in the batch retain their independent success or failure result and existing notification behavior.

The patch does not add checks, split a caller's commit, change limits, or modify value and key codecs.

`napi-workspace.patch` moves the nested NAPI crate into the root workspace and retains its release LTO setting.

The frozen `Cargo.lock` preserves all 304 original package versions, sources, and checksums.

Only 18 missing NAPI graph packages were resolved once. `lock-derivation.json` records every addition.

`inputs.json` binds the source archive, both patches, lock, registry checksum inventory, license, and toolchain.

Run the prepared-artifact builder from the checkout with its pinned Bun runtime:

```sh
bun --no-env-file --no-install scripts/build-native-kv.ts
```

The no-argument command writes `.tmp/native-kv/native-kv.node` and `.tmp/native-kv/native-kv.provenance.json`.

Packaging calls `buildNativeKv(outputDirectory)` with the staged release's `.native/kv` directory.

The returned receipt includes artifact and provenance paths and SHA-256 hashes, plus the retained build-log path.

The build verifies pinned Rust/Cargo 1.98.1 binaries already installed under the executing account's Rustup toolchain.

It downloads only the checksum-bound source and locked Cargo dependencies during artifact preparation.

Source, Cargo home, compiler target, and logs stay in a dedicated `.tmp/native-kv-builds/uos-native-kv-*` directory in the builder checkout.

The scratch root is independent of the current directory, artifact output path, and inherited `TMPDIR`. Compiler subprocesses use its `tmp` subdirectory through `TMPDIR`. Build trees and logs remain retained on success or failure.

Cargo uses `--locked --release --jobs 1` and a 30-minute process-group timeout. No compiler is installed.

The provenance copies every frozen input section and records successful exit status and the compiler-log SHA-256.

Release packaging binds the provenance hash independently.

Runtime verifies that binding and the artifact before loading.

Application startup does not build, download, install, or select an npm native-addon fallback.

This recipe currently supports Linux ARM64, target `aarch64-unknown-linux-gnu`, with N-API 4 and Bun 1.4.0.

macOS and other targets require separately pinned toolchain artifacts and actual platform acceptance.

The published backend and this patch both report SQLite lock errors with concurrent writers on independent handles.

The application retains one KV handle; basic concurrent callers and CAS are checked against that shared handle.

This build does not establish byte-identical output across different hosts or build directories.
