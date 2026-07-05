import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { ImageReference } from "./image-references.js";
import type { ModelEntry } from "./models.js";
import { responseIdFromHeaders } from "./response-id.js";

export const LLMGATE_PREFIX = "llmgate/";
const DEFAULT_LLMGATE_BASE_URL = "https://llmgate.app/v1";
const LLMGATE_MODELS_URL = "https://llmgate.app/api/v1/public/models";

/** LLMGate API base URL (`LLMGATE_BASE_URL`), without a trailing slash. */
function baseUrl(): string {
  const url = process.env.LLMGATE_BASE_URL || DEFAULT_LLMGATE_BASE_URL;
  return url.replace(/\/+$/, "");
}

/** LLMGate model type codes from the public catalog. */
const MODEL_TYPE_TEXT = 1;
const MODEL_TYPE_IMAGE = 4;

/** True for model IDs the user routed through LLMGate, e.g. `llmgate/claude-opus-4-8`. */
export function isLlmgateModel(modelId: string): boolean {
  return modelId.startsWith(LLMGATE_PREFIX);
}

/** Strips the `llmgate/` sentinel to recover the real LLMGate model name. */
export function llmgateModelId(modelId: string): string {
  return modelId.slice(LLMGATE_PREFIX.length);
}

function requireApiKey(): string {
  const key = process.env.LLMGATE_API_KEY;
  if (!key) {
    throw new Error(
      "LLMGATE_API_KEY is required for llmgate/ models (set it to your LLMGate API key)"
    );
  }
  return key;
}

/** LLMGate chat model as an AI SDK LanguageModel (OpenAI-compatible `/chat/completions`). */
export function llmgateTextModel(modelId: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: "llmgate",
    baseURL: baseUrl(),
    apiKey: requireApiKey(),
  });
  return provider.chatModel(llmgateModelId(modelId));
}

export interface LlmgateImageParams {
  prompt: string;
  size?: `${number}x${number}`;
  references?: ImageReference[];
  signal?: AbortSignal;
}

interface LlmgateImageResponse {
  data?: { b64_json?: string; url?: string }[];
  error?: { message?: string };
}

/**
 * Generates a single image via LLMGate's OpenAI-compatible Image API.
 * Text-to-image goes to `POST /images/generations`; when reference images are
 * supplied it uses `POST /images/edits` with a multipart body.
 */
export async function generateLlmgateImage(
  modelId: string,
  params: LlmgateImageParams
): Promise<{ data: Buffer; id?: string }> {
  const model = llmgateModelId(modelId);
  const res =
    params.references && params.references.length > 0
      ? await editImage(model, params)
      : await generateImage(model, params);

  if (!res.ok) {
    const message = await errorMessage(res);
    throw new Error(`LLMGate image request failed: ${message}`);
  }

  const json = (await res.json()) as LlmgateImageResponse;
  const entry = json.data?.[0];
  if (entry?.b64_json) {
    return {
      data: Buffer.from(entry.b64_json, "base64"),
      id: responseIdFromHeaders(headersToRecord(res.headers)),
    };
  }
  if (entry?.url) {
    const imageRes = await fetch(entry.url, { signal: params.signal });
    if (!imageRes.ok) {
      throw new Error(
        `LLMGate image request failed: could not download image (HTTP ${imageRes.status})`
      );
    }
    return {
      data: Buffer.from(await imageRes.arrayBuffer()),
      id: responseIdFromHeaders(headersToRecord(res.headers)),
    };
  }

  const detail = json.error?.message ?? "no image returned in response";
  throw new Error(`LLMGate image request failed: ${detail}`);
}

async function generateImage(
  model: string,
  params: LlmgateImageParams
): Promise<Response> {
  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    n: 1,
  };
  if (params.size) body.size = params.size;

  return fetch(`${baseUrl()}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
}

async function editImage(
  model: string,
  params: LlmgateImageParams
): Promise<Response> {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", params.prompt);
  form.append("n", "1");
  if (params.size) form.append("size", params.size);
  for (const ref of params.references ?? []) {
    form.append("image[]", await referenceToBlob(ref));
  }

  return fetch(`${baseUrl()}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireApiKey()}` },
    body: form,
    signal: params.signal,
  });
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as LlmgateImageResponse;
    if (json.error?.message) return json.error.message;
  } catch {
    // fall through to status text
  }
  return `HTTP ${res.status} ${res.statusText}`.trim();
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

async function referenceToBlob(ref: ImageReference): Promise<Blob> {
  if (typeof ref === "string") {
    const res = await fetch(ref);
    if (!res.ok) {
      throw new Error(`Could not fetch reference image ${ref}`);
    }
    return res.blob();
  }
  const bytes = new Uint8Array(ref);
  return new Blob([bytes], { type: mimeFromBytes(bytes) });
}

function mimeFromBytes(data: Uint8Array): string {
  if (hasPrefix(data, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (hasPrefix(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasPrefix(data, [0x47, 0x49, 0x46])) return "image/gif";
  if (
    hasPrefix(data, [0x52, 0x49, 0x46, 0x46]) &&
    data.length >= 12 &&
    ascii(data, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  if (hasPrefix(data, [0x42, 0x4d])) return "image/bmp";
  return "application/octet-stream";
}

function hasPrefix(data: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte);
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  if (data.length < offset + length) return "";
  return String.fromCharCode(...data.slice(offset, offset + length));
}

const LLMGATE_MODELS_TIMEOUT_MS = 5_000;

interface RawLlmgateModel {
  id: number;
  model_name: string;
  display_name?: string;
  description?: string;
  model_type: number;
  pricing_type?: string;
  price_input?: number;
  price_output?: number;
  price_request?: number;
}

export interface LlmgateModels {
  text: ModelEntry[];
  image: ModelEntry[];
}

/**
 * Best-effort discovery of LLMGate's catalog for `ai models`. Only runs when
 * LLMGATE is set, so users who don't use LLMGate pay no latency. Returns empty
 * lists on any failure. IDs are prefixed with `llmgate/`.
 */
export async function fetchLlmgateModels(): Promise<LlmgateModels> {
  if (!process.env.LLMGATE_API_KEY) return { text: [], image: [] };

  try {
    const res = await fetch(LLMGATE_MODELS_URL, {
      signal: AbortSignal.timeout(LLMGATE_MODELS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: { models?: RawLlmgateModel[] };
    };
    const models = json.data?.models ?? [];

    const text: ModelEntry[] = [];
    const image: ModelEntry[] = [];
    for (const m of models) {
      if (m.model_type === MODEL_TYPE_TEXT) {
        text.push(toEntry(m, "text"));
      } else if (m.model_type === MODEL_TYPE_IMAGE) {
        image.push(toEntry(m, "image"));
      }
    }
    return { text, image };
  } catch {
    process.stderr.write("Warning: could not fetch models from LLMGate\n");
    return { text: [], image: [] };
  }
}

function toEntry(m: RawLlmgateModel, capability: "text" | "image"): ModelEntry {
  return {
    id: `${LLMGATE_PREFIX}${m.model_name}`,
    name: m.display_name,
    description: m.description || undefined,
    creator: "llmgate",
    capabilities: [capability],
    pricing: llmgatePricing(m),
  };
}

function llmgatePricing(m: RawLlmgateModel): ModelEntry["pricing"] {
  const source =
    m.pricing_type === "request"
      ? { image: m.price_request, request: m.price_request }
      : { input: m.price_input, output: m.price_output };
  const entries = Object.entries(source)
    .filter(([, value]) => value != null && value !== 0)
    .map(([key, value]) => [key, String(value)]);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as ModelEntry["pricing"];
}
