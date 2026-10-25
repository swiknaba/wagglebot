import { describe, expect, test } from "bun:test";
import { env } from "@xenova/transformers";
import { configureEmbeddingCache, createEmbeddingRuntime, validateEmbeddingVector } from "./embeddings";

test("routes model files through the configured cache directory before lazy initialization", () => {
  configureEmbeddingCache("/private/tmp/wagglebot-model-cache-test");
  expect(env.cacheDir).toBe("/private/tmp/wagglebot-model-cache-test");
});

test("allows same-cache configuration after model initialization and rejects cache changes", async () => {
  const runtime = createEmbeddingRuntime(async () => async () => ({ data: Array(384).fill(1 / Math.sqrt(384)) }));
  runtime.configureCache("/private/tmp/wagglebot-model-cache-lifecycle-test");
  await runtime.provider.embed("test");
  runtime.configureCache("/private/tmp/wagglebot-model-cache-lifecycle-test");
  expect(() => runtime.configureCache("/private/tmp/other-model-cache")).toThrow(/cannot change/i);
});

test("clears a rejected model load so a later startup can retry", async () => {
  let loads = 0;
  const runtime = createEmbeddingRuntime(async () => {
    loads += 1;
    if (loads === 1) throw new Error("temporary model load failure");
    return async () => ({ data: Array(384).fill(1 / Math.sqrt(384)) });
  });
  runtime.configureCache("/private/tmp/wagglebot-model-cache-retry-test");
  await expect(runtime.provider.embed("test")).rejects.toThrow("temporary model load failure");
  await expect(runtime.provider.embed("test")).resolves.toHaveLength(384);
  expect(loads).toBe(2);
});

describe("embedding vector validation", () => {
  test("accepts finite 384-dimensional vectors", () => {
    expect(validateEmbeddingVector(Array(384).fill(0.25))).toHaveLength(384);
  });

  test("rejects wrong dimensions and non-finite values", () => {
    expect(() => validateEmbeddingVector([0.1])).toThrow(/384/);
    expect(() => validateEmbeddingVector([...Array(383).fill(0.1), Number.NaN])).toThrow(/finite/i);
  });
});
