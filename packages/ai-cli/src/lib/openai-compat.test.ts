import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  fetchOpenAICompatModels,
  generateOpenAICompatImage,
  isOpenAICompatModel,
  openAICompatModelId,
  openAICompatTextModel,
} from "./openai-compat.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;
const originalBaseUrl = process.env.OPENAI_BASE_URL;

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_BASE_URL = "https://example.com/v1";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBaseUrl;
});

describe("isOpenAICompatModel / openAICompatModelId", () => {
  test("detects and strips the openai-compat/ prefix", () => {
    expect(isOpenAICompatModel("openai-compat/gpt-5.5")).toBe(true);
    expect(isOpenAICompatModel("openai/gpt-5.5")).toBe(false);
    expect(openAICompatModelId("openai-compat/gpt-5.5")).toBe("gpt-5.5");
  });
});

describe("openAICompatTextModel", () => {
  test("builds a chat model with the stripped id", () => {
    const model = openAICompatTextModel("openai-compat/gpt-5.5") as {
      modelId: string;
      provider: string;
    };
    expect(model.modelId).toBe("gpt-5.5");
    expect(model.provider).toContain("openai-compat");
  });

  test("throws a clear error when the key is missing", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => openAICompatTextModel("openai-compat/gpt-5.5")).toThrow(
      /OPENAI_API_KEY/
    );
  });
});

describe("generateOpenAICompatImage", () => {
  test("posts to /images/generations and returns bytes", async () => {
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

    const result = await generateOpenAICompatImage(
      "openai-compat/gpt-image-2",
      {
        prompt: "a red panda",
        size: "1024x1024",
      }
    );

    expect(result.data.toString()).toBe("hello");
    expect(result.id).toBe("req-123");

    expect(captured?.url).toBe("https://example.com/v1/images/generations");
    expect(captured?.init.method).toBe("POST");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");

    const body = JSON.parse(captured?.init.body as string);
    expect(body.model).toBe("gpt-image-2");
    expect(body.prompt).toBe("a red panda");
    expect(body.n).toBe(1);
    expect(body.size).toBe("1024x1024");
  });

  test("uses /images/edits with a multipart body when references are supplied", async () => {
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
    const result = await generateOpenAICompatImage(
      "openai-compat/gpt-image-2",
      {
        prompt: "make it blue",
        references: [pngBytes],
      }
    );

    expect(result.data.toString()).toBe("edited");
    expect(captured?.url).toBe("https://example.com/v1/images/edits");
    expect(captured?.init.body).toBeInstanceOf(FormData);
  });

  test("defaults the base URL to the OpenAI API when unset", async () => {
    delete process.env.OPENAI_BASE_URL;
    let captured: string | undefined;
    globalThis.fetch = mock((url: string) => {
      captured = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ b64_json: Buffer.from("x").toString("base64") }],
          }),
          { status: 200 }
        )
      );
    }) as unknown as typeof fetch;

    await generateOpenAICompatImage("openai-compat/gpt-image-2", {
      prompt: "hi",
    });
    expect(captured).toBe("https://api.openai.com/v1/images/generations");
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
      generateOpenAICompatImage("openai-compat/x", { prompt: "hi" })
    ).rejects.toThrow(/bad model/);
  });

  test("throws when the key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      generateOpenAICompatImage("openai-compat/x", { prompt: "hi" })
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe("fetchOpenAICompatModels", () => {
  test("returns empty lists when no key is set", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await fetchOpenAICompatModels();
    expect(result.text).toHaveLength(0);
    expect(result.image).toHaveLength(0);
  });

  test("lists /models entries as text models with the prefix", async () => {
    let captured: string | undefined;
    globalThis.fetch = mock((url: string) => {
      captured = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-5.5" }, { id: "llama-3.3-70b" }],
          }),
          { status: 200 }
        )
      );
    }) as unknown as typeof fetch;

    const result = await fetchOpenAICompatModels();

    expect(captured).toBe("https://example.com/v1/models");
    expect(result.text.map((m) => m.id)).toEqual([
      "openai-compat/gpt-5.5",
      "openai-compat/llama-3.3-70b",
    ]);
    expect(result.text[0].creator).toBe("openai-compat");
    expect(result.text[0].capabilities).toEqual(["text"]);
    expect(result.image).toHaveLength(0);
  });

  test("returns empty lists on fetch error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network"))
    ) as unknown as typeof fetch;
    const result = await fetchOpenAICompatModels();
    expect(result.text).toHaveLength(0);
    expect(result.image).toHaveLength(0);
  });
});
