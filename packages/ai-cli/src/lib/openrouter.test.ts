import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  fetchOpenRouterModels,
  generateOpenRouterImage,
  isOpenRouterModel,
  openRouterModelId,
  openRouterTextModel,
} from "./openrouter.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

describe("isOpenRouterModel / openRouterModelId", () => {
  test("detects and strips the openrouter/ prefix", () => {
    expect(isOpenRouterModel("openrouter/anthropic/claude-sonnet-4.5")).toBe(
      true
    );
    expect(isOpenRouterModel("openai/gpt-5.5")).toBe(false);
    expect(openRouterModelId("openrouter/anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5"
    );
  });
});

describe("openRouterTextModel", () => {
  test("builds an OpenRouter chat model with the stripped id", () => {
    const model = openRouterTextModel(
      "openrouter/anthropic/claude-sonnet-4.5"
    ) as { modelId: string; provider: string };
    expect(model.modelId).toBe("anthropic/claude-sonnet-4.5");
    expect(model.provider).toContain("openrouter");
  });

  test("throws a clear error when the key is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => openRouterTextModel("openrouter/x/y")).toThrow(
      /OPENROUTER_API_KEY/
    );
  });
});

describe("generateOpenRouterImage", () => {
  test("posts to the image API with the documented body and returns bytes", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      captured = { url, init };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ b64_json: Buffer.from("hello").toString("base64") }],
          }),
          { status: 200, headers: { "x-request-id": "req-123" } }
        )
      );
    }) as unknown as typeof fetch;

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const result = await generateOpenRouterImage(
      "openrouter/bytedance-seed/seedream-4.5",
      {
        prompt: "a red panda",
        size: "1024x1024",
        aspectRatio: "16:9",
        references: ["https://example.com/ref.png", pngBytes],
      }
    );

    expect(result.data.toString()).toBe("hello");
    expect(result.id).toBe("req-123");

    expect(captured?.url).toBe("https://openrouter.ai/api/v1/images");
    expect(captured?.init.method).toBe("POST");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");

    const body = JSON.parse(captured?.init.body as string);
    expect(body.model).toBe("bytedance-seed/seedream-4.5");
    expect(body.prompt).toBe("a red panda");
    expect(body.n).toBe(1);
    expect(body.size).toBe("1024x1024");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.input_references).toHaveLength(2);
    expect(body.input_references[0]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/ref.png" },
    });
    expect(body.input_references[1].image_url.url).toStartWith(
      "data:image/png;base64,"
    );
  });

  test("throws with the API error message on non-2xx", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "bad model" } }), {
          status: 400,
        })
      )
    ) as unknown as typeof fetch;

    await expect(
      generateOpenRouterImage("openrouter/x/y", { prompt: "hi" })
    ).rejects.toThrow(/bad model/);
  });

  test("throws when the key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(
      generateOpenRouterImage("openrouter/x/y", { prompt: "hi" })
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("fetchOpenRouterModels", () => {
  test("returns empty lists when no key is set", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const result = await fetchOpenRouterModels();
    expect(result.text).toHaveLength(0);
    expect(result.image).toHaveLength(0);
  });

  test("parses and prefixes text and image models", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.endsWith("/images/models")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "bytedance-seed/seedream-4.5",
                  name: "Seedream 4.5",
                  pricing: { image: "0.05" },
                },
              ],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-sonnet-4.5",
                name: "Claude Sonnet 4.5",
                architecture: { output_modalities: ["text"] },
                pricing: { prompt: "0.000003", completion: "0.000015" },
              },
              {
                id: "some/video-only",
                architecture: { output_modalities: ["video"] },
              },
            ],
          }),
          { status: 200 }
        )
      );
    }) as unknown as typeof fetch;

    const result = await fetchOpenRouterModels();

    expect(result.text.map((m) => m.id)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5",
    ]);
    expect(result.text[0].creator).toBe("openrouter");
    expect(result.text[0].capabilities).toEqual(["text"]);
    expect(result.text[0].pricing).toEqual({
      input: "0.000003",
      output: "0.000015",
    });

    expect(result.image.map((m) => m.id)).toEqual([
      "openrouter/bytedance-seed/seedream-4.5",
    ]);
    expect(result.image[0].pricing).toEqual({ image: "0.05" });
  });

  test("returns empty lists on fetch error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network"))
    ) as unknown as typeof fetch;
    const result = await fetchOpenRouterModels();
    expect(result.text).toHaveLength(0);
    expect(result.image).toHaveLength(0);
  });
});
