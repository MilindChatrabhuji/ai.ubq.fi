// OpenAI-compatible image endpoints, extracted from src/openai.ts.

import { type ApiKeyProviderDispatch } from "./api-key-policy.ts";
import { readBoundedResponseBody } from "./bounded-response-body.ts";
import { json, openaiError, STANDARD_RATE_LIMIT_HEADERS } from "./http.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "./inference-deadline.ts";
import { aggregateResponseTelemetry, responseTelemetry, type ResponseTelemetryState, type UsageContext, type UsageTokens } from "./openai-telemetry.ts";
import { bytesToBase64 } from "./utils.ts";
import { findUnknownKey, getDefaultModel } from "./openai.ts";
import { runResponsesHandler } from "./responses-handler.ts";
import { responseWarnings, UOS_WARNING_HEADER } from "./request-policy.ts";
import { captureRawBodyOnce, discardRawBodyObserverOnce, readJsonBody } from "./request.ts";

/**
 * OpenAI-compatible image endpoints.
 *
 * ChatGPT/Codex has no native image endpoint. It exposes image generation as
 * an `image_generation` tool on the Responses API, so an images request is
 * rewritten into a tool-bearing Responses call. A live Codex subscription is
 * the only enabled transport until paid providers have image-specific model
 * authorization, pricing, and settlement.
 */

const IMAGE_BASE_MODEL_ENV = "IMAGE_BASE_MODEL";
const IMAGE_TOOL_TYPE = "image_generation";
const IMAGE_EDIT_DEFAULT_MODEL = "gpt-image-1.5";
const IMAGE_MAX_COUNT = 10;
const IMAGE_MAX_EDIT_INPUTS = 16;
const IMAGE_MAX_PROMPT_CHARS = 32_000;
const IMAGE_MAX_REFERENCE_URL_CHARS = 20_971_520;
const IMAGE_MAX_FILE_BYTES = 50 * 1_024 * 1_024;
const IMAGE_MAX_MASK_FILE_BYTES = IMAGE_MAX_FILE_BYTES;
const IMAGE_MAX_MULTIPART_INPUT_BYTES = 50 * 1_024 * 1_024;
const IMAGE_MAX_MULTIPART_BODY_BYTES = 64 * 1_024 * 1_024;
const IMAGE_MAX_FANOUT_INPUT_BYTES = 50 * 1_024 * 1_024;
const IMAGE_MAX_JSON_BODY_BYTES = Math.ceil(IMAGE_MAX_FANOUT_INPUT_BYTES / 3) * 4 + 1_024 * 1_024;
const IMAGE_MEDIA_TYPE_BY_EXTENSION = new Map([
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const IMAGE_MEDIA_TYPE_ALIASES = new Map([
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/png", "image/png"],
  ["image/webp", "image/webp"],
  ["image/x-png", "image/png"],
]);
const IMAGE_NULLABLE_OPTION_KEYS = [
  "model",
  "n",
  "size",
  "quality",
  "background",
  "output_format",
  "output_compression",
  "input_fidelity",
  "moderation",
  "response_format",
  "stream",
  "partial_images",
  "style",
] as const;
const IMAGE_GENERATION_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const IMAGE_EDIT_JSON_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const IMAGE_EDIT_MULTIPART_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const IMAGE_BACKGROUNDS = new Set(["transparent", "opaque", "auto"]);
const IMAGE_OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const IMAGE_MODERATION_LEVELS = new Set(["low", "auto"]);
const IMAGE_INPUT_FIDELITIES = new Set(["low", "high"]);
const IMAGE_TEXT_ENCODER = new TextEncoder();

// Internal test seam for image translation tests. It avoids requiring the
// test runner to grant environment access for a deployment-only override.
let imageBaseModelForTest: string | null = null;

export const setImageBaseModelForTest = (model: string | null): void => {
  imageBaseModelForTest = model;
};

const IMAGE_SHARED_REQUEST_KEYS = [
  "model",
  "prompt",
  "n",
  "size",
  "quality",
  "background",
  "output_format",
  "output_compression",
  "stream",
  "partial_images",
  "user",
] as const;
const IMAGE_GENERATION_REQUEST_KEYS = new Set<string>([...IMAGE_SHARED_REQUEST_KEYS, "moderation", "response_format", "style"]);
const IMAGE_EDIT_JSON_REQUEST_KEYS = new Set<string>([...IMAGE_SHARED_REQUEST_KEYS, "images", "mask", "input_fidelity", "moderation"]);
const IMAGE_EDIT_MULTIPART_REQUEST_KEYS = new Set<string>([...IMAGE_SHARED_REQUEST_KEYS, "image", "image[]", "mask", "input_fidelity", "response_format"]);

export type ImageRouteKind = "generations" | "edits";

type ImageRequestFailure = Readonly<{ ok: false; response: Response }>;
type ParsedImageRequest = Readonly<{ ok: true; body: Record<string, unknown>; count: number; inputBytes: number }> | ImageRequestFailure;

type ImageHandlerOptions = Readonly<{
  dispatch?: (request: Request) => Promise<Response>;
}>;

/** Resolve the text model that hosts the image tool. */
export const resolveImageBaseModel = async (): Promise<string | null> => {
  if (imageBaseModelForTest !== null) return imageBaseModelForTest;
  let configured: string | null;
  try {
    const raw = process.env[IMAGE_BASE_MODEL_ENV]?.trim();
    configured = raw && raw.length > 0 ? raw : null;
  } catch {
    configured = null;
  }
  return configured ?? (await getDefaultModel());
};
/**
 * Rewrite an OpenAI Images request as a Responses request carrying the
 * image_generation tool. Its optional model field selects the requested image
 * model, while the outer Responses model remains the text model that hosts the
 * tool.
 */
export const buildImageResponsesRequest = (body: Record<string, unknown>, baseModel: string, kind: ImageRouteKind): Record<string, unknown> => {
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const user = typeof body.user === "string" ? { user: body.user } : {};
  const tool: Record<string, unknown> = {
    type: IMAGE_TOOL_TYPE,
    action: kind === "edits" ? "edit" : "generate",
  };
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  if (requestedModel) tool.model = requestedModel;
  else if (kind === "edits") tool.model = IMAGE_EDIT_DEFAULT_MODEL;
  const toolOptionKeys = ["size", "quality", "background", "output_format", "output_compression", "moderation"];
  for (const key of toolOptionKeys.filter((key) => body[key] !== undefined)) tool[key] = body[key];
  if (kind === "edits") {
    // Edits supply source images; the Responses input carries them alongside
    // the instruction so the tool can operate on the provided pixels.
    const images = Array.isArray(body.images) ? body.images : [];
    if (body.input_fidelity !== undefined) tool.input_fidelity = body.input_fidelity;
    if (isPlainRecord(body.mask)) tool.input_image_mask = body.mask;
    return {
      model: baseModel,
      ...user,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            ...images.flatMap((entry): Record<string, unknown>[] => {
              if (!isPlainRecord(entry)) return [];
              if (typeof entry.image_url === "string") {
                return [{ type: "input_image", image_url: entry.image_url }];
              }
              return [];
            }),
          ],
        },
      ],
      tools: [tool],
      tool_choice: { type: IMAGE_TOOL_TYPE },
    };
  }
  return {
    model: baseModel,
    ...user,
    input: prompt,
    tools: [tool],
    tool_choice: { type: IMAGE_TOOL_TYPE },
  };
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const imageRequestError = (message: string, param: string | null = null): ImageRequestFailure => ({
  ok: false,
  response: openaiError(400, message, "invalid_request_error", { param }),
});

