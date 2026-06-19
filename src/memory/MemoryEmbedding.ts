/**
 * MemoryEmbedding — Embedding generation and vector storage for memory entries.
 *
 * Uses the local LLM Gateway (http://127.0.0.1:62000) /embeddings endpoint
 * to generate embeddings. Falls back to deterministic pseudo-embedding if
 * the gateway is unavailable.
 *
 * Storage: embeddings are stored in a separate SQLite table (memory_embedding)
 * alongside the FTS index, keyed by the same path as the memory entry.
 */

import { coreLogger } from '../core/Log.js';
import { getConfigValue } from '../config.js';
import { isLlmGatewaySkKey } from '../core/LocalLlmGateway.js';

function getGatewayKey(): string {
  const key = String(getConfigValue('llm_gateway.api_key') || '').trim();
  return isLlmGatewaySkKey(key) ? key : '';
}
const DEFAULT_EMBEDDING_DIMENSIONS = 256;
const GATEWAY_URL = 'http://127.0.0.1:62000';


export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

/**
 * Generate an embedding vector for the given text using the local LLM Gateway.
 * Falls back to a deterministic hash-based pseudo-embedding if the gateway is unavailable.
 */
export async function generateEmbedding(
  text: string,
  model: string = 'text-embedding-3-small',
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): Promise<EmbeddingResult> {
  try {
    const response = await fetch(`${GATEWAY_URL}/llm/openai/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getGatewayKey()}`,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Gateway returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      model: string;
    };

    if (data.data && data.data.length > 0 && data.data[0].embedding) {
      return {
        vector: data.data[0].embedding,
        model: data.model || model,
        dimensions: data.data[0].embedding.length,
      };
    }

    throw new Error('No embedding in response');
  } catch (err) {
    coreLogger.warn(
      `[MemoryEmbedding] Gateway embedding failed, using deterministic fallback: ${err instanceof Error ? err.message : err}`,
    );
    return {
      vector: deterministicPseudoEmbedding(text, dimensions),
      model: 'deterministic-fallback',
      dimensions,
    };
  }
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Deterministic pseudo-embedding fallback: generates a fixed-dimension vector
 * from text using a hash-based approach. Not semantically meaningful but stable.
 */
function deterministicPseudoEmbedding(text: string, dimensions: number): number[] {
  const result = new Array(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    const slot = (charCode * 31 + i) % dimensions;
    result[slot] += Math.sin(charCode * 0.01 + i * 0.001);
  }
  const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      result[i] /= norm;
    }
  }
  return result;
}
