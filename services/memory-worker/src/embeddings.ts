import { env, pipeline } from "@xenova/transformers";
import { EMBEDDING_PROFILE } from "./config";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export function validateEmbeddingVector(vector: readonly number[]): number[] {
  if (vector.length !== EMBEDDING_PROFILE.dimension) {
    throw new Error(`embedding output must have ${EMBEDDING_PROFILE.dimension} dimensions`);
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("embedding output must contain only finite values");
  }
  return [...vector];
}

type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

function loadFeatureExtractor(): Promise<FeatureExtractor> {
  return pipeline("feature-extraction", EMBEDDING_PROFILE.modelId, {
    quantized: true,
  }) as unknown as Promise<FeatureExtractor>;
}

export function createEmbeddingRuntime(loadModel: () => Promise<FeatureExtractor> = loadFeatureExtractor): {
  configureCache(directory: string): void;
  provider: EmbeddingProvider;
} {
  let extractorPromise: Promise<FeatureExtractor> | undefined;
  let initializedCacheDirectory: string | undefined;

  const configureCache = (directory: string): void => {
    if (extractorPromise && directory !== initializedCacheDirectory) {
      throw new Error("embedding model cache cannot change after initialization");
    }
    env.cacheDir = directory;
  };

  const extractor = (): Promise<FeatureExtractor> => {
    if (!extractorPromise) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      initializedCacheDirectory = env.cacheDir;
      const pending = Promise.resolve().then(loadModel);
      let tracked: Promise<FeatureExtractor>;
      tracked = pending.catch((error: unknown) => {
        if (extractorPromise === tracked) {
          extractorPromise = undefined;
          initializedCacheDirectory = undefined;
        }
        throw error;
      });
      extractorPromise = tracked;
    }
    return extractorPromise;
  };

  return {
    configureCache,
    provider: {
      async embed(text) {
        const model = await extractor();
        const output = await model(text, { pooling: "mean", normalize: true });
        return validateEmbeddingVector(Array.from(output.data));
      },
    },
  };
}

const runtime = createEmbeddingRuntime();

export const configureEmbeddingCache = runtime.configureCache;
export const cpuEmbeddingProvider = runtime.provider;
