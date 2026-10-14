import { test } from "bun:test";
import assert from "node:assert/strict";
import { STANDARD_RATE_LIMIT_HEADERS } from "../src/http.ts";
import { MAX_ACCEPTED_JSON_BODY_BYTES } from "../src/request.ts";
import { captureAcceptedSentinelReplayInput, materializeSentinelReplayInput, zeroSentinelReplayInput } from "../src/sentinel/replay-capture.ts";
import {
  buildImageResponsesRequest,
  createImageFanoutDispatchCoordinator,
  extractImagesFromResponses,
  handleImages,
  setImageBaseModelForTest,
} from "../src/images.ts";

/** Pin the tool host so the suite never depends on ambient deployment config. */
const withBaseModel = async (model: string, run: () => Promise<void>): Promise<void> => {
  setImageBaseModelForTest(model);
  try {
    await run();
  } finally {
    setImageBaseModelForTest(null);
  }
};

const imagesRequest = (body: unknown, path = "/v1/images/generations"): Request =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const imageResponse = (result: string, options: Readonly<{ createdAt?: number; headers?: HeadersInit; revisedPrompt?: string }> = {}): Response =>
  new Response(
    JSON.stringify({
      created_at: options.createdAt ?? 1787431659,
      output: [
        {
          type: "image_generation_call",
          result,
          output_format: "png",
          ...(options.revisedPrompt ? { revised_prompt: options.revisedPrompt } : {}),
        },
      ],
    }),
    { status: 200, headers: options.headers }
  );

/** Reject with an Error once `signal` aborts, keeping the abort reason as the cause. */
const rejectWhenAborted = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_, reject) => {
    const rejectOnAbort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error("image fan-out child aborted", { cause: reason }));
    };
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    if (signal.aborted) rejectOnAbort();
  });

test("an images request forces one image-generation tool call", () => {
  const built = buildImageResponsesRequest(
    {
      model: "gpt-image-2",
      prompt: "a green triangle",
      size: "1024x1024",
      quality: "high",
      // This is an edit-only Images option and must not leak into generations.
      input_fidelity: "high",
    },
    "gpt-5.6-sol",
    "generations"
  );
  assert.equal(built.model, "gpt-5.6-sol");
  assert.equal(built.input, "a green triangle");
  assert.deepEqual(built.tools, [
    {
      type: "image_generation",
      action: "generate",
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "high",
    },
  ]);
  assert.deepEqual(built.tool_choice, { type: "image_generation" });
});

test("JSON edits preserve image URL references and user", () => {
  const built = buildImageResponsesRequest(
    {
      prompt: "make it blue",
      user: "customer-1",
      images: [{ image_url: "https://example.com/source.png" }],
      mask: { image_url: "data:image/png;base64,BA==" },
    },
    "gpt-5.6-sol",
    "edits"
  );
  assert.equal(built.user, "customer-1");
  assert.deepEqual(built.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "make it blue" },
        { type: "input_image", image_url: "https://example.com/source.png" },
      ],
    },
  ]);
  assert.deepEqual(built.tools, [
    {
      type: "image_generation",
      action: "edit",
      model: "gpt-image-1.5",
      input_image_mask: { image_url: "data:image/png;base64,BA==" },
    },
  ]);
  assert.deepEqual(built.tool_choice, { type: "image_generation" });
});

test("image response items preserve revised_prompt but omit output_format", () => {
  const payload = {
    id: "resp_1",
    output: [
      { id: "rs_1", type: "reasoning", summary: [] },
      {
        id: "ig_1",
        type: "image_generation_call",
        status: "completed",
        output_format: "png",
        revised_prompt: "a refined prompt",
        result: "AAAA",
      },
    ],
  };
  assert.deepEqual(extractImagesFromResponses(payload), [{ b64_json: "AAAA", revised_prompt: "a refined prompt" }]);
  assert.deepEqual(extractImagesFromResponses({ output: [] }), []);
  assert.deepEqual(extractImagesFromResponses({ output: [{ type: "image_generation_call" }] }), []);
  assert.deepEqual(extractImagesFromResponses(null), []);
});

test("a successful generation returns the OpenAI Images shape", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const seen: Record<string, unknown>[] = [];
    const dispatch = async (request: Request): Promise<Response> => {
      assert.equal(request.headers.get("content-type"), "application/json");
      assert.equal(request.headers.get("content-length"), null);
      seen.push(await request.json());
      return imageResponse("BBBB", {
        headers: { "x-uos-upstream": "chatgpt_codex", "x-uos-warning": "user_ignored" },
        revisedPrompt: "a round circle",
      });
    };
    const response = await handleImages(
      imagesRequest({
        model: "gpt-image-2",
        prompt: "a circle",
        output_compression: 50,
        response_format: "b64_json",
        user: "customer-1",
      }),
      "generations",
      undefined,
      { dispatch }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
    assert.equal(response.headers.get("x-uos-warning"), "user_ignored");
    assert.deepEqual(await response.json(), {
      created: 1787431659,
      data: [{ b64_json: "BBBB", revised_prompt: "a round circle" }],
      output_format: "png",
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.model, "gpt-5.6-sol", "dispatch must target the base text model");
    assert.equal(seen[0]?.user, "customer-1");
    assert.equal(seen[0]?.response_format, undefined);
    assert.equal((seen[0]?.tools as Record<string, unknown>[] | undefined)?.[0]?.output_compression, 50);
  });
});

