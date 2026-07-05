import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  fetchLlmgateModels,
  generateLlmgateImage,
  isLlmgateModel,
  llmgateModelId,
  llmgateTextModel,
} from "./llmgate.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.LLMGATE_API_KEY;

beforeEach(() => {
  process.env.LLMGATE_API_KEY = "lg-test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.LLMGATE_API_KEY;
  else process.env.LLMGATE_API_KEY = originalKey;
});

describe("isLlmgateModel / llmgateModelId", () => {
  test("detects and strips the llmgate/ prefix", () => {
    expect(isLlmgateModel("llmgate/claude-opus-4-8")).toBe(true);
    expect(isLlmgateModel("openai/gpt-5.5")).toBe(false);
    expect(llmgateModelId("llmgate/claude-opus-4-8")).toBe("claude-opus-4-8");
  });
});

describe("llmgateTextModel", () => {
  test("builds an LLMGate chat model with the stripped id", () => {
    const model = llmgateTextModel("llmgate/claude-opus-4-8") as {
      modelId: string;
      provider: string;
    };
    expect(model.modelId).toBe("claude-opus-4-8");
    expect(model.provider).toContain("llmgate");
  });

  test("throws a clear error when the key is missing", () => {
    delete process.env.LLMGATE_API_KEY;
    expect(() => llmgateTextModel("llmgate/x")).toThrow(/LLMGATE_API_KEY/);
  });
});

describe("generateLlmgateImage", () => {
  test("posts to the generations API and returns bytes", async () => {
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

    const result = await generateLlmgateImage("llmgate/gpt-image-2", {
      prompt: "a red panda",
      size: "1024x1024",
    });

    expect(result.data.toString()).toBe("hello");
    expect(result.id).toBe("req-123");

    expect(captured?.url).toBe("https://llmgate.app/v1/images/generations");
    expect(captured?.init.method).toBe("POST");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer lg-test");

    const body = JSON.parse(captured?.init.body as string);
    expect(body.model).toBe("gpt-image-2");
    expect(body.prompt).toBe("a red panda");
    expect(body.n).toBe(1);
    expect(body.size).toBe("1024x1024");
  });

  test("downloads the image when the API returns a url", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === "https://cdn.example.com/img.png") {
        return Promise.resolve(
          new Response(Buffer.from("bytes"), { status: 200 })
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ url: "https://cdn.example.com/img.png" }],
          }),
          { status: 200 }
        )
      );
    }) as unknown as typeof fetch;

    const result = await generateLlmgateImage("llmgate/gpt-image-2", {
      prompt: "hi",
    });
    expect(result.data.toString()).toBe("bytes");
  });

  test("uses the edits endpoint with multipart when references are supplied", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      captured = { url, init };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ b64_json: Buffer.from("edited").toString("base64") }],
          }),
          { status: 200 }
        )
      );
    }) as unknown as typeof fetch;

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const result = await generateLlmgateImage("llmgate/gpt-image-2", {
      prompt: "make it blue",
      references: [pngBytes],
    });

    expect(result.data.toString()).toBe("edited");
    expect(captured?.url).toBe("https://llmgate.app/v1/images/edits");
    expect(captured?.init.body).toBeInstanceOf(FormData);
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
      generateLlmgateImage("llmgate/x", { prompt: "hi" })
    ).rejects.toThrow(/bad model/);
  });

  test("throws when the key is missing", async () => {
    delete process.env.LLMGATE_API_KEY;
    await expect(
      generateLlmgateImage("llmgate/x", { prompt: "hi" })
    ).rejects.toThrow(/LLMGATE/);
  });
});

describe("fetchLlmgateModels", () => {
  test("returns empty lists when no key is set", async () => {
    delete process.env.LLMGATE_API_KEY;
    const result = await fetchLlmgateModels();
    expect(result.text).toHaveLength(0);
    expect(result.image).toHaveLength(0);
  });

  test("splits text (type 1) and image (type 4) models and prefixes ids", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              models: [
                {
                  id: 101,
                  model_name: "claude-opus-4-8",
                  display_name: "claude-opus-4-8",
                  description: "Most capable",
                  model_type: 1,
                  pricing_type: "token",
                  price_input: 6,
                  price_output: 30,
                },
                {
                  id: 59,
                  model_name: "gpt-image-2",
                  display_name: "gpt-image-2",
                  model_type: 4,
                  pricing_type: "request",
                  price_request: 0.2,
                },
                {
                  id: 1,
                  model_name: "some-embed",
                  model_type: 2,
                },
              ],
            },
          }),
          { status: 200 }
        )
      )
    ) as unknown as typeof fetch;

    const result = await fetchLlmgateModels();

    expect(result.text.map((m) => m.id)).toEqual(["llmgate/claude-opus-4-8"]);
    expect(result.text[0].creator).toBe("llmgate");
    expect(result.text[0].capabilities).toEqual(["text"]);
    expect(result.text[0].pricing).toEqual({ input: "6", output: "30" });

    expect(result.image.map((m) => m.id)).toEqual(["llmgate/gpt-image-2"]);
    expect(result.image[0].pricing).toEqual({ image: "0.2", request: "0.2" });
  });

  test("returns empty lists on fetch error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network"))
    ) as unknown as typeof fetch;
    const result = await fetchLlmgateModels();
    expect(result.text).toHaveLength(0);
    expect(result.image).toHaveLength(0);
  });
});
