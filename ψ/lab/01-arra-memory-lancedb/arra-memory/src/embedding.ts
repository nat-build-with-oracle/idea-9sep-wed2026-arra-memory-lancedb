import { setting } from "./config";
/**
 * Semantic search, via an Ollama server you already run.
 *
 * Embeddings are OPTIONAL and always best-effort. If no server is configured,
 * or it is unreachable, or it returns something unusable, the memory is still
 * written and search still works — it just falls back to keyword matching and
 * says so. A memory system that refuses to remember because a side-car is down
 * has its priorities backwards.
 *
 * The model is not hard-coded because the right one is a property of the corpus.
 * `bge-m3` is the default for a reason worth stating: it is genuinely
 * multilingual, and measured on this fleet a Thai sentence scores 0.84 cosine
 * similarity against its own English translation while scoring 0.32 against
 * unrelated Thai. That means recall works ACROSS languages — an English query
 * finds a Thai memory. An English-first model like nomic-embed-text does not do
 * that, and for a bilingual corpus it is the whole point.
 */

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

/** Ollama's /api/embed. Same shape whether it is local or across a VPN. */
export function ollamaProvider(config: {
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs?: number;
}): EmbeddingProvider {
  const base = config.baseUrl.replace(/\/+$/, "");

  return {
    model: config.model,
    dimensions: config.dimensions,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      let response: Response;
      try {
        response = await fetch(`${base}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: config.model, input: texts }),
          // A slow embed must not hold a write open forever. The default is
          // generous because a cold model load genuinely takes many seconds.
          signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
        });
      } catch (error) {
        throw new EmbeddingError(
          `embedding provider unreachable: ${error instanceof Error ? error.message : "unknown"}`,
          "provider-unreachable",
        );
      }

      if (!response.ok) {
        throw new EmbeddingError(
          `embedding provider returned ${response.status}`,
          "provider-error",
        );
      }

      const body = (await response.json()) as { embeddings?: number[][] };
      const embeddings = body.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new EmbeddingError("embedding provider returned an unusable shape", "bad-response");
      }

      // Dimension drift is checked here rather than at query time. Storing a
      // vector of the wrong width would corrupt the index silently, and the
      // failure would surface later as bad results rather than an error.
      for (const vector of embeddings) {
        if (!Array.isArray(vector) || vector.length !== config.dimensions) {
          throw new EmbeddingError(
            `expected ${config.dimensions}-dimension vectors, got ${vector?.length}`,
            "dimension-mismatch",
          );
        }
      }

      // A NaN or an Infinity in a vector poisons every distance computed
      // against it. Zeroed here, once, rather than trusted downstream.
      return embeddings.map((v) => v.map((n) => (Number.isFinite(n) ? n : 0)));
    },
  };
}

/**
 * Builds a provider from the add-on's options, or null when disabled.
 * A blank URL is the off switch, not an error.
 */
export function providerFromEnv(): EmbeddingProvider | null {
  const baseUrl = setting("ollama_url");
  if (!baseUrl) return null;

  return ollamaProvider({
    baseUrl,
    model: setting("embedding_model") || "bge-m3",
    // Must match the width of the embedding column in db.ts. Changing it
    // rebuilds the table with every vector cleared — see rebuildMemories —
    // which is why it is loud config and not a constant buried in a query.
    dimensions: Number(setting("embedding_dimensions")) || 1024,
  });
}