test("image prompt limits count Unicode code points", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const prompt = "😀".repeat(20_000);
    let nestedPrompt: unknown = null;
    const response = await handleImages(imagesRequest({ prompt }), "generations", undefined, {
      dispatch: async (request) => {
        nestedPrompt = ((await request.json()) as Record<string, unknown>).input;
        return imageResponse("VU5JQ09ERQ==");
      },
    });
    assert.equal(response.status, 200);
    assert.equal(nestedPrompt, prompt);
  });
});

test("multipart edits become JSON Responses input with a binary mask", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", "combine these images");
    form.append("image", new File([new Uint8Array([1, 2, 3])], "first.png"));
    form.append("image[]", new File([new Uint8Array([5, 6])], "second.webp", { type: "application/octet-stream" }));
    form.append("image", new File([new Uint8Array([7])], "third.png", { type: "image/png" }));
    form.append("mask", new File([new Uint8Array([4])], "mask.png"));
    form.append("input_fidelity", "high");
    form.append("quality", "high");
    form.append("output_compression", "50");
    form.append("response_format", "b64_json");
    form.append("stream", "false");
    form.append("user", "customer-2");

    const nestedBodies: Record<string, unknown>[] = [];
    const response = await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: form }), "edits", undefined, {
      dispatch: async (request) => {
        assert.equal(request.headers.get("content-type"), "application/json");
        assert.equal(request.headers.get("content-length"), null);
        nestedBodies.push(await request.json());
        return imageResponse("CCCC");
      },
    });
    assert.equal(response.status, 200);
    assert.equal(nestedBodies.length, 1);
    const nested = nestedBodies[0];
    assert.equal(nested.user, "customer-2");
    assert.deepEqual(nested.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "combine these images" },
          { type: "input_image", image_url: "data:image/png;base64,AQID" },
          { type: "input_image", image_url: "data:image/webp;base64,BQY=" },
          { type: "input_image", image_url: "data:image/png;base64,Bw==" },
        ],
      },
    ]);
    assert.deepEqual(nested.tools, [
      {
        type: "image_generation",
        action: "edit",
        model: "gpt-image-2",
        input_fidelity: "high",
        quality: "high",
        output_compression: 50,
        input_image_mask: { image_url: "data:image/png;base64,BA==" },
      },
    ]);
  });
});

test("multipart edits reject DALL-E-only quality before Responses dispatch", async () => {
  const form = new FormData();
  form.append("prompt", "edit the source");
  form.append("image", new File([new Uint8Array([1])], "source.png", { type: "image/png" }));
  form.append("quality", "standard");
  let dispatches = 0;
  const response = await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: form }), "edits", undefined, {
    dispatch: () => {
      dispatches += 1;
      return Promise.resolve(imageResponse("VU5SRUFDSFJFRA=="));
    },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error?.param, "quality");
  assert.equal(dispatches, 0);
});

test("multipart edits reject JSON-only moderation before dispatch", async () => {
  const form = new FormData();
  form.append("prompt", "edit the source");
  form.append("image", new File([new Uint8Array([1])], "source.png", { type: "image/png" }));
  form.append("moderation", "auto");
  let dispatches = 0;
  const response = await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: form }), "edits", undefined, {
    dispatch: () => {
      dispatches += 1;
      return Promise.resolve(imageResponse("VU5SRUFDSFJFRA=="));
    },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error?.param, "moderation");
  assert.equal(dispatches, 0);
});

test("multipart edits reject unsupported source and mask files before dispatch", async () => {
  const cases = [
    {
      source: new File([new Uint8Array([1])], "source.gif", { type: "image/gif" }),
      mask: null,
      param: "image",
    },
    {
      source: new File([new Uint8Array([1])], "source.png", { type: "image/png" }),
      mask: new File([new Uint8Array([2])], "mask.jpeg", { type: "image/jpeg" }),
      param: "mask",
    },
  ] as const;
  let dispatches = 0;
  for (const testCase of cases) {
    const form = new FormData();
    form.append("prompt", "edit the source");
    form.append("image", testCase.source);
    if (testCase.mask) form.append("mask", testCase.mask);
    const response = await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: form }), "edits", undefined, {
      dispatch: () => {
        dispatches += 1;
        return Promise.resolve(imageResponse("VU5SRUFDSFJFRA=="));
      },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error?.param, testCase.param);
  }
  assert.equal(dispatches, 0);
});

test("multipart edits accept PNG masks above the legacy 4 MiB limit", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const form = new FormData();
    form.append("prompt", "edit with a larger mask");
    form.append("image", new File([new Uint8Array([1])], "source.png", { type: "image/png" }));
    form.append("mask", new File([new Uint8Array(5 * 1_024 * 1_024)], "mask.png", { type: "image/png" }));
    let dispatches = 0;
    const response = await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: form }), "edits", undefined, {
      dispatch: () => {
        dispatches += 1;
        return Promise.resolve(imageResponse("TEFSR0VfTUFTSw=="));
      },
    });
    assert.equal(response.status, 200);
    assert.equal(dispatches, 1);
  });
});