const normalizeImageReference = (value: unknown): Record<string, string> | null => {
  if (!isPlainRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== "image_url")) return null;
  if (
    !Object.prototype.hasOwnProperty.call(value, "image_url") ||
    typeof value.image_url !== "string" ||
    value.image_url.length > IMAGE_MAX_REFERENCE_URL_CHARS
  ) {
    return null;
  }
  const imageUrl = typeof value.image_url === "string" ? value.image_url.trim() : "";
  if (!imageUrl) return null;
  if (!/^data:/iu.test(imageUrl)) {
    if (!/^https?:\/\//iu.test(imageUrl)) return null;
    try {
      const remoteUrl = new URL(imageUrl);
      return remoteUrl.protocol === "http:" || remoteUrl.protocol === "https:" ? { image_url: imageUrl } : null;
    } catch {
      return null;
    }
  }
  const inlineData = normalizeImageDataUrl(imageUrl);
  return inlineData ? { image_url: inlineData.url } : null;
};

const normalizeImageMaskReference = (value: unknown): Record<string, string> | null => {
  const reference = normalizeImageReference(value);
  if (!reference) return null;
  const inlineData = normalizeImageDataUrl(reference.image_url);
  return inlineData?.mediaType === "image/png" && inlineData.bytes < IMAGE_MAX_MASK_FILE_BYTES ? { image_url: inlineData.url } : null;
};

const normalizeImageMediaType = (value: string): string | null => {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return IMAGE_MEDIA_TYPE_ALIASES.get(mediaType) ?? null;
};

const normalizeImageDataUrl = (value: string): Readonly<{ url: string; bytes: number; mediaType: string }> | null => {
  const match = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/iu.exec(value);
  if (!match) return null;
  const mediaType = normalizeImageMediaType(match[1]);
  const encoded = match[2];
  if (!mediaType || encoded.length === 0 || encoded.length % 4 !== 0) return null;
  let padding = 0;
  if (encoded.endsWith("==")) padding = 2;
  else if (encoded.endsWith("=")) padding = 1;
  const bytes = (encoded.length / 4) * 3 - padding;
  if (bytes <= 0 || bytes >= IMAGE_MAX_FILE_BYTES) return null;
  return { url: `data:${mediaType};base64,${encoded}`, bytes, mediaType };
};

const imageReferenceInputBytes = (body: Record<string, unknown>): number => {
  const references = [...(Array.isArray(body.images) ? body.images : []), ...(isPlainRecord(body.mask) ? [body.mask] : [])];
  let total = 0;
  for (const reference of references) {
    if (!isPlainRecord(reference)) continue;
    if (typeof reference.image_url === "string") {
      const inlineData = normalizeImageDataUrl(reference.image_url);
      total += inlineData?.bytes ?? IMAGE_TEXT_ENCODER.encode(reference.image_url).byteLength;
    }
  }
  return total;
};

