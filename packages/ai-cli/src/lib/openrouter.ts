import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { ImageReference } from "./image-references.js";
import type { ModelEntry } from "./models.js";
import { responseIdFromHeaders } from "./response-id.js";

export const OPENROUTER_PREFIX = "openrouter/";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const REFERER = "https://github.com/vercel-labs/ai-cli";
const TITLE = "ai-cli";

/** True for model IDs the user routed through OpenRouter, e.g. `openrouter/anthropic/claude-sonnet-4.5`. */
export function isOpenRouterModel(modelId: string): boolean {
  return modelId.startsWith(OPENROUTER_PREFIX);
}

/** Strips the `openrouter/` sentinel to recover the real OpenRouter model slug. */
export function openRouterModelId(modelId: string): string {
  return modelId.slice(OPENROUTER_PREFIX.length);
}

function requireApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is required for openrouter/ models (set it to your OpenRouter API key)"
    );
  }
  return key;
}

function openRouterHeaders(): Record<string, string> {
  return { "HTTP-Referer": REFERER, "X-Title": TITLE };
}

/** OpenRouter chat model as an AI SDK LanguageModel (OpenAI-compatible `/chat/completions`). */
export function openRouterTextModel(modelId: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: "openrouter",
    baseURL: OPENROUTER_BASE_URL,
    apiKey: requireApiKey(),
    headers: openRouterHeaders(),
  });
  return provider.chatModel(openRouterModelId(modelId));
}

export interface OpenRouterImageParams {
  prompt: string;
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  references?: ImageReference[];
  signal?: AbortSignal;
}

interface OpenRouterImageResponse {
  data?: { b64_json?: string; media_type?: string }[];
  error?: { message?: string };
}

/**
 * Generates a single image via OpenRouter's dedicated Image API (`POST /images`).
 * OpenRouter's endpoint is not OpenAI-`/images/generations`-shaped, so this uses
 * a direct fetch rather than the AI SDK image model.
 */
export async function generateOpenRouterImage(
  modelId: string,
  params: OpenRouterImageParams
): Promise<{ data: Buffer; id?: string }> {
  const body: Record<string, unknown> = {
    model: openRouterModelId(modelId),
    prompt: params.prompt,
    n: 1,
  };
  if (params.size) body.size = params.size;
  if (params.aspectRatio) body.aspect_ratio = params.aspectRatio;
  if (params.references && params.references.length > 0) {
    body.input_references = params.references.map((ref) => ({
      type: "image_url",
      image_url: { url: referenceToUrl(ref) },
    }));
  }

  const res = await fetch(`${OPENROUTER_BASE_URL}/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
      ...openRouterHeaders(),
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!res.ok) {
    const message = await errorMessage(res);
    throw new Error(`OpenRouter image request failed: ${message}`);
  }

  const json = (await res.json()) as OpenRouterImageResponse;
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    const detail = json.error?.message ?? "no image returned in response";
    throw new Error(`OpenRouter image request failed: ${detail}`);
  }

  return {
    data: Buffer.from(b64, "base64"),
    id: responseIdFromHeaders(headersToRecord(res.headers)),
  };
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as OpenRouterImageResponse;
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

function referenceToUrl(ref: ImageReference): string {
  if (typeof ref === "string") return ref;
  return `data:${mimeFromBytes(ref)};base64,${Buffer.from(ref).toString("base64")}`;
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

const OPENROUTER_MODELS_TIMEOUT_MS = 5_000;

interface RawOpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  architecture?: { output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; image?: string };
}

export interface OpenRouterModels {
  text: ModelEntry[];
  image: ModelEntry[];
}

/**
 * Best-effort discovery of OpenRouter's catalog for `ai models`. Only runs when
 * OPENROUTER_API_KEY is set, so users who don't use OpenRouter pay no latency.
 * Returns empty lists on any failure. IDs are prefixed with `openrouter/`.
 */
export async function fetchOpenRouterModels(): Promise<OpenRouterModels> {
  if (!process.env.OPENROUTER_API_KEY) return { text: [], image: [] };

  const [text, image] = await Promise.all([
    fetchModelList(`${OPENROUTER_BASE_URL}/models`, "text"),
    fetchModelList(`${OPENROUTER_BASE_URL}/images/models`, "image"),
  ]);
  return { text, image };
}

async function fetchModelList(
  url: string,
  capability: "text" | "image"
): Promise<ModelEntry[]> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${requireApiKey()}` },
      signal: AbortSignal.timeout(OPENROUTER_MODELS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: RawOpenRouterModel[] };
    const models = json.data ?? [];

    const entries: ModelEntry[] = [];
    for (const m of models) {
      if (
        capability === "text" &&
        m.architecture?.output_modalities &&
        !m.architecture.output_modalities.includes("text")
      ) {
        continue;
      }
      entries.push({
        id: `${OPENROUTER_PREFIX}${m.id}`,
        name: m.name,
        description: m.description,
        creator: "openrouter",
        capabilities: [capability],
        pricing: openRouterPricing(m.pricing),
      });
    }
    return entries;
  } catch {
    process.stderr.write("Warning: could not fetch models from OpenRouter\n");
    return [];
  }
}

function openRouterPricing(
  pricing?: RawOpenRouterModel["pricing"]
): ModelEntry["pricing"] {
  if (!pricing) return undefined;
  const entries = Object.entries({
    input: pricing.prompt,
    output: pricing.completion,
    image: pricing.image,
  }).filter(([, value]) => value != null && value !== "" && value !== "0");
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as ModelEntry["pricing"];
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  if (data.length < offset + length) return "";
  return String.fromCharCode(...data.slice(offset, offset + length));
}