test("multipart edits validate file limits before reading file bytes", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const originalSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size");
    const originalArrayBuffer = Object.getOwnPropertyDescriptor(Blob.prototype, "arrayBuffer");
    const originalFormData = Object.getOwnPropertyDescriptor(Request.prototype, "formData");
    if (!originalFormData || typeof originalFormData.value !== "function") throw new TypeError("Missing native Request.formData");
    assert.ok(originalSize && "get" in originalSize);
    assert.ok(originalArrayBuffer?.value);
    let arrayBufferReads = 0;
    const withFileGuards = async (request: Request, reportedSize?: number): Promise<Response> => {
      Object.defineProperty(Blob.prototype, "arrayBuffer", {
        ...originalArrayBuffer,
        value: function (this: Blob): Promise<ArrayBuffer> {
          arrayBufferReads += 1;
          return originalArrayBuffer.value.call(this) as Promise<ArrayBuffer>;
        },
      });
      Request.prototype.formData = async function (this: Request): Promise<FormData> {
        const form = await (originalFormData.value.call(this) as Promise<FormData>);
        if (reportedSize === undefined) return form;
        const controlled = new FormData();
        const bytes = new Uint8Array(reportedSize);
        for (const [name, entry] of form.entries()) {
          const value: unknown = entry;
          if (typeof value === "string") controlled.append(name, value);
          else if (value instanceof File) controlled.append(name, new File([bytes], value.name, { type: value.type }));
          else throw new TypeError("Unexpected multipart fixture entry");
        }
        return controlled;
      };
      try {
        return await handleImages(request, "edits", undefined, {
          dispatch: () => {
            throw new Error("invalid multipart input must not dispatch");
          },
        });
      } finally {
        Object.defineProperty(Request.prototype, "formData", originalFormData);
        Object.defineProperty(Blob.prototype, "arrayBuffer", originalArrayBuffer);
      }
    };

    const missingPrompt = new FormData();
    missingPrompt.append("image", new File(["small fixture"], "source.png", { type: "image/png" }));
    const missingPromptResponse = await withFileGuards(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: missingPrompt }));
    assert.equal(missingPromptResponse.status, 400);
    assert.equal(arrayBufferReads, 0);

    const invalidCount = new FormData();
    invalidCount.append("prompt", "invalid count");
    invalidCount.append("n", "11");
    invalidCount.append("image", new File(["small fixture"], "source.png", { type: "image/png" }));
    const invalidCountResponse = await withFileGuards(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: invalidCount }));
    assert.equal(invalidCountResponse.status, 400);
    assert.equal(arrayBufferReads, 0);

    const tooMany = new FormData();
    tooMany.append("prompt", "too many");
    for (let index = 0; index < 17; index += 1) {
      tooMany.append("image[]", new File([String(index)], `${index}.png`, { type: "image/png" }));
    }
    const tooManyResponse = await withFileGuards(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: tooMany }));
    assert.equal(tooManyResponse.status, 400);
    assert.equal(arrayBufferReads, 0);

    const oversized = new FormData();
    oversized.append("prompt", "oversized");
    oversized.append("image", new File(["small fixture"], "large.png", { type: "image/png" }));
    const oversizedRequest = new Request("http://127.0.0.1/v1/images/edits", {
      method: "POST",
      body: oversized,
    });
    const oversizedResponse = await withFileGuards(oversizedRequest, 50 * 1_024 * 1_024);
    assert.equal(oversizedResponse.status, 400);
    assert.equal(arrayBufferReads, 0);

    const aggregateTooLarge = new FormData();
    aggregateTooLarge.append("prompt", "aggregate too large");
    aggregateTooLarge.append("image", new File(["first"], "first.png", { type: "image/png" }));
    aggregateTooLarge.append("image", new File(["second"], "second.png", { type: "image/png" }));
    const aggregateTooLargeRequest = new Request("http://127.0.0.1/v1/images/edits", {
      method: "POST",
      body: aggregateTooLarge,
    });
    const aggregateTooLargeResponse = await withFileGuards(aggregateTooLargeRequest, 26 * 1_024 * 1_024);
    assert.equal(aggregateTooLargeResponse.status, 400);
    assert.equal((await aggregateTooLargeResponse.json()).error?.param, "image");
    assert.equal(arrayBufferReads, 0);

    const excessiveFanout = new FormData();
    excessiveFanout.append("prompt", "excessive fanout");
    excessiveFanout.append("n", "10");
    excessiveFanout.append("image", new File(["small fixture"], "large.png", { type: "image/png" }));
    const excessiveFanoutRequest = new Request("http://127.0.0.1/v1/images/edits", {
      method: "POST",
      body: excessiveFanout,
    });
    const excessiveFanoutResponse = await withFileGuards(excessiveFanoutRequest, 6 * 1_024 * 1_024);
    assert.equal(excessiveFanoutResponse.status, 400);
    assert.equal(arrayBufferReads, 0);

    const declaredTooLarge = new FormData();
    declaredTooLarge.append("prompt", "declared too large");
    declaredTooLarge.append("image", new File(["small fixture"], "small.png", { type: "image/png" }));
    const declaredTooLargeRequest = new Request("http://127.0.0.1/v1/images/edits", {
      method: "POST",
      body: declaredTooLarge,
    });
    declaredTooLargeRequest.headers.set("content-length", String(64 * 1_024 * 1_024 + 1));
    const declaredTooLargeResponse = await withFileGuards(declaredTooLargeRequest);
    assert.equal(declaredTooLargeResponse.status, 400);
    assert.equal(arrayBufferReads, 0);
  });
});

test("multipart edits retain the documented file allowance after internal base64 conversion", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const form = new FormData();
    form.append("prompt", "preserve a large source image");
    form.append("image", new File([new Uint8Array(16 * 1_024 * 1_024)], "large.png", { type: "image/png" }));
    let dispatches = 0;
    const response = await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: form }), "edits", undefined, {
      dispatch: () => {
        dispatches += 1;
        return Promise.resolve(imageResponse("TEFSR0U="));
      },
    });
    assert.equal(response.status, 200);
    assert.equal(dispatches, 1);
  });
});