const imageFileMediaType = (file: File): string | null => {
  const declared = file.type.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") return normalizeImageMediaType(declared);
  const normalizedName = file.name.trim().toLowerCase();
  for (const [extension, mediaType] of IMAGE_MEDIA_TYPE_BY_EXTENSION) {
    if (normalizedName.endsWith(extension)) return mediaType;
  }
  return null;
};

const fileDataUrl = async (file: File, mediaType: string): Promise<string> => {
  const encoded = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  return `data:${mediaType};base64,${encoded}`;
};

const parseMultipartInteger = (value: FormDataEntryValue | null): unknown => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return /^(?:0|[1-9]\d*)$/u.test(normalized) ? Number(normalized) : value;
};

const parseMultipartNumber = (value: FormDataEntryValue | null): unknown => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(normalized)) return value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : value;
};

const exceedsUnicodeCodePointLimit = (value: string, limit: number): boolean => {
  const codePoints = value[Symbol.iterator]();
  let count = 0;
  while (!codePoints.next().done) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
};

const parseMultipartBoolean = (value: FormDataEntryValue | null): unknown => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return value;
};

type ImageScalarValidationResult = Readonly<{ ok: true; count: number }> | ImageRequestFailure;

const imageEnumOptionError = (raw: Record<string, unknown>, key: string, allowed: ReadonlySet<string>, message: string): ImageRequestFailure | null => {
  const value = raw[key];
  if (value === undefined) return null;
  if (typeof value === "string" && allowed.has(value)) return null;
  return imageRequestError(message, key);
};

const imageScalarIdentityFailure = (raw: Record<string, unknown>): ImageRequestFailure | null => {
  if (Object.prototype.hasOwnProperty.call(raw, "style")) {
    return imageRequestError("style is not supported because this gateway uses the Responses image-generation tool.", "style");
  }
  if (typeof raw.prompt !== "string" || raw.prompt.trim().length === 0) {
    return imageRequestError("Image requests must include a prompt.", "prompt");
  }
  if (exceedsUnicodeCodePointLimit(raw.prompt, IMAGE_MAX_PROMPT_CHARS)) {
    return imageRequestError(`prompt must contain no more than ${IMAGE_MAX_PROMPT_CHARS} characters.`, "prompt");
  }
  if (Object.prototype.hasOwnProperty.call(raw, "model") && (typeof raw.model !== "string" || raw.model.trim().length === 0)) {
    return imageRequestError("model must be a non-empty string.", "model");
  }
  if (raw.user !== undefined && typeof raw.user !== "string") {
    return imageRequestError("user must be a string.", "user");
  }
  return null;
};

const imageScalarPrecisionFailure = (raw: Record<string, unknown>): ImageRequestFailure | null => {
  if (
    raw.output_compression !== undefined &&
    (!Number.isInteger(raw.output_compression) || (raw.output_compression as number) < 0 || (raw.output_compression as number) > 100)
  ) {
    return imageRequestError("output_compression must be an integer from 0 to 100.", "output_compression");
  }
  if (raw.size !== undefined && (typeof raw.size !== "string" || raw.size.trim().length === 0)) {
    return imageRequestError("size must be a non-empty string.", "size");
  }
  return null;
};

const imageEditQualities = (multipart: boolean): ReadonlySet<string> => (multipart ? IMAGE_EDIT_MULTIPART_QUALITIES : IMAGE_EDIT_JSON_QUALITIES);

const imageQualities = (kind: ImageRouteKind, multipart: boolean): ReadonlySet<string> =>
  kind === "generations" ? IMAGE_GENERATION_QUALITIES : imageEditQualities(multipart);

const imageScalarEnumerationFailure = (raw: Record<string, unknown>, kind: ImageRouteKind, multipart: boolean): ImageRequestFailure | null => {
  const qualities = imageQualities(kind, multipart);
  const qualityFailure = imageEnumOptionError(
    raw,
    "quality",
    qualities,
    `quality must be low, medium, high, or auto${kind === "edits" ? " for image edits" : ""}.`
  );
  if (qualityFailure) return qualityFailure;
  const backgroundFailure = imageEnumOptionError(raw, "background", IMAGE_BACKGROUNDS, "background must be transparent, opaque, or auto.");
  if (backgroundFailure) return backgroundFailure;
  const outputFormatFailure = imageEnumOptionError(raw, "output_format", IMAGE_OUTPUT_FORMATS, "output_format must be png, jpeg, or webp.");
  if (outputFormatFailure) return outputFormatFailure;
  const moderationFailure = imageEnumOptionError(raw, "moderation", IMAGE_MODERATION_LEVELS, "moderation must be low or auto.");
  if (moderationFailure) return moderationFailure;
  return imageEnumOptionError(raw, "input_fidelity", IMAGE_INPUT_FIDELITIES, "input_fidelity must be low or high.");
};

const imageScalarStreamingFailure = (raw: Record<string, unknown>): ImageRequestFailure | null => {
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") {
    return imageRequestError("stream must be a boolean.", "stream");
  }
  if (raw.stream === true || raw.partial_images !== undefined) {
    return imageRequestError("Streaming image responses are not supported by this gateway.", raw.stream === true ? "stream" : "partial_images");
  }
  if (raw.response_format !== undefined && raw.response_format !== "b64_json") {
    return imageRequestError("response_format must be b64_json.", "response_format");
  }
  return null;
};

