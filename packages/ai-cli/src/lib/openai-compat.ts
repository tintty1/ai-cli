import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { ImageReference } from "./image-references.js";
import type { ModelEntry } from "./models.js";
import { responseIdFromHeaders } from "./response-id.js";

export const OPENAI_COMPAT_PREFIX = "openai-compat/";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** OpenAI-compatible API base URL (`OPENAI_BASE_URL`), without a trailing slash. */
function baseUrl(): string {
  const url = process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL;
  return url.replace(/\/+$/, "");
}

/** True for model IDs the user routed through the OpenAI-compatible provider, e.g. `openai-compat/gpt-5.5`. */
export function isOpenAICompatModel(modelId: string): boolean {
  return modelId.startsWith(OPENAI_COMPAT_PREFIX);
}

/** Strips the `openai-compat/` sentinel to recover the real model name. */
export function openAICompatModelId(modelId: string): string {
  return modelId.slice(OPENAI_COMPAT_PREFIX.length);
}

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is required for openai-compat/ models (set it to your OpenAI-compatible API key)"
    );
  }
  return key;
}

/** OpenAI-compatible chat model as an AI SDK LanguageModel (`/chat/completions`). */
export function openAICompatTextModel(modelId: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: "openai-compat",
    baseURL: baseUrl(),
    apiKey: requireApiKey(),
  });
  return provider.chatModel(openAICompatModelId(modelId));
}

export interface OpenAICompatImageParams {
  prompt: string;
  size?: `${number}x${number}`;
  references?: ImageReference[];
  signal?: AbortSignal;
}

interface OpenAICompatImageResponse {
  data?: { b64_json?: string; url?: string }[];
  error?: { message?: string };
}

/**
 * Generates a single image via the OpenAI-compatible Image API.
 * Text-to-image goes to `POST /images/generations`; when reference images are
 * supplied it uses `POST /images/edits` with a multipart body.
 */
export async function generateOpenAICompatImage(
  modelId: string,
  params: OpenAICompatImageParams
): Promise<{ data: Buffer; id?: string }> {
  const model = openAICompatModelId(modelId);
  const res =
    params.references && params.references.length > 0
      ? await editImage(model, params)
      : await generateImage(model, params);

  if (!res.ok) {
    const message = await errorMessage(res);
    throw new Error(`OpenAI-compatible image request failed: ${message}`);
  }

  const json = (await res.json()) as OpenAICompatImageResponse;
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
        `OpenAI-compatible image request failed: could not download image (HTTP ${imageRes.status})`
      );
    }
    return {
      data: Buffer.from(await imageRes.arrayBuffer()),
      id: responseIdFromHeaders(headersToRecord(res.headers)),
    };
  }

  const detail = json.error?.message ?? "no image returned in response";
  throw new Error(`OpenAI-compatible image request failed: ${detail}`);
}

async function generateImage(
  model: string,
  params: OpenAICompatImageParams
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
  params: OpenAICompatImageParams
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
    const json = (await res.json()) as OpenAICompatImageResponse;
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

const OPENAI_COMPAT_MODELS_TIMEOUT_MS = 5_000;

interface RawOpenAICompatModel {
  id: string;
}

export interface OpenAICompatModels {
  text: ModelEntry[];
  image: ModelEntry[];
}

/**
 * Best-effort discovery of the OpenAI-compatible endpoint's catalog for
 * `ai models`. Only runs when OPENAI_API_KEY is set, so users who don't use it
 * pay no latency. The standard `/models` response carries no modality, so every
 * entry is listed under `text`. Returns empty lists on any failure. IDs are
 * prefixed with `openai-compat/`.
 */
export async function fetchOpenAICompatModels(): Promise<OpenAICompatModels> {
  if (!process.env.OPENAI_API_KEY) return { text: [], image: [] };

  try {
    const res = await fetch(`${baseUrl()}/models`, {
      headers: { Authorization: `Bearer ${requireApiKey()}` },
      signal: AbortSignal.timeout(OPENAI_COMPAT_MODELS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: RawOpenAICompatModel[] };
    const models = json.data ?? [];

    const text: ModelEntry[] = models.map((m) => ({
      id: `${OPENAI_COMPAT_PREFIX}${m.id}`,
      creator: "openai-compat",
      capabilities: ["text"],
    }));
    return { text, image: [] };
  } catch {
    process.stderr.write(
      "Warning: could not fetch models from OpenAI-compatible endpoint\n"
    );
    return { text: [], image: [] };
  }
}
