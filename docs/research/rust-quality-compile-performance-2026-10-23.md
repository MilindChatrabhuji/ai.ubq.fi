# Rust quality and compile-performance policy - 2026-10-23

This document records the owner-requested Rust lint, code-quality, and compile-performance program for the Rust port. It is subordinate to the four non-negotiable rules in `AGENTS.md`. The recommendations came from one explicitly authorized GPT Pro submission (`gpt-6-pro`, job `66ca9a42-20cf-4ff8-acd2-e01653d97ea3`) and are applied incrementally.

## Structural gate

- `scripts/rust-quality.ts` is the fast structural gate. It records a no-growth baseline for first-party crate source, `pub use`/visible re-exports, `#[path]`, `include!`, and source suppressions.
- A crate budget is the total physical lines in `rust/crates/<crate>/src/**/*.rs`, including inline tests, comments, and inactive configurations. The cap is 1000.
- A new or renamed crate never inherits an oversized allowance. A reduction lowers the baseline; the entry is removed at or below 1000.
- Re-exports are checked as visible `use` declarations, not just `pub use`: `pub(crate)`, `pub(super)`, `pub(in ...)`, and visible `extern crate` also count.
- `#[path]` checks include direct attributes and `path = ...` inside `cfg_attr`. `include!` checks do not treat `include_str!` or `include_bytes!` as source inclusion.
- A missing `[lints] workspace = true` in a first-party manifest is a policy failure.
- Regex scanning is the current enforcement mechanism. A parser-backed checker is preferred for edge cases in generated or macro-authored source; until then, changed macros and generation paths require review, and a parser must not silently accept unsupported syntax.

## Lint policy

- Do not enable entire `pedantic`, `restriction`, `nursery`, or `cargo` groups. Select lints individually and keep the set small.
- No `#[allow]` or `#[expect]` suppression is accepted. Existing suppressions are recorded debt and must be removed by fixing the design or the test.
- Keep `clippy::all` and add `clippy::correctness` as fatal. Add only lints that pass the current workspace without source changes. Lints that need a cleanup pass stay staged.
- Staging uses explicit `--force-warn` flags plus a diagnostic baseline. Do not weaken the ordinary `-D warnings` gate, use `--cap-lints`, or mark a job `continue-on-error`.
- `rust/clippy.toml` owns the thresholds: 120 function lines, 7 arguments, type complexity 250, nesting 5, wildcard-import warnings, and unwrap/expect warnings in tests disabled.
- Do not copy the TypeScript cognitive-complexity setting of 15 into Clippy. Clippy's cognitive-complexity lint is not equivalent; use function length, nesting, and review of branching instead.
- Candidate staged lints include `pub_use`, `unwrap_used`, `expect_used`, `too_many_lines`, `wildcard_imports`, and the lossy-cast family. They are not enabled until their existing findings are baselined or removed.

## Compile performance

- The 1000-line crate cap is an architectural review constraint, not proof of a compile-speed improvement. Track structural compliance and build performance separately.
- Keep the production `[profile.release]` unchanged until the complete Worker build is measured. The measured candidate is a separate `release-candidate` profile: inherits release, `lto = "thin"`, `codegen-units = 16`.
- Development and test profiles use `opt-level = 0`, `debug = "line-tables-only"`, and `incremental = true`. The verification launcher may still force debug off for reproducible CI.
- Do not set development codegen units globally; rustc already chooses a parallel default. Lower debug information at generation time rather than stripping afterward.
- Remove the duplicate `cargo check` immediately before `cargo clippy`; Clippy performs the type check. Keep a single developer `cargo check` for fast feedback.
- Measure fresh-target, no-change, private-body edit, public-signature edit, fixture-only edit, and complete Worker-build cases separately. Record median, spread, peak memory, rebuilt units, and artifact bytes over at least five paired warm trials.
- Proposed acceptance: 20 percent lower median edit-to-check or edit-to-test; investigate a repeatable regression over 10 percent and one second. Adopt a release candidate only after a material full-pipeline improvement with unchanged parity and no more than 5 percent deployment-size, startup, or request-CPU regression.
- Keep native/OS dependencies out of the WASM graph. Check the shipped Worker feature set, not only `--all-features`. Use `cargo tree` for duplicates and a pinned `cargo-machete` report before removing dependencies.
- Test targets are separate crates. Keep each integration-test target at or below 1000 lines, consolidate related tests only while the target stays under the cap, and use a real bounded dev-only helper crate for shared support instead of `#[path]` or `include!`.

## Crate extraction

- Extract one coherent responsibility with a narrow interface, no dependency back-edge, independent tests, and change independence from consumers.
- Prefer 600-850 lines for a newly extracted crate so maintenance has headroom. Do not create one ubiquitous `gateway-common` crate or a chain of forwarding/re-export modules.
- Move genuine public-behavior tests to a bounded integration target; keep private invariant tests near the implementation. Do not widen visibility solely to relocate a test.
- Preserve parity evidence for status/error mapping, headers, serialized output, streaming framing and termination, cancellation, retry behavior, and observability fields. A stable test count alone is insufficient.

## Migration order

1. Establish accurate source, dependency, test, and timing baselines.
2. Block new structural violations while grandfathering existing ones individually.
3. Remove source inclusion and path indirection, then re-exports.
4. Relocate genuine test data and public-behavior tests.
5. Extract small coherent crates and keep the adapters thin.
6. Tune release compilation only after measuring the complete Worker build.

## Caveats

- A Cargo package can produce several compiler crates. The current gate measures the package's `src` implementation; integration-test-target accounting remains a follow-up unless explicitly extended.
- Re-exports are normal Rust API practice. Under the owner rule, the defining module path is the supported API; do not add aliases, facades, or compatibility re-exports to evade the check.
- A 1000-line crate cap can add interfaces and compilation boundaries. The compliant resolution is small capability crates with narrow interfaces, not hiding code in macros or generated strings.

## Provenance

GPT Pro job `66ca9a42-20cf-4ff8-acd2-e01653d97ea3`, submitted 2026-10-23T13:32Z, completed 2026-10-23T13:48Z. The owner explicitly authorized one submission with the invocation `$gpt-pro`. The full answer is retained for the current session at `/tmp/ai-rust-gpt-pro-answer-20261023.md`; this document is the durable policy summary. No provider or deployment credentials were included in the prompt.