const validateImageScalarOptions = (raw: Record<string, unknown>, kind: ImageRouteKind, multipart = false): ImageScalarValidationResult => {
  const identityFailure = imageScalarIdentityFailure(raw);
  if (identityFailure) return identityFailure;
  const count = raw.n === undefined ? 1 : raw.n;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > IMAGE_MAX_COUNT) {
    return imageRequestError(`n must be an integer from 1 to ${IMAGE_MAX_COUNT}.`, "n");
  }
  const precisionFailure = imageScalarPrecisionFailure(raw);
  if (precisionFailure) return precisionFailure;
  const enumerationFailure = imageScalarEnumerationFailure(raw, kind, multipart);
  if (enumerationFailure) return enumerationFailure;
  const streamingFailure = imageScalarStreamingFailure(raw);
  if (streamingFailure) return streamingFailure;
  return { ok: true, count: count as number };
};

type MultipartImageEditResult = Readonly<{ ok: true; body: Record<string, unknown>; inputBytes: number }> | ImageRequestFailure;

const withoutNullImageOptions = (raw: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(raw).filter(([key, value]) => value !== null || !IMAGE_NULLABLE_OPTION_KEYS.some((option) => option === key)));

const rejectInvalidImageEditContentLength = async (req: Request, declaredLength: string): Promise<ImageRequestFailure | null> => {
  const normalizedLength = declaredLength.trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(normalizedLength)) {
    discardRawBodyObserverOnce(req);
    return imageRequestError("Multipart Content-Length is invalid.");
  }
  const parsedLength = Number(normalizedLength);
  if (!Number.isSafeInteger(parsedLength) || parsedLength > IMAGE_MAX_MULTIPART_BODY_BYTES) {
    discardRawBodyObserverOnce(req);
    await req.body?.cancel().catch(() => {});
    return imageRequestError("Multipart image edits must be no larger than 64 MiB.", "image");
  }
  return null;
};

const readImageEditMultipartForm = async (req: Request, bytes: Uint8Array<ArrayBuffer>): Promise<FormData | null> => {
  try {
    return await new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: bytes,
    }).formData();
  } catch {
    return null;
  }
};

const collectImageEditFields = (form: FormData, body: Record<string, unknown>): ImageRequestFailure | null => {
  const unsupportedField = [...form.keys()].find((key) => !IMAGE_EDIT_MULTIPART_REQUEST_KEYS.has(key));
  if (unsupportedField) {
    return imageRequestError(`Unsupported image edit field: ${unsupportedField}.`, unsupportedField);
  }
  for (const key of ["model", "prompt", "size", "quality", "background", "output_format", "input_fidelity", "response_format", "user"]) {
    const value = form.get(key);
    if (value !== null && typeof value !== "string") {
      return imageRequestError(`${key} must be a string.`, key);
    }
    if (typeof value === "string") body[key] = value;
  }
  const stream = form.get("stream");
  if (stream !== null) body.stream = parseMultipartBoolean(stream);
  for (const key of ["n", "partial_images"]) {
    const value = form.get(key);
    if (value !== null) body[key] = parseMultipartInteger(value);
  }
  const outputCompression = form.get("output_compression");
  if (outputCompression !== null) body.output_compression = parseMultipartNumber(outputCompression);
  return null;
};

const selectImageEditFiles = (form: FormData): Readonly<{ ok: true; imageFiles: File[]; maskFile: File | null }> | ImageRequestFailure => {
  const imageEntries: unknown[] = [...form.entries()].flatMap(([name, entry]) => (name === "image" || name === "image[]" ? [entry] : []));
  const masks: unknown[] = form.getAll("mask");
  if (imageEntries.length === 0 || imageEntries.length > IMAGE_MAX_EDIT_INPUTS) {
    return imageRequestError(`image must contain from 1 to ${IMAGE_MAX_EDIT_INPUTS} files.`, "image");
  }
  if (imageEntries.some((entry) => !(entry instanceof File))) {
    return imageRequestError("Each multipart image entry must be a file.", "image");
  }
  if (masks.length > 1 || (masks.length === 1 && !(masks[0] instanceof File))) {
    return imageRequestError("mask must be one image file.", "mask");
  }
  return { ok: true, imageFiles: imageEntries as File[], maskFile: masks[0] instanceof File ? masks[0] : null };
};

const validateImageEditMask = (maskFile: File | null): Readonly<{ ok: true; mediaType: string | null }> | ImageRequestFailure => {
  if (maskFile === null) return { ok: true, mediaType: null };
  const mediaType = imageFileMediaType(maskFile);
  if (maskFile.size === 0 || maskFile.size >= IMAGE_MAX_MASK_FILE_BYTES || mediaType !== "image/png") {
    return imageRequestError("The multipart mask must be a non-empty PNG file smaller than 50 MiB.", "mask");
  }
  return { ok: true, mediaType };
};

