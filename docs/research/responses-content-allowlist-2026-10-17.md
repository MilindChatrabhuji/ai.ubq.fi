# Responses content allowlist audit, 2026-10-17

The audit compared gateway base `c47b6f87f4d28570d6b1e71b3752a4e2dc1c39a3` with the official [Responses create schema](https://developers.openai.com/api/reference/resources/responses/methods/create) and [Chat Completions create schema](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), fetched on 2026-10-17 at approximately 23:34 UTC. Their HTML SHA-256 digests were `af02e2828fbb18c67e79e63c44c796117946e92afb1bb42429007ef1019f8fd3` and `64ecb73e00605023c2800858a4e94fb859c2bb82410a45f10f5b4929c289d49f`, respectively.

`output_text.logprobs` is the sole missing documented field name among the supported content shapes. Accept it only as an array, including an empty array, and drop it alongside `annotations` before constructing provider input. Array entries are deliberately opaque, matching the existing annotation validation and Codex's `Vec<Value>` representation. Keep rejecting non-arrays and genuinely unknown outer fields. Chat's top-level `logprobs` generation control is a separate field.

## Every allowlist decision

`src/input-normalization.ts` has 14 calls to `findUnknownContentField`, with 15 field sets because Responses text chooses between input and output shapes. This table includes nested objects and shared controls. Only the `output_text` field set changes.

| Shape                   | Recognized field names                                                                      | Decision                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache breakpoint        | `mode`                                                                                      | Retain the documented `explicit` input control; reject other keys and values.                                                                           |
| Request cache options   | `mode`, `ttl`                                                                               | Retain documented optional controls; the subscription transport keeps its existing drop and warning behavior.                                           |
| Chat text               | `type`, `text`, `prompt_cache_breakpoint`                                                   | Project text to input or output text by role; retain applicable input cache controls. Do not accept output metadata here.                               |
| Chat refusal            | `type`, `refusal`, `prompt_cache_breakpoint`                                                | Keep the assistant-only, single-part refusal projection. The breakpoint key exists solely to return a specific rejection; refusal does not document it. |
| Chat image              | `type`, `image_url`, `prompt_cache_breakpoint`                                              | Project user image content and applicable cache controls to `input_image`.                                                                              |
| Nested Chat image URL   | `url`, `detail`                                                                             | Rename `url` to normalized `image_url` and retain the documented detail.                                                                                |
| Chat file               | `type`, `file`, `prompt_cache_breakpoint`                                                   | Project user file content and applicable cache controls to `input_file`.                                                                                |
| Nested Chat file        | `file_id`, `file_data`, `filename`                                                          | Retain documented strings, requiring a file source. Chat does not document `file_url` or `detail` on this object.                                       |
| Responses input text    | `type`, `text`, `prompt_cache_breakpoint`                                                   | Retain supported input fields; keep rejecting `annotations` and `logprobs`.                                                                             |
| Responses output text   | `type`, `text`, `annotations`, **`logprobs` added**                                         | Retain type and text. Accept array metadata and drop both metadata fields. Reject every other field.                                                    |
| Responses input image   | `type`, `image_url`, `file_id`, `detail`, `prompt_cache_breakpoint`                         | All documented field names already exist; retain supported source, detail and cache control.                                                            |
| Responses input file    | `type`, `file_id`, `file_data`, `file_url`, `filename`, `detail`, `prompt_cache_breakpoint` | All documented field names already exist; retain supported source, filename, detail and cache control.                                                  |
| Chat function tool call | `id`, `type`, `function`                                                                    | Map function calls to Responses calls, retaining their semantic fields. Custom calls are a distinct type.                                               |
| Nested Chat function    | `name`, `arguments`                                                                         | Retain string arguments byte-for-byte without JSON parsing.                                                                                             |
| Chat tool output text   | `type`, `text`, `prompt_cache_breakpoint`                                                   | Project supported text parts to function-call-output input text and retain applicable cache controls.                                                   |

Unknown content keys still fail at these allowlists. Responses non-message extension items retain their separate, existing opaque passthrough boundary; known `function_call_output` content arrays are normalized as input content.

## Existing capability gaps

- Responses documents `refusal` content as `{type, refusal}`, but the gateway's normalized content union has no refusal variant. Neither inspected Codex `ContentItem` enum contains one. Adding it requires a deliberate semantic projection.
- Codex `input_audio` uses `{type, audio_url}` and predates this replay change. Chat documents the distinct `{type, input_audio: {data, format}, prompt_cache_breakpoint}` shape. Both remain explicitly unsupported; dropping audio would lose model input.
- Chat documents custom tool calls as `{id, type: "custom", custom: {name, input}}`. The gateway supports function calls only; a custom call needs its own projection.
- The Responses `*Content` schema variants permit null cache breakpoints and optional media sources. The current parser rejects null breakpoints and null image/file sources, including a null unused source beside a valid source. Image `detail: null` and file `filename: null` are already supported and documented. These value differences are separate from missing field names.
- Existing role restrictions, the single-part Chat refusal rule, nonempty-source rules and omitted per-property maximum-length checks mean field-name coverage is not complete OpenAPI conformance.

These gaps do not justify widening this metadata repair or silently dropping semantic content.

## Codex and provider evidence

Read-only Codex source inspection at `20b4ff2f35f2193608385e4caa8da8ceee45a3cf`, `codex-rs/protocol/src/models.rs:879-908`, shows `OutputText` with optional `annotations` and `logprobs` arrays. The gateway's pinned gitlink, `34c5303f49d08a5a41294e2531d1e64b40c0302d`, already has `InputAudio` and `OutputText` at lines 840-856. The newer source supports the metadata shape; it is not established as the installed 0.163.0 binary's exact build provenance.

For ordinary GPT routes, including `gpt-6-astra` and `gpt-6.1-sol`, `responses-handler.ts` normalizes `rawBody.input` before `buildResponsesUpstreamBodies` builds the Codex and removed-provider bodies. The normalized `MessageContentItem` output variant remains `{type: "output_text", text: string}`. The Codex request builder repairs synthetic replay identifiers, then `codex/dispatch.ts` serializes that normalized input. Paid fallback passes the same prepared body to Surplus and OpenLux; their serializers preserve nested text content. Dropping output metadata at this common boundary therefore covers all three GPT transports without relying on upstream acceptance of output metadata as input.

The regression checks both normalized upstream body projections and the actual Surplus/OpenLux serialized request bodies through injected fetchers. Those checks perform no provider inference. Live provider selection, catalog availability, upstream acceptance and deployment remain unproved by this source audit.

## Wire fixture provenance

`tests/fixtures/codex-0.163.0-logprobs.json` is a fresh HTTP body captured on 2026-10-17 at approximately 23:36 UTC from the installed, unmodified `codex-cli 0.163.0` binary, SHA-256 `8a96f66d059d653e68bfd5f3c79337e6f1d7d170d80bf705eb7d0249b34c0ece`. An initial `exec` and a resumed `exec` both exited 0 and made exactly two requests to an offline loopback mock. The mock supplied two output-text parts with empty and populated log-probability arrays; the second real client request replayed both. The private network namespace had only loopback and no routes. Capture receipt: `c18ba89e18e8c4c810e8dfab831978ea7ed5aa33d6f343bf3282dea4e12db13c/d5b2fd61-8d88-4be8-827b-05851f6012e9`.

The fixture retains all nine input items, the `additional_tools` envelope, message roles, schema keys, booleans and array cardinalities. Prompts, descriptions, grammar contents, identities, metadata values and token values were replaced with synthetic values; only scrubbed bodies were written. The cited historical rollout contains replay output and the rejection, but no full HTTP body, so this fixture is a fresh mock capture rather than a historical reconstruction. It proves client serialization and offline normalization, not live gateway, provider, review or deployment acceptance.