test("multipart image failures retain raw bodies within the Sentinel replay cap", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const form = new FormData();
    form.append("prompt", "replay this multipart failure");
    form.append("image", new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" }));
    const request = new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: form });
    const candidate = captureAcceptedSentinelReplayInput(request, "multipart-replay");
    assert.ok(candidate);

    const response = await handleImages(request, "edits", undefined, {
      dispatch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "upstream failed" } }), {
            status: 502,
            headers: { "content-type": "application/json" },
          })
        ),
    });
    assert.equal(response.status, 502);
    const captured = materializeSentinelReplayInput(candidate);
    assert.ok(captured);
    assert.ok(captured.body.byteLength < MAX_ACCEPTED_JSON_BODY_BYTES);
    assert.match(new TextDecoder().decode(captured.body), /replay this multipart failure/);
    zeroSentinelReplayInput(captured);
    assert.deepEqual(new Set(captured.body), new Set([0]));
  });
});

test("malformed multipart image bodies are not retained for Sentinel replay", async () => {
  const request = new Request("http://127.0.0.1/v1/images/edits", {
    method: "POST",
    headers: { "content-type": "multipart/form-data" },
    body: "this is not a multipart body",
  });
  const candidate = captureAcceptedSentinelReplayInput(request, "malformed-multipart-replay");
  assert.ok(candidate);

  const response = await handleImages(request, "edits", undefined, {
    dispatch: () => Promise.resolve(imageResponse("VU5SRUFDSEFCTEU=")),
  });
  assert.equal(response.status, 400);
  assert.equal(materializeSentinelReplayInput(candidate), null);
});

test("JSON edits normalize case-insensitive inline image data URLs", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const nestedBodies: Record<string, unknown>[] = [];
    const response = await handleImages(
      imagesRequest(
        {
          model: "gpt-image-2",
          prompt: "add a window",
          size: "2048x2048",
          images: [{ image_url: "DATA:IMAGE/PNG;BASE64,AQID" }],
          mask: { image_url: "DATA:IMAGE/PNG;BASE64,BA==" },
        },
        "/v1/images/edits"
      ),
      "edits",
      undefined,
      {
        dispatch: async (request) => {
          nestedBodies.push(await request.json());
          return imageResponse("Tk9STUFMSVpFRA==");
        },
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual((nestedBodies[0]?.input as Record<string, unknown>[] | undefined)?.[0]?.content, [
      { type: "input_text", text: "add a window" },
      { type: "input_image", image_url: "data:image/png;base64,AQID" },
    ]);
    const tool: Record<string, unknown> | undefined = (nestedBodies[0]?.tools as Record<string, unknown>[] | undefined)?.[0];
    assert.equal(tool?.size, "2048x2048");
    assert.deepEqual(tool.input_image_mask, {
      image_url: "data:image/png;base64,BA==",
    });
  });
});

test("JSON edits reject remote masks and unbound file IDs before dispatch", async () => {
  let dispatches = 0;
  const dispatch = () => {
    dispatches += 1;
    return Promise.resolve(imageResponse("VU5SRUFDSFJFRA=="));
  };
  for (const [body, param] of [
    [{ prompt: "edit", images: [{ file_id: "file-source" }] }, "images"],
    [
      {
        prompt: "edit",
        images: [{ image_url: "https://example.com/source.png" }],
        mask: { file_id: "file-mask" },
      },
      "mask",
    ],
    [
      {
        prompt: "edit",
        images: [{ image_url: "https://example.com/source.png" }],
        mask: { image_url: "https://example.com/mask.png" },
      },
      "mask",
    ],
    [
      {
        prompt: "edit",
        images: [{ image_url: "https://example.com/source.png" }],
        mask: { image_url: "data:image/webp;base64,BA==" },
      },
      "mask",
    ],
  ] as const) {
    const response = await handleImages(imagesRequest(body, "/v1/images/edits"), "edits", undefined, { dispatch });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error?.param, param);
  }
  assert.equal(dispatches, 0);
});

test("JSON edits reject malformed source image URLs before dispatch", async () => {
  let dispatches = 0;
  const dispatch = () => {
    dispatches += 1;
    return Promise.resolve(imageResponse("VU5SRUFDSFJFRA=="));
  };
  for (const imageUrl of ["not a URL", "/relative/source.png", "https:example.com/source.png", "ftp://example.com/source.png"]) {
    const response = await handleImages(imagesRequest({ prompt: "edit", images: [{ image_url: imageUrl }] }, "/v1/images/edits"), "edits", undefined, {
      dispatch,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error?.param, "images");
  }
  assert.equal(dispatches, 0);
});

test("case-insensitive inline images obey the n fan-out work budget", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    let dispatches = 0;
    const response = await handleImages(
      imagesRequest(
        {
          prompt: "bounded fan-out",
          n: 10,
          images: [{ image_url: `DATA:IMAGE/PNG;BASE64,${"A".repeat(7 * 1_024 * 1_024)}` }],
        },
        "/v1/images/edits"
      ),
      "edits",
      undefined,
      {
        dispatch: () => {
          dispatches += 1;
          return Promise.resolve(imageResponse("VU5SRUFCSExF"));
        },
      }
    );
    assert.equal(response.status, 400);
    assert.equal(dispatches, 0);
  });
});

test("remote image references obey the n fan-out work budget", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    let dispatches = 0;
    const response = await handleImages(
      imagesRequest(
        {
          prompt: "bounded remote fan-out",
          n: 10,
          images: [{ image_url: `https://example.com/${"a".repeat(5 * 1_024 * 1_024 + 1)}` }],
        },
        "/v1/images/edits"
      ),
      "edits",
      undefined,
      {
        dispatch: () => {
          dispatches += 1;
          return Promise.resolve(imageResponse("VU5SRUFCSExF"));
        },
      }
    );
    assert.equal(response.status, 400);
    assert.equal(dispatches, 0);
  });
});