const finalizeImageEditBody = async (form: FormData, body: Record<string, unknown>, count: number): Promise<MultipartImageEditResult> => {
  const selection = selectImageEditFiles(form);
  if (!selection.ok) return selection;
  const { imageFiles, maskFile } = selection;
  if (imageFiles.some((file) => file.size === 0 || file.size >= IMAGE_MAX_FILE_BYTES)) {
    return imageRequestError("Each multipart image file must be non-empty and smaller than 50 MiB.", "image");
  }
  const imageInputs = imageFiles.flatMap((file): { file: File; mediaType: string }[] => {
    const mediaType = imageFileMediaType(file);
    return mediaType === null ? [] : [{ file, mediaType }];
  });
  if (imageInputs.length !== imageFiles.length) {
    return imageRequestError("Each multipart image must be a PNG, JPEG, or WebP file.", "image");
  }
  const mask = validateImageEditMask(maskFile);
  if (!mask.ok) return mask;
  const maskMediaType = mask.mediaType;
  const files = maskFile ? [...imageFiles, maskFile] : imageFiles;
  const totalInputBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalInputBytes > IMAGE_MAX_MULTIPART_INPUT_BYTES) {
    return imageRequestError("Multipart image files must total no more than 50 MiB.", "image");
  }
  if (totalInputBytes > Math.floor(IMAGE_MAX_FANOUT_INPUT_BYTES / count)) {
    return imageRequestError("n and multipart image inputs exceed the 50 MiB request work limit.", "n");
  }
  const images: Record<string, string>[] = [];
  for (const { file, mediaType } of imageInputs) {
    images.push({ image_url: await fileDataUrl(file, mediaType) });
  }
  body.images = images;
  if (maskFile && maskMediaType !== null) {
    body.mask = {
      image_url: await fileDataUrl(maskFile, maskMediaType),
    };
  }
  return { ok: true, body, inputBytes: totalInputBytes };
};

const parseMultipartImageEdit = async (req: Request): Promise<MultipartImageEditResult> => {
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    const lengthFailure = await rejectInvalidImageEditContentLength(req, declaredLength);
    if (lengthFailure) return lengthFailure;
  }
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  let captured = false;
  try {
    const bounded = await readBoundedResponseBody(new Response(req.body), {
      maxBytes: IMAGE_MAX_MULTIPART_BODY_BYTES + 1,
      timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
      signal: req.signal,
      cancellationReason: "Multipart image request exceeded its read limit",
    });
    bytes = bounded.bytes;
    if (!bounded.complete || bytes.byteLength > IMAGE_MAX_MULTIPART_BODY_BYTES) {
      return imageRequestError("Multipart image edits must be no larger than 64 MiB.", "image");
    }
    const form = await readImageEditMultipartForm(req, bytes);
    if (!form) return imageRequestError("Image edits must include valid multipart form data.");
    captured = captureRawBodyOnce(req, bytes);
    const body: Record<string, unknown> = {};
    const fieldFailure = collectImageEditFields(form, body);
    if (fieldFailure) return fieldFailure;
    const sanitizedBody = withoutNullImageOptions(body);
    const scalarValidation = validateImageScalarOptions(sanitizedBody, "edits", true);
    if (!scalarValidation.ok) return scalarValidation;
    // GPT Image responses are always base64. The validated multipart
    // compatibility field has no Responses-tool equivalent.
    delete sanitizedBody.response_format;
    return await finalizeImageEditBody(form, sanitizedBody, scalarValidation.count);
  } finally {
    discardRawBodyObserverOnce(req);
    if (bytes && !captured) bytes.fill(0);
  }
};

const imageJsonAllowedKeys = (kind: ImageRouteKind): ReadonlySet<string> => (kind === "edits" ? IMAGE_EDIT_JSON_REQUEST_KEYS : IMAGE_GENERATION_REQUEST_KEYS);

const normalizeImageEditReferences = (body: Record<string, unknown>, isMultipart: boolean): ImageRequestFailure | null => {
  if (!Array.isArray(body.images) || body.images.length === 0 || body.images.length > IMAGE_MAX_EDIT_INPUTS) {
    return imageRequestError(`images must contain from 1 to ${IMAGE_MAX_EDIT_INPUTS} image references.`, "images");
  }
  if (isMultipart) return null;
  const images = body.images.map(normalizeImageReference);
  if (images.some((image) => image === null)) {
    return imageRequestError(
      "Each image must contain one image_url with a fully qualified HTTP(S) URL or supported base64 data URL; file_id is unsupported by this gateway.",
      "images"
    );
  }
  body.images = images;
  if (Object.prototype.hasOwnProperty.call(body, "mask")) {
    const mask = normalizeImageMaskReference(body.mask);
    if (!mask) {
      return imageRequestError("mask.image_url must be a supported base64 PNG data URL; remote URLs and file_id are unsupported by this gateway.", "mask");
    }
    body.mask = mask;
  }
  return null;
};

