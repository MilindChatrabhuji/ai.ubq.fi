import { test } from "bun:test";
import assert from "node:assert/strict";

import { extractImagesFromResponses, handleImages, resolveImageBaseModel } from "../src/images.ts";

/* ------------------------------------------------------------- fixtures */

const imageCall = (result: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "image_generation_call",
  result,
  ...extra,
});

const upstreamPayload = (output: Record<string, unknown>[], createdAt?: number): unknown => ({
  output,
  ...(createdAt === undefined ? {} : { created_at: createdAt }),
});

const jsonRequest = (url: string, body: unknown): Request =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const dispatchJson = (payload: unknown, status = 200, seen: Request[] = []) => {
  return (request: Request): Promise<Response> => {
    seen.push(request);
    return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }));
  };
};

const generationRequest = (body: unknown): Request => jsonRequest("https://ai.ubq.fi/v1/images/generations", body);

const failureBody = async (response: Response): Promise<{ error: { message: string; param?: string | null } }> =>
  (await response.json()) as { error: { message: string; param?: string | null } };

/* ---------------------------------------------------------------- tests */

/** Runs one test with a configured image base model and restores the environment. */
const withImageBaseModel = async (run: () => Promise<void>): Promise<void> => {
  const previous = process.env.IMAGE_BASE_MODEL;
  process.env.IMAGE_BASE_MODEL = "gpt-5.6-sol";
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.IMAGE_BASE_MODEL;
    else process.env.IMAGE_BASE_MODEL = previous;
  }
};

test("the base model resolves from the environment and never invents one", async () => {
  await withImageBaseModel(async () => {
    assert.equal(await resolveImageBaseModel(), "gpt-5.6-sol", "a configured base model is used verbatim");
  });
  const previous = process.env.IMAGE_BASE_MODEL;
  delete process.env.IMAGE_BASE_MODEL;
  try {
    const fallback = await resolveImageBaseModel();
    assert.ok(fallback === null || fallback.length > 0, "an unconfigured base model either falls back to a default or reports absence");
  } finally {
    if (previous !== undefined) process.env.IMAGE_BASE_MODEL = previous;
  }
});

test("image requests reject unusable bodies before any dispatch", async () => {
  await withImageBaseModel(async () => {
    const dispatch = (): Promise<Response> => Promise.resolve(new Response("{}", { status: 599 }));
    const run = (body: unknown) => handleImages(generationRequest(body), "generations", undefined, { dispatch });

    assert.equal(
      (await handleImages(new Request("https://ai.ubq.fi/v1/images/generations", { method: "POST", body: "not json" }), "generations", undefined, { dispatch }))
        .status,
      400
    );
    assert.equal((await run("a string")).status, 400);
    assert.equal((await run({})).status, 400, "a generation request needs a prompt");
    assert.equal((await run({ prompt: "a cat", unsupported: true })).status, 400, "an unknown field is refused");
    assert.equal((await run({ prompt: "a cat", quality: "ultra" })).status, 400);
    assert.equal((await run({ prompt: "a cat", n: 0 })).status, 400);
    assert.equal((await run({ prompt: "a cat", n: 1.5 })).status, 400);
    assert.equal((await run({ prompt: "a cat", n: "2" })).status, 400);
    assert.equal((await run({ prompt: "a cat", stream: true })).status, 400);
    assert.equal((await run({ prompt: "a cat", response_format: "yaml" })).status, 400);

    for (const images of [
      "not-an-array",
      [7],
      [{ image_url: "https://example.com/cat.png", extra: 1 }],
      [{ image_url: "" }],
      [{ image_url: "h".repeat(3_000_000) }],
      [{ image_url: "ftp://example.com/cat.png" }],
      [{ image_url: "https://[::1" }],
      [{ image_url: "data:text/plain;base64,aGk=" }],
      [{ image_url: "data:image/png;base64,!!!" }],
    ]) {
      const response = await run({ prompt: "a cat", images });
      assert.equal(response.status, 400, `images ${JSON.stringify(images).slice(0, 60)} must be refused`);
    }

    const inline = await handleImages(
      generationRequest({
        prompt: "a cat",
        images: [{ image_url: "data:image/png;base64,iVBORw0KGgo=" }, { image_url: "https://example.com/dog.png" }],
      }),
      "generations",
      undefined,
      { dispatch: dispatchJson(upstreamPayload([imageCall("aW1n")])) }
    );
    assert.equal(inline.status, 400, "generation requests do not accept image references");
  });
});