test("JSON edits enforce the official image_url character limit", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const oversizedUrl = `https://example.com/${"a".repeat(20_971_520)}`;
    let dispatches = 0;
    const response = await handleImages(
      imagesRequest(
        {
          prompt: "reject an oversized reference",
          images: [{ image_url: oversizedUrl }],
        },
        "/v1/images/edits"
      ),
      "edits",
      undefined,
      {
        dispatch: () => {
          dispatches += 1;
          return Promise.resolve(imageResponse("TEFSR0U="));
        },
      }
    );
    assert.equal(response.status, 400);
    assert.equal(dispatches, 0);
  });
});

test("n fans out forced Responses calls and aggregates one image per call", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const seen: Record<string, unknown>[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const responsePromise = handleImages(imagesRequest({ prompt: "two circles", n: 2, output_format: "webp" }), "generations", undefined, {
      dispatch: async (request) => {
        seen.push(await request.json());
        const index = seen.length;
        if (index === 1) await firstReleased;
        else markSecondStarted();
        return imageResponse(`IMAGE_${index}`, { createdAt: 100 + index, revisedPrompt: `prompt ${index}` });
      },
    });
    let startedConcurrently = true;
    let resolveTimeout: () => void = () => undefined;
    const timeoutExpired = new Promise<void>((resolve) => {
      resolveTimeout = resolve;
    });
    // The handle is a `const`, so its type is inferred instead of annotated: the lint project does not
    // resolve the `setTimeout` global, where `ReturnType<typeof setTimeout>` degrades to `any`.
    const timeout = setTimeout(() => {
      startedConcurrently = false;
      resolveTimeout();
    }, 100);
    try {
      await Promise.race([secondStarted, timeoutExpired]);
    } finally {
      clearTimeout(timeout);
      releaseFirst();
    }
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(startedConcurrently, true, "all image calls must share one response window");
    assert.equal(seen.length, 2);
    for (const body of seen) {
      assert.equal(body.n, undefined, "the Responses image tool has no n field");
      assert.deepEqual(body.tool_choice, { type: "image_generation" });
    }
    assert.deepEqual(await response.json(), {
      created: 101,
      data: [
        { b64_json: "IMAGE_1", revised_prompt: "prompt 1" },
        { b64_json: "IMAGE_2", revised_prompt: "prompt 2" },
      ],
      output_format: "png",
    });
  });
});

test("image fan-out aborts siblings and waits for every child after a hard failure", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const failure = new Error("first child failed");
    const cleanup = new AbortController();
    let calls = 0;
    let siblingStarted!: () => void;
    const siblingReady = new Promise<void>((resolve) => {
      siblingStarted = resolve;
    });
    let siblingObservedAbort = false;
    let siblingSettled = false;
    const request = new Request(imagesRequest({ prompt: "two circles", n: 2 }), {
      signal: cleanup.signal,
    });
    const dispatch = async (child: Request): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        await siblingReady;
        throw failure;
      }
      siblingStarted();
      return await rejectWhenAborted(child.signal).finally(() => {
        siblingObservedAbort = child.signal.aborted;
        siblingSettled = true;
      });
    };

    try {
      await assert.rejects(
        () => handleImages(request, "generations", undefined, { dispatch }),
        (error) => error === failure
      );
      assert.equal(siblingObservedAbort, true);
      assert.equal(siblingSettled, true);
    } finally {
      cleanup.abort(new DOMException("Test cleanup", "AbortError"));
    }
  });
});

test("image fan-out preserves the first non-OK response after aborting and settling siblings", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const leaderBody = { error: { message: "leader quota exhausted", type: "rate_limit_error" } };
    let resolveLeader!: (response: Response) => void;
    const leaderPromise = new Promise<Response>((resolve) => {
      resolveLeader = resolve;
    });
    let resolveSibling!: (response: Response) => void;
    let rejectSibling!: (reason: unknown) => void;
    const siblingPromise = new Promise<Response>((resolve, reject) => {
      resolveSibling = resolve;
      rejectSibling = reject;
    });
    let resolveBothDispatched!: () => void;
    const bothDispatched = new Promise<void>((resolve) => {
      resolveBothDispatched = resolve;
    });
    let calls = 0;
    let siblingObservedAbort = false;
    let siblingSettled = false;
    let siblingAbortReason: unknown;

    const responsePromise = handleImages(imagesRequest({ prompt: "two circles", n: 2 }), "generations", undefined, {
      dispatch: (child) => {
        const index = calls;
        calls += 1;
        if (calls === 2) resolveBothDispatched();
        if (index === 1) return leaderPromise;
        const rejectOnAbort = () => {
          siblingObservedAbort = true;
          siblingAbortReason = child.signal.reason;
          rejectSibling(child.signal.reason);
        };
        child.signal.addEventListener("abort", rejectOnAbort, { once: true });
        if (child.signal.aborted) rejectOnAbort();
        return siblingPromise.finally(() => {
          siblingSettled = true;
        });
      },
    });

    await bothDispatched;
    void leaderPromise.then(() => {
      resolveSibling(new Response(JSON.stringify({ error: { message: "late lower-index failure" } }), { status: 500 }));
    });
    resolveLeader(
      new Response(JSON.stringify(leaderBody), {
        status: 429,
        headers: { "Retry-After": "23" },
      })
    );

    const response = await responsePromise;
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "23");
    assert.deepEqual(await response.json(), leaderBody);
    assert.equal(siblingObservedAbort, true);
    assert.equal(siblingSettled, true);
    assert.equal((siblingAbortReason as DOMException | undefined)?.name, "AbortError");
  });
});