const finalizeImageRequest = (raw: unknown, kind: ImageRouteKind, multipartInputBytes: number, isMultipart: boolean): ParsedImageRequest => {
  if (!isPlainRecord(raw)) return imageRequestError("Image requests must use an object body.");
  const unsupportedField = findUnknownKey(raw, imageJsonAllowedKeys(kind));
  if (unsupportedField) {
    return imageRequestError(`Unsupported image ${kind} field: ${unsupportedField}.`, unsupportedField);
  }
  const body = withoutNullImageOptions(raw);
  const scalarValidation = validateImageScalarOptions(body, kind, isMultipart);
  if (!scalarValidation.ok) return scalarValidation;
  const { count } = scalarValidation;
  if (kind === "edits") {
    const referenceFailure = normalizeImageEditReferences(body, isMultipart);
    if (referenceFailure) return referenceFailure;
  }
  const inputBytes = Math.max(multipartInputBytes, imageReferenceInputBytes(body));
  if (inputBytes > Math.floor(IMAGE_MAX_FANOUT_INPUT_BYTES / count)) {
    return imageRequestError("n and inline image inputs exceed the 50 MiB request work limit.", "n");
  }
  return { ok: true, body, count, inputBytes };
};

const parseImageRequest = async (req: Request, kind: ImageRouteKind): Promise<ParsedImageRequest> => {
  const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (kind === "edits" && mediaType === "multipart/form-data") {
    const multipart = await parseMultipartImageEdit(req);
    if (!multipart.ok) return multipart;
    return finalizeImageRequest(multipart.body, kind, multipart.inputBytes, true);
  }
  const raw = await readJsonBody(req, kind === "edits" ? IMAGE_MAX_JSON_BODY_BYTES : undefined);
  if (raw === null) {
    return imageRequestError(
      kind === "edits" ? "Image edits must use a JSON object or multipart form-data body." : "Image generation requests must use a JSON object body."
    );
  }
  return finalizeImageRequest(raw, kind, 0, false);
};

const imageResponseHeaders = (responses: readonly Response[]): Record<string, string> => {
  const headers: Record<string, string> = {};
  const warnings = Array.from(new Set(responses.flatMap(responseWarnings)));
  if (warnings.length > 0) headers[UOS_WARNING_HEADER] = warnings.join(", ");
  for (const name of ["x-uos-upstream", "Retry-After", ...STANDARD_RATE_LIMIT_HEADERS]) {
    const values = responses.map((response) => response.headers.get(name));
    const first = values[0];
    if (values.length > 0 && first !== null && values.every((value) => value !== null && value === first)) {
      headers[name] = first;
    }
  }
  return headers;
};

type ImageFanoutDispatchCoordinator = Readonly<{
  beforeProviderDispatchFor: (callIndex: number) => NonNullable<UsageContext["beforeProviderDispatch"]>;
  cancelBeforeTransport: () => Promise<void>;
  settled: (callIndex: number) => void;
}>;

/**
 * One Images request can launch several Responses calls, while API-key
 * admission intentionally reserves one logical request. Keep that reservation
 * committed when any sibling reaches transport; otherwise a cancelled leader
 * could refund it after a follower has already started its upstream fetch.
 */
export const createImageFanoutDispatchCoordinator = (
  callCount: number,
  beforeProviderDispatch: NonNullable<UsageContext["beforeProviderDispatch"]>
): ImageFanoutDispatchCoordinator => {
  const settledCalls = new Set<number>();
  let transportStarted = false;
  let providerDispatch: ApiKeyProviderDispatch | null = null;
  let cancellation: Promise<void> | null = null;
  let resolveAllCallsSettled!: () => void;
  const allCallsSettled = new Promise<void>((resolve) => {
    resolveAllCallsSettled = resolve;
  });

  const settled = (callIndex: number): void => {
    if (settledCalls.has(callIndex)) return;
    settledCalls.add(callIndex);
    if (settledCalls.size === callCount) resolveAllCallsSettled();
  };
  const cancelBeforeTransport = async (): Promise<void> => {
    await allCallsSettled;
    if (transportStarted || !providerDispatch) return;
    cancellation ??= providerDispatch.cancelBeforeTransport();
    await cancellation;
  };

  return {
    beforeProviderDispatchFor: (callIndex) => async (provider) => {
      const dispatch = await beforeProviderDispatch(provider);
      if (dispatch && !providerDispatch) {
        providerDispatch = dispatch;
        if (transportStarted) providerDispatch.markTransportStarted();
      }
      return {
        markTransportStarted: () => {
          transportStarted = true;
          settled(callIndex);
          providerDispatch?.markTransportStarted();
        },
        cancelBeforeTransport: () => {
          settled(callIndex);
          // A child owns only its settlement signal. Waiting for every logical
          // child here deadlocks when a first-batch failure prevents a later
          // batch from starting. The outer Images handler owns the one shared
          // cancellation after it marks those unstarted calls settled.
          return Promise.resolve();
        },
      };
    },
    cancelBeforeTransport,
    settled,
  };
};

const imageCallUsageContext = (context: UsageContext | undefined, index: number, kind: ImageRouteKind): UsageContext | undefined => {
  if (!context) return undefined;
  const requestId = index === 0 || !context.requestId ? context.requestId : `${context.requestId}:image:${kind}:${index + 1}`;
  // The translated request targets a hidden text host model. Reusing its paid
  // roster would authorize and settle the requested image under the wrong
  // model, so image calls remain Codex-only until image billing is explicit.
  return {
    ...context,
    requestId,
    paidFallbackEnabled: false,
    onTerminalUsage: undefined,
  };
};

