# Gateway compaction

Rust port of the existing gateway Jev compaction algorithm, originally adapted from `0x4007/fast-jev-compaction` commit `c1eab5fdbd6bde7d67f2da070116496558836884` under MIT; the upstream license is retained verbatim.

The algorithm source of truth is this repository's `lib/jev_compaction/{types,request,state,compact,codex_items}.ts` and `src/jev_compaction/{compaction,hybrid}.ts`, including its later fitting, bounded provenance, windowing and residue changes. M31's source contract and original source hashes accompany the focused golden fixtures.

The finite `CompactionHost` receives only Jev state/questions or the fixed buffered residue body, never a caller URL or credential. Its Jev transport must enforce the supplied 30000ms timeout through body consumption and forward caller cancellation; residue calls remain buffered with the source 20000ms bound. M05 owns interception, existing switch defaults and the original request/admission/fallback lifecycle.

The source-golden corpus covers exact header and response bytes, UTF-16 and JavaScript number/property semantics, fitting stages, windowing, dropped provenance, and partial residue behavior. Supplemental summary fixtures losslessly pack the actual source output, including cap fitting, stable equal-score ordering, accepted and refused multi-megabyte floors, and fitting before the no-reduction check. Controlled pending-I/O tests exercise the three-window and four-residue worker bounds plus cancellation.

Status: source implementation only. Native/WASM acceptance is bound to the matching immutable receipt, not this document. Actual Worker/runtime, admission/delivery and provider acceptance remain separate and are not claimed by the crate.
