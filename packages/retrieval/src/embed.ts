import { GoogleGenAI } from "@google/genai";

export const EMBED_MODEL = "gemini-embedding-001";
export const EMBED_DIMS = 768;

/** Gemini's embed endpoint caps how many inputs it will take at once. */
const BATCH = 32;

export type EmbedTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface EmbedStats {
  requests: number;
  inputs: number;
  totalChars: number;
}

/**
 * gemini-embedding-001 returns UNNORMALIZED vectors whenever
 * outputDimensionality is reduced below its native 3072 — a 768-dim vector
 * comes back with an L2 norm around 0.58. Cosine distance is unaffected, but
 * inner-product and L2 searches would be silently wrong, so normalize here
 * and keep every stored vector unit-length.
 */
function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}

export class Embedder {
  private readonly ai: GoogleGenAI;
  readonly stats: EmbedStats = { requests: 0, inputs: 0, totalChars: 0 };

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async embed(texts: string[], task: EmbedTask): Promise<number[][]> {
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const res = await this.ai.models.embedContent({
        model: EMBED_MODEL,
        contents: slice,
        config: { outputDimensionality: EMBED_DIMS, taskType: task },
      });

      const embeddings = res.embeddings ?? [];
      if (embeddings.length !== slice.length) {
        throw new Error(`embedding count mismatch: sent ${slice.length}, got ${embeddings.length}`);
      }

      for (const e of embeddings) {
        const values = e.values;
        if (!values || values.length !== EMBED_DIMS) {
          throw new Error(`expected ${EMBED_DIMS} dims, got ${values?.length ?? 0}`);
        }
        out.push(normalize(values));
      }

      this.stats.requests += 1;
      this.stats.inputs += slice.length;
      this.stats.totalChars += slice.reduce((s, t) => s + t.length, 0);
    }

    return out;
  }
}