const usageTokensFromTelemetry = (state: ResponseTelemetryState): UsageTokens | null =>
  state.usageObserved
    ? {
        inputTokens: state.inputTokens,
        cachedInputTokens: state.cachedInputTokens,
        cacheWriteInputTokens: state.cacheWriteInputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.totalTokens,
        status: state.usageTelemetryStatus,
      }
    : null;

const finalizeImageResponse = (sources: readonly Response[], target: Response, context: UsageContext | undefined): Response => {
  const response = aggregateResponseTelemetry(sources, target);
  const aggregate = responseTelemetry.get(response);
  if (aggregate && context?.responseTelemetry && context.responseTelemetry !== aggregate) {
    Object.assign(context.responseTelemetry, aggregate);
    responseTelemetry.set(response, context.responseTelemetry);
  }
  if (aggregate && context?.onTerminalUsage) {
    try {
      context.onTerminalUsage(usageTokensFromTelemetry(aggregate), aggregate.completed);
    } catch {
      // Observability callbacks cannot alter the translated response.
    }
  }
  return response;
};

/**
 * Collect generated images from a Responses payload. The tool reports each
 * image as an `image_generation_call` output item whose `result` is base64.
 */
export const extractImagesFromResponses = (payload: unknown): Record<string, unknown>[] => {
  if (!isPlainRecord(payload) || !Array.isArray(payload.output)) return [];
  const images: Record<string, unknown>[] = [];
  for (const item of payload.output) {
    if (!isPlainRecord(item) || item.type !== "image_generation_call") continue;
    const result = typeof item.result === "string" ? item.result : "";
    if (!result) continue;
    const image: Record<string, unknown> = { b64_json: result };
    if (typeof item.revised_prompt === "string") image.revised_prompt = item.revised_prompt;
    images.push(image);
  }
  return images;
};

const extractImageOutputFormatFromResponses = (payload: unknown): string | null => {
  if (!isPlainRecord(payload) || !Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!isPlainRecord(item) || item.type !== "image_generation_call" || typeof item.result !== "string" || item.result.length === 0) continue;
    return typeof item.output_format === "string" && IMAGE_OUTPUT_FORMATS.has(item.output_format) ? item.output_format : null;
  }
  return null;
};

const createImageFanoutRuntime = (
  req: Request,
  kind: ImageRouteKind,
  usageContext: UsageContext | undefined,
  options: ImageHandlerOptions,
  responsesBody: Record<string, unknown>,
  serializedResponsesBody: string | null,
  count: number
) => {
  type ImageFanoutFailure = Readonly<{ kind: "response"; response: Response }> | Readonly<{ kind: "throw"; error: unknown }>;
  const fanoutDispatch =
    count > 1 && !options.dispatch && usageContext?.beforeProviderDispatch
      ? createImageFanoutDispatchCoordinator(count, usageContext.beforeProviderDispatch)
      : null;
  const fanoutAbort = count > 1 ? new AbortController() : null;
  const childSignal = fanoutAbort
    ? AbortSignal.any([req.signal, ...(usageContext?.downstreamSignal ? [usageContext.downstreamSignal] : []), fanoutAbort.signal])
    : req.signal;
  let firstFailure: ImageFanoutFailure | undefined;
  const recordFirstFailure = (failure: ImageFanoutFailure): void => {
    if (firstFailure !== undefined) return;
    // Abort listeners run synchronously, so preserve the temporal leader first.
    firstFailure = failure;
    fanoutAbort?.abort(new DOMException("A sibling image generation call failed.", "AbortError"));
  };
  const runChild = async (index: number): Promise<Response> => {
    // This is an internal JSON rewrite, not a proxy hop. In particular, an
    // outer Images Idempotency-Key cannot identify several independent child
    // generations, and client forwarding/authentication headers do not
    // describe the newly serialized request body.
    const headers = new Headers({ "content-type": "application/json" });
    const childContext = imageCallUsageContext(usageContext, index, kind);
    const coordinatedChildContext =
      childContext && (fanoutDispatch || fanoutAbort)
        ? {
            ...childContext,
            ...(fanoutAbort ? { downstreamSignal: childSignal } : {}),
            ...(fanoutDispatch ? { beforeProviderDispatch: fanoutDispatch.beforeProviderDispatchFor(index) } : {}),
          }
        : childContext;
    const request = new Request(new URL("/v1/responses", req.url), {
      method: "POST",
      headers,
      ...(serializedResponsesBody === null ? {} : { body: serializedResponsesBody }),
      signal: childSignal,
    });
    try {
      const upstream = options.dispatch ? await options.dispatch(request) : await runResponsesHandler(request, coordinatedChildContext, responsesBody);
      if (!upstream.ok) recordFirstFailure({ kind: "response", response: upstream });
      return upstream;
    } catch (error) {
      recordFirstFailure({ kind: "throw", error });
      throw error;
    } finally {
      fanoutDispatch?.settled(index);
    }
  };
  return {
    runChild,
    settled: (index: number): void => {
      fanoutDispatch?.settled(index);
    },
    cancelBeforeTransport: async (): Promise<void> => {
      await fanoutDispatch?.cancelBeforeTransport().catch(() => {});
    },
    failure: (): ImageFanoutFailure | undefined => firstFailure,
  };
};