test("image fan-out creates isolated JSON child requests", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const childHeaders: Headers[] = [];
    const response = await handleImages(
      new Request("http://127.0.0.1/v1/images/generations", {
        method: "POST",
        headers: {
          authorization: "Bearer outer-credential",
          "content-type": "application/json",
          cookie: "session=outer-state",
          "idempotency-key": "outer-image-request",
          "x-forwarded-for": "198.51.100.7",
        },
        body: JSON.stringify({ prompt: "two circles", n: 2 }),
      }),
      "generations",
      undefined,
      {
        dispatch: (request) => {
          childHeaders.push(new Headers(request.headers));
          return Promise.resolve(imageResponse("RkFOT1VU"));
        },
      }
    );
    assert.equal(response.status, 200);
    assert.equal(childHeaders.length, 2);
    for (const headers of childHeaders) {
      assert.deepEqual([...headers.entries()], [["content-type", "application/json"]]);
    }
  });
});

test("image JSON ingress rejects declared and chunked oversized bodies before dispatch", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    let dispatches = 0;
    const dispatch = () => {
      dispatches += 1;
      return Promise.resolve(imageResponse("T1ZFUlNJWkVE"));
    };
    const declaredTooLarge = new Request("http://127.0.0.1/v1/images/generations", {
      method: "POST",
      headers: {
        "content-length": String(MAX_ACCEPTED_JSON_BODY_BYTES + 1),
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "never dispatch" }),
    });
    assert.equal((await handleImages(declaredTooLarge, "generations", undefined, { dispatch })).status, 400);

    const chunkedTooLarge = new Request("http://127.0.0.1/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_ACCEPTED_JSON_BODY_BYTES - 1));
          controller.enqueue(new Uint8Array(2));
          controller.close();
        },
      }),
    });
    assert.equal((await handleImages(chunkedTooLarge, "generations", undefined, { dispatch })).status, 400);
    assert.equal(dispatches, 0);
  });
});

test("fan-out dispatch coordination never refunds after a sibling transport starts", async () => {
  let releaseLeader!: () => void;
  const leaderGate = new Promise<void>((resolve) => {
    releaseLeader = resolve;
  });
  let admissionCalls = 0;
  let transportStarts = 0;
  let cancellations = 0;
  const coordinator = createImageFanoutDispatchCoordinator(2, async () => {
    admissionCalls += 1;
    if (admissionCalls > 1) return undefined;
    await leaderGate;
    return {
      markTransportStarted: () => {
        transportStarts += 1;
      },
      cancelBeforeTransport: () => {
        cancellations += 1;
        return Promise.resolve();
      },
    };
  });

  const leaderPromise = coordinator.beforeProviderDispatchFor(0)("chatgpt_codex");
  const follower = await coordinator.beforeProviderDispatchFor(1)("chatgpt_codex");
  assert.ok(follower);
  follower.markTransportStarted();
  releaseLeader();
  const leader = await leaderPromise;
  assert.ok(leader);
  await leader.cancelBeforeTransport();
  assert.equal(transportStarts, 1);
  assert.equal(cancellations, 0);
});

test("fan-out child cancellations settle locally before the outer refund", async () => {
  let admissionCalls = 0;
  let transportStarts = 0;
  let cancellations = 0;
  const coordinator = createImageFanoutDispatchCoordinator(2, () => {
    admissionCalls += 1;
    return Promise.resolve(
      admissionCalls === 1
        ? {
            markTransportStarted: () => {
              transportStarts += 1;
            },
            cancelBeforeTransport: () => {
              cancellations += 1;
              return Promise.resolve();
            },
          }
        : undefined
    );
  });
  const [first, second] = await Promise.all([
    coordinator.beforeProviderDispatchFor(0)("chatgpt_codex"),
    coordinator.beforeProviderDispatchFor(1)("chatgpt_codex"),
  ]);
  assert.ok(first);
  assert.ok(second);
  await Promise.all([first.cancelBeforeTransport(), second.cancelBeforeTransport()]);
  assert.equal(cancellations, 0);
  await coordinator.cancelBeforeTransport();
  await coordinator.cancelBeforeTransport();
  assert.equal(transportStarts, 0);
  assert.equal(cancellations, 1);
});

test("fan-out dispatch coordination can refund after all calls settle without transport", async () => {
  let admissionCalls = 0;
  let cancellations = 0;
  const coordinator = createImageFanoutDispatchCoordinator(2, () => {
    admissionCalls += 1;
    return Promise.resolve(
      admissionCalls === 1
        ? {
            markTransportStarted: () => {},
            cancelBeforeTransport: () => {
              cancellations += 1;
              return Promise.resolve();
            },
          }
        : undefined
    );
  });
  await Promise.all([coordinator.beforeProviderDispatchFor(0)("chatgpt_codex"), coordinator.beforeProviderDispatchFor(1)("chatgpt_codex")]);
  coordinator.settled(0);
  coordinator.settled(1);
  await coordinator.cancelBeforeTransport();
  await coordinator.cancelBeforeTransport();
  assert.equal(cancellations, 1);
});

test("nullable generation options use hosted tool defaults", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const seen: Record<string, unknown>[] = [];
    const response = await handleImages(
      imagesRequest({
        prompt: "nullable options",
        model: null,
        n: null,
        size: null,
        quality: null,
        output_compression: null,
        response_format: null,
        stream: null,
        partial_images: null,
        style: null,
      }),
      "generations",
      undefined,
      {
        dispatch: async (request) => {
          seen.push(await request.json());
          return imageResponse("TlVMTA==");
        },
      }
    );
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.tools, [{ type: "image_generation", action: "generate" }]);
  });
});