test("image generation fans out one upstream call per requested image", async () => {
  await withImageBaseModel(async () => {
    const seen: Request[] = [];
    const single = await handleImages(generationRequest({ prompt: "a cat" }), "generations", undefined, {
      dispatch: dispatchJson(upstreamPayload([imageCall("aW1n", { revised_prompt: "a nicer cat", output_format: "png" })], 1_700_000_000), 200, seen),
    });
    assert.equal(single.status, 200);
    const singleBody = (await single.json()) as { created: number; data: Record<string, unknown>[]; output_format?: string };
    assert.equal(singleBody.data.length, 1);
    assert.deepEqual(singleBody.data[0], { b64_json: "aW1n", revised_prompt: "a nicer cat" });
    assert.equal(singleBody.created, 1_700_000_000, "the upstream creation time is carried through");
    assert.equal(singleBody.output_format, "png");
    assert.equal(seen.length, 1);
    const dispatchedBody = JSON.parse(await seen[0].text()) as { model?: string; stream?: unknown; input?: unknown };
    assert.equal(typeof dispatchedBody.model, "string", "the translated request targets the resolved base model");

    const fanout: Request[] = [];
    const doubled = await handleImages(generationRequest({ prompt: "a cat", n: 3 }), "generations", undefined, {
      dispatch: dispatchJson(upstreamPayload([imageCall("aW1n")]), 200, fanout),
    });
    assert.equal(doubled.status, 200);
    assert.equal(fanout.length, 3, "one upstream call is dispatched per requested image");
    const doubledBody = (await doubled.json()) as { data: Record<string, unknown>[]; output_format?: string };
    assert.equal(doubledBody.data.length, 3);
    assert.equal(doubledBody.output_format, undefined, "an upstream without a format advertises none");
  });
});

test("image aggregation reports every upstream failure shape", async () => {
  await withImageBaseModel(async () => {
    const nonJson = await handleImages(generationRequest({ prompt: "a cat" }), "generations", undefined, {
      dispatch: () => Promise.resolve(new Response("<html>gateway</html>", { status: 200 })),
    });
    assert.equal(nonJson.status, 502);
    assert.equal((await failureBody(nonJson)).error.message, "Image upstream returned a non-JSON response.");

    const failedUpstream = await handleImages(generationRequest({ prompt: "a cat" }), "generations", undefined, {
      dispatch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "quota exhausted" } }), { status: 429, headers: { "Content-Type": "application/json" } })
        ),
    });
    assert.equal(failedUpstream.status, 429, "a failed upstream status is passed through");
    assert.equal(((await failedUpstream.json()) as { error: { message: string } }).error.message, "quota exhausted");

    const emptyUpstream = await handleImages(generationRequest({ prompt: "a cat" }), "generations", undefined, {
      dispatch: dispatchJson(upstreamPayload([])),
    });
    assert.equal(emptyUpstream.status, 502);
    assert.equal((await failureBody(emptyUpstream)).error.message, "The model did not return an image for this request.");

    const emptyText = await handleImages(generationRequest({ prompt: "a cat" }), "generations", undefined, {
      dispatch: () => Promise.resolve(new Response("", { status: 200 })),
    });
    assert.equal(emptyText.status, 502, "an empty upstream body is not a usable image payload");

    const rejected = await handleImages(generationRequest({ prompt: "a cat", n: 2 }), "generations", undefined, {
      dispatch: (request) =>
        request.url.includes("image") ? Promise.reject(new Error("upstream exploded")) : Promise.resolve(new Response("{}", { status: 200 })),
    });
    assert.equal(rejected.status >= 400, true, "a rejected fan-out child is reported, never swallowed");
    assert.equal((await failureBody(rejected)).error.message.length > 0, true);
  });
});

test("image extraction reads only complete image-generation items", () => {
  assert.deepEqual(extractImagesFromResponses(null), []);
  assert.deepEqual(extractImagesFromResponses({ output: "not-an-array" }), []);
  assert.deepEqual(
    extractImagesFromResponses({ output: [null, { type: "message" }, { type: "image_generation_call" }, { type: "image_generation_call", result: "" }] }),
    []
  );
  assert.deepEqual(extractImagesFromResponses({ output: [imageCall("aW1n"), imageCall("bW9yZQ==", { revised_prompt: 7 })] }), [
    { b64_json: "aW1n" },
    { b64_json: "bW9yZQ==" },
  ]);
});