const runImageFanoutUpstreams = async (count: number, runtime: ReturnType<typeof createImageFanoutRuntime>): Promise<Response[]> => {
  const settledUpstreams: PromiseSettledResult<Response>[] = [];
  const indexes = Array.from({ length: count }, (_, index) => index);
  settledUpstreams.push(...(await Promise.allSettled(indexes.map(runtime.runChild))));
  const nextChildIndex = count;
  // The shared paid-dispatch coordinator waits for every logical child. Mark
  // calls that never started after a sibling failure as settled before cancel.
  for (let index = nextChildIndex; index < count; index += 1) runtime.settled(index);
  const failure = runtime.failure();
  if (failure !== undefined) {
    await runtime.cancelBeforeTransport();
    if (failure.kind === "throw") throw failure.error;
  }
  const upstreams =
    failure?.kind === "response"
      ? settledUpstreams.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      : settledUpstreams.map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });
  if (failure?.kind === "response") {
    const leaderIndex = upstreams.indexOf(failure.response);
    if (leaderIndex > 0) upstreams.unshift(upstreams.splice(leaderIndex, 1)[0] as Response);
  }
  return upstreams;
};

const readImageUpstreamPayload = async (
  upstreams: readonly Response[],
  upstream: Response,
  usageContext: UsageContext | undefined
): Promise<Response | Readonly<{ payload: unknown }>> => {
  const text = await upstream.text();
  let payload: unknown = null;
  try {
    if (text.length > 0) payload = JSON.parse(text) as unknown;
  } catch {
    const response = openaiError(502, "Image upstream returned a non-JSON response.", "upstream_invalid", {
      headers: imageResponseHeaders([upstream]),
    });
    return finalizeImageResponse(upstreams, response, usageContext);
  }
  // A failed Responses call already carries an OpenAI-shaped error body;
  // pass it through unchanged so quota and roster errors stay actionable.
  if (!upstream.ok) {
    const response = json(upstream.status, payload, imageResponseHeaders([upstream]));
    return finalizeImageResponse(upstreams, response, usageContext);
  }
  return { payload };
};

const mergeImageCallMetadata = (calls: { outputFormat: string | null; outputFormatConsistent: boolean; created: number | null }, payload: unknown): void => {
  const callOutputFormat = extractImageOutputFormatFromResponses(payload);
  if (callOutputFormat === null) calls.outputFormatConsistent = false;
  else if (calls.outputFormat === null) calls.outputFormat = callOutputFormat;
  else if (calls.outputFormat !== callOutputFormat) calls.outputFormatConsistent = false;
  if (calls.created === null && isPlainRecord(payload) && typeof payload.created_at === "number") {
    calls.created = payload.created_at;
  }
};

const buildImageAggregateResponse = async (upstreams: readonly Response[], usageContext: UsageContext | undefined): Promise<Response> => {
  const images: Record<string, unknown>[] = [];
  const calls: { outputFormat: string | null; outputFormatConsistent: boolean; created: number | null } = {
    outputFormat: null,
    outputFormatConsistent: true,
    created: null,
  };
  for (const upstream of upstreams) {
    const result = await readImageUpstreamPayload(upstreams, upstream, usageContext);
    if (result instanceof Response) return result;
    const callImages = extractImagesFromResponses(result.payload);
    if (callImages.length === 0) {
      const response = openaiError(502, "The model did not return an image for this request.", "image_generation_failed", {
        headers: imageResponseHeaders(upstreams),
      });
      return finalizeImageResponse(upstreams, response, usageContext);
    }
    images.push(callImages[0]);
    mergeImageCallMetadata(calls, result.payload);
  }
  const created = calls.created ?? Math.floor(Date.now() / 1000);
  const response = json(
    200,
    {
      created,
      data: images,
      ...(calls.outputFormatConsistent && calls.outputFormat ? { output_format: calls.outputFormat } : {}),
    },
    imageResponseHeaders(upstreams)
  );
  return finalizeImageResponse(upstreams, response, usageContext);
};

export const handleImages = async (req: Request, kind: ImageRouteKind, usageContext?: UsageContext, options: ImageHandlerOptions = {}): Promise<Response> => {
  const parsed = await parseImageRequest(req, kind);
  if (!parsed.ok) return parsed.response;
  const { body, count } = parsed;

  const baseModel = await resolveImageBaseModel();
  if (!baseModel) {
    return openaiError(503, "No base model is available to host image generation.", "model_unavailable");
  }

  const responsesBody = buildImageResponsesRequest(body, baseModel, kind);
  const encodedResponsesBody = JSON.stringify(responsesBody);
  if (count > 1 && IMAGE_TEXT_ENCODER.encode(encodedResponsesBody).byteLength > Math.floor(IMAGE_MAX_JSON_BODY_BYTES / count)) {
    return imageRequestError("n and the translated image request exceed the fan-out work limit.", "n").response;
  }
  const serializedResponsesBody = options.dispatch ? encodedResponsesBody : null;
  const runtime = createImageFanoutRuntime(req, kind, usageContext, options, responsesBody, serializedResponsesBody, count);
  const upstreams = await runImageFanoutUpstreams(count, runtime);
  return buildImageAggregateResponse(upstreams, usageContext);
};