test("style is rejected before Responses translation", async () => {
  let dispatches = 0;
  for (const style of ["natural", "vivid"]) {
    const response = await handleImages(imagesRequest({ prompt: "styled image", style }), "generations", undefined, {
      dispatch: () => {
        dispatches += 1;
        return Promise.resolve(imageResponse("VU5SRUFDSFJFRA=="));
      },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error?.param, "style");
  }
  assert.equal(dispatches, 0);
});

test("image responses preserve only approved retry and rate-limit headers", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const upstreamHeaders = new Headers({
      "Retry-After": "17",
      "x-uos-upstream": "chatgpt_codex",
      "x-uos-warning": "user_ignored",
      "x-not-forwarded": "secret",
    });
    STANDARD_RATE_LIMIT_HEADERS.forEach((name, index) => {
      upstreamHeaders.set(name, `value-${index}`);
    });
    const response = await handleImages(imagesRequest({ prompt: "a circle" }), "generations", undefined, {
      dispatch: () => Promise.resolve(imageResponse("DDDD", { headers: upstreamHeaders })),
    });
    assert.equal(response.headers.get("Retry-After"), "17");
    assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
    assert.equal(response.headers.get("x-uos-warning"), "user_ignored");
    STANDARD_RATE_LIMIT_HEADERS.forEach((name, index) => {
      assert.equal(response.headers.get(name), `value-${index}`);
    });
    assert.equal(response.headers.get("x-not-forwarded"), null);
  });
});

test("fan-out image responses preserve a retry header only when every call agrees", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    let calls = 0;
    const response = await handleImages(imagesRequest({ prompt: "two circles", n: 2 }), "generations", undefined, {
      dispatch: () => {
        calls += 1;
        return Promise.resolve(
          imageResponse(`IMAGE_${calls}`, {
            headers:
              calls === 1
                ? {
                    "Retry-After": "17",
                    "RateLimit-Remaining": "9",
                    "x-uos-upstream": "chatgpt_codex",
                    "x-uos-warning": "user_ignored, shared_warning",
                  }
                : {
                    "Retry-After": "18",
                    "x-uos-upstream": "chatgpt_codex",
                    "x-uos-warning": "shared_warning, output_compression_ignored",
                  },
          })
        );
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Retry-After"), null);
    assert.equal(response.headers.get("RateLimit-Remaining"), null);
    assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
    assert.equal(response.headers.get("x-uos-warning"), "user_ignored, shared_warning, output_compression_ignored");
  });
});

test("upstream quota and roster errors pass through unchanged", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const dispatch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "quota exhausted", type: "invalid_request_error" } }), {
          status: 429,
          headers: { "Retry-After": "9", "x-uos-upstream": "chatgpt_codex" },
        })
      );
    const response = await handleImages(imagesRequest({ model: "gpt-image-2", prompt: "a circle" }), "generations", undefined, { dispatch });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "9");
    const body = (await response.json()) as { error?: { message?: string } };
    assert.equal(body.error?.message, "quota exhausted");
  });
});

test("a reply with no image is reported instead of returning an empty success", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    const dispatch = () => Promise.resolve(new Response(JSON.stringify({ output: [{ type: "message", content: [] }] }), { status: 200 }));
    const response = await handleImages(imagesRequest({ model: "gpt-image-2", prompt: "a circle" }), "generations", undefined, { dispatch });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "image_generation_failed");
  });
});