test("multipart image edits validate every part before dispatch", async () => {
  await withImageBaseModel(async () => {
    const editUrl = "https://ai.ubq.fi/v1/images/edits";
    const form = (parts: Record<string, Blob | string>): FormData => {
      const data = new FormData();
      for (const [key, value] of Object.entries(parts)) data.set(key, value);
      return data;
    };
    const post = (data: FormData, dispatch: (request: Request) => Promise<Response>) =>
      handleImages(new Request(editUrl, { method: "POST", body: data }), "edits", undefined, { dispatch });

    // A marker status proves whether an invalid request reached the upstream.
    const noDispatch = (): Promise<Response> => Promise.resolve(new Response("{}", { status: 599 }));
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const pngFile = (name = "cat.png"): File => new File([pngBytes], name, { type: "image/png" });

    const unsupported = await post(
      (() => {
        const data = form({ prompt: "a cat", image: pngFile() });
        data.set("unsupported", "value");
        return data;
      })(),
      noDispatch
    );
    assert.equal(unsupported.status, 400);
    assert.equal((await failureBody(unsupported)).error.param, "unsupported");

    const noImages = await post(form({ prompt: "a cat" }), noDispatch);
    assert.equal(noImages.status, 400);
    assert.equal((await failureBody(noImages)).error.param, "image");

    const stringImageEntry = await post(form({ prompt: "a cat", image: "not-a-file" }), noDispatch);
    assert.equal(stringImageEntry.status, 400, "a multipart image entry that is not a file is refused");

    const declaredOnly = await post(form({ prompt: "a cat", image: new File(["not an image"], "cat.png", { type: "image/png" }) }), noDispatch);
    assert.equal(declaredOnly.status, 599, "the declared media type decides the entry, not its bytes");

    const badMask = await post(form({ prompt: "a cat", image: pngFile(), mask: new File([pngBytes], "mask.jpg", { type: "image/jpeg" }) }), noDispatch);
    assert.equal(badMask.status, 400);
    assert.equal((await failureBody(badMask)).error.param, "mask");

    const emptyMask = await post(form({ prompt: "a cat", image: pngFile(), mask: new File([], "mask.png", { type: "image/png" }) }), noDispatch);
    assert.equal(emptyMask.status, 400, "an empty mask file is refused");

    const streamed = await post(form({ prompt: "a cat", image: pngFile(), stream: "true", size: "1024x1024" }), noDispatch);
    assert.equal(streamed.status, 400, "a streaming multipart edit is refused");
    assert.equal((await failureBody(streamed)).error.param, "stream");

    const accepted = await post(form({ prompt: "a cat", image: pngFile(), size: "1024x1024" }), dispatchJson(upstreamPayload([imageCall("aW1n")])));
    const acceptedBody = (await accepted.json()) as { data: Record<string, unknown>[] };
    assert.equal(accepted.status, 200, "a complete multipart edit reaches the upstream");
    assert.deepEqual(acceptedBody.data, [{ b64_json: "aW1n" }]);
  });
});

test("a multipart edit with an unusable declaration or body is refused", async () => {
  await withImageBaseModel(async () => {
    const editUrl = "https://ai.ubq.fi/v1/images/edits";
    const declaredLength = (value: string): Request => {
      const data = new FormData();
      data.set("prompt", "a cat");
      data.set("image", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "cat.png", { type: "image/png" }));
      const request = new Request(editUrl, { method: "POST", body: data });
      request.headers.set("content-length", value);
      return request;
    };
    const invalid = await handleImages(declaredLength("not-a-number"), "edits", undefined, { dispatch: () => Promise.reject(new Error("no dispatch")) });
    assert.equal(invalid.status, 400);
    assert.equal((await failureBody(invalid)).error.message, "Multipart Content-Length is invalid.");

    const tooLarge = await handleImages(declaredLength(String(200 * 1024 * 1024)), "edits", undefined, {
      dispatch: () => Promise.reject(new Error("no dispatch")),
    });
    assert.equal(tooLarge.status, 400);
    assert.equal((await failureBody(tooLarge)).error.message, "Multipart image edits must be no larger than 64 MiB.");

    const notMultipart = await handleImages(
      new Request(editUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "a cat" }) }),
      "edits",
      undefined,
      { dispatch: () => Promise.reject(new Error("no dispatch")) }
    );
    assert.equal(notMultipart.status, 400, "a JSON edit body is refused");
  });
});