test("malformed image requests are rejected before any dispatch", async () => {
  await withBaseModel("gpt-5.6-sol", async () => {
    let dispatches = 0;
    const dispatch = () => {
      dispatches += 1;
      return Promise.resolve(imageResponse("EEEE"));
    };
    const cases: (readonly [Request, "generations" | "edits"])[] = [
      [imagesRequest({ model: "gpt-image-2" }), "generations"],
      [imagesRequest({ prompt: "   " }), "generations"],
      [imagesRequest({ prompt: "one", model: "" }), "generations"],
      [imagesRequest({ prompt: "one", model: 42 }), "generations"],
      [imagesRequest({ prompt: "one", n: 0 }), "generations"],
      [imagesRequest({ prompt: "one", n: 1.5 }), "generations"],
      [imagesRequest({ prompt: "one", n: 11 }), "generations"],
      [imagesRequest({ prompt: "one", n: "2" }), "generations"],
      [imagesRequest({ prompt: "one", output_compression: 50.5 }), "generations"],
      [imagesRequest({ prompt: "one", output_compression: 101 }), "generations"],
      [imagesRequest({ prompt: "one", output_compression: "50" }), "generations"],
      [imagesRequest({ prompt: `${"x".repeat(32_000)} ` }), "generations"],
      [imagesRequest({ prompt: "one", user: 42 }), "generations"],
      [imagesRequest({ prompt: "one", user: null }), "generations"],
      [imagesRequest({ prompt: "one", size: "" }), "generations"],
      [imagesRequest({ prompt: "one", size: 1024 }), "generations"],
      [imagesRequest({ prompt: "one", quality: "standard" }), "generations"],
      [imagesRequest({ prompt: "one", quality: "hd" }), "generations"],
      [imagesRequest({ prompt: "one", quality: "ultra" }), "generations"],
      [imagesRequest({ prompt: "one", background: "clear" }), "generations"],
      [imagesRequest({ prompt: "one", output_format: "gif" }), "generations"],
      [imagesRequest({ prompt: "one", moderation: "off" }), "generations"],
      [imagesRequest({ prompt: "one", response_format: "url" }), "generations"],
      [imagesRequest({ prompt: "one", style: "cinematic" }), "generations"],
      [imagesRequest({ prompt: "one", input_fidelity: "high" }), "generations"],
      [imagesRequest({ prompt: "one", input_fidelity: null }), "generations"],
      [imagesRequest({ prompt: "one", unknown_option: true }), "generations"],
      [imagesRequest({ prompt: "one", stream: true }), "generations"],
      [imagesRequest({ prompt: "one", stream: "true" }), "generations"],
      [imagesRequest({ prompt: "one", partial_images: 1 }), "generations"],
      [imagesRequest({ prompt: "edit", image: { image_url: "https://example.com/legacy.png" } }, "/v1/images/edits"), "edits"],
      [imagesRequest({ prompt: "edit", images: [] }, "/v1/images/edits"), "edits"],
      [
        imagesRequest(
          {
            prompt: "edit",
            images: [{ image_url: "https://example.com/a.png" }],
            quality: "hd",
          },
          "/v1/images/edits"
        ),
        "edits",
      ],
      [
        imagesRequest(
          {
            prompt: "edit",
            images: [{ image_url: "https://example.com/a.png" }],
            input_fidelity: "medium",
          },
          "/v1/images/edits"
        ),
        "edits",
      ],
      [
        imagesRequest(
          {
            prompt: "edit",
            images: [{ image_url: "https://example.com/a.png" }],
            response_format: null,
          },
          "/v1/images/edits"
        ),
        "edits",
      ],
      [imagesRequest({ prompt: "edit", images: [{ image_url: "", file_id: "" }] }, "/v1/images/edits"), "edits"],
      [imagesRequest({ prompt: "edit", images: [{ image_url: "", file_id: "file-a" }] }, "/v1/images/edits"), "edits"],
      [imagesRequest({ prompt: "edit", images: [{ image_url: "https://example.com/a.png", file_id: "file-a" }] }, "/v1/images/edits"), "edits"],
      [imagesRequest({ prompt: "edit", images: [{ file_id: "file-a", extra: true }] }, "/v1/images/edits"), "edits"],
      [imagesRequest({ prompt: "edit", images: [{ image_url: "https://example.com/source.png" }], mask: {} }, "/v1/images/edits"), "edits"],
      [
        imagesRequest(
          {
            prompt: "edit",
            images: [{ image_url: "https://example.com/source.png" }],
            mask: { image_url: "data:image/svg+xml;base64,PHN2Zz4=" },
          },
          "/v1/images/edits"
        ),
        "edits",
      ],
      [
        imagesRequest(
          {
            prompt: "edit",
            images: [{ image_url: "https://example.com/source.png" }],
            mask: { image_url: "data:image/png;base64,not-valid-base64" },
          },
          "/v1/images/edits"
        ),
        "edits",
      ],
    ];
    for (const [request, kind] of cases) {
      assert.equal((await handleImages(request, kind, undefined, { dispatch })).status, 400);
    }

    const mixedForm = new FormData();
    mixedForm.append("prompt", "edit");
    mixedForm.append("image", new File(["valid"], "valid.png", { type: "image/png" }));
    mixedForm.append("image", "not a file");
    assert.equal(
      (await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: mixedForm }), "edits", undefined, { dispatch })).status,
      400
    );

    const invalidNumberForm = new FormData();
    invalidNumberForm.append("prompt", "edit");
    invalidNumberForm.append("image", new File(["valid"], "valid.png", { type: "image/png" }));
    invalidNumberForm.append("n", "1e1");
    assert.equal(
      (await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: invalidNumberForm }), "edits", undefined, { dispatch }))
        .status,
      400
    );

    const fractionalCompressionForm = new FormData();
    fractionalCompressionForm.append("prompt", "edit");
    fractionalCompressionForm.append("image", new File(["valid"], "valid.png", { type: "image/png" }));
    fractionalCompressionForm.append("output_compression", "50.5");
    const fractionalCompressionResponse = await handleImages(
      new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: fractionalCompressionForm }),
      "edits",
      undefined,
      { dispatch }
    );
    assert.equal(fractionalCompressionResponse.status, 400);
    assert.equal((await fractionalCompressionResponse.json()).error?.param, "output_compression");

    const streamingForm = new FormData();
    streamingForm.append("prompt", "edit");
    streamingForm.append("image", new File(["valid"], "valid.png", { type: "image/png" }));
    streamingForm.append("stream", "true");
    assert.equal(
      (await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: streamingForm }), "edits", undefined, { dispatch })).status,
      400
    );

    const invalidResponseFormat = new FormData();
    invalidResponseFormat.append("prompt", "edit");
    invalidResponseFormat.append("image", new File(["valid"], "valid.png", { type: "image/png" }));
    invalidResponseFormat.append("response_format", "url");
    assert.equal(
      (await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: invalidResponseFormat }), "edits", undefined, { dispatch }))
        .status,
      400
    );

    const unknownMultipartField = new FormData();
    unknownMultipartField.append("prompt", "edit");
    unknownMultipartField.append("image", new File(["valid"], "valid.png", { type: "image/png" }));
    unknownMultipartField.append("unknown_option", "customer-1");
    assert.equal(
      (await handleImages(new Request("http://127.0.0.1/v1/images/edits", { method: "POST", body: unknownMultipartField }), "edits", undefined, { dispatch }))
        .status,
      400
    );

    const notJson = new Request("http://127.0.0.1/v1/images/generations", { method: "POST", body: "not json" });
    assert.equal((await handleImages(notJson, "generations", undefined, { dispatch })).status, 400);
    assert.equal(dispatches, 0);
  });
});
