import { QdrantClient } from '@qdrant/js-client-rest';
import axios from 'axios';
import httpsAgent from '../utils/httpAgent.js';

const EMBEDDING_DIMENSION = parseInt(process.env.EMBEDDING_DIM || '768');

let qdrantClient;

function getClient() {
  if (!qdrantClient) {
    const rawUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    const apiKey = process.env.QDRANT_API_KEY || undefined;

    // Pass host/port/https separately — QdrantClient's URL parser strips the
    // default HTTPS port (443) making it fall back to 6333.
    const parsed = new URL(rawUrl);
    const isHttps = parsed.protocol === 'https:';
    const port = parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 6333);

    console.log('qdrant host:', parsed.hostname, 'port:', port, 'https:', isHttps);
    console.log('qdrant api key:', apiKey ? apiKey.slice(0, 8) + '...' : '(not set)');

    qdrantClient = new QdrantClient({
      host: parsed.hostname,
      port,
      https: isHttps,
      apiKey,
      checkCompatibility: false,
    });
  }
  return qdrantClient;
}

async function getEmbedding(text) {
  const embeddingUrl = process.env.EMBEDDING_API_URL;
  const embeddingKey = process.env.EMBEDDING_API_KEY;

  if (embeddingUrl && embeddingKey) {
    const response = await axios.post(
      embeddingUrl,
      {
        input: text,
        model: process.env.EMBEDDING_MODEL || 'text-embedding-ada-002'
      },
      {
        headers: {
          Authorization: `Bearer ${embeddingKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000,
        httpsAgent,
      }
    );
    return response.data.data[0].embedding;
  }

  console.warn('EMBEDDING_API_URL not set - using zero vector (dev only)');
  return new Array(EMBEDDING_DIMENSION).fill(0);
}

export async function retrieveKnowledge(query, topK = 3, collectionOverride = null) {
  if (!process.env.EMBEDDING_API_URL) return [];

  const collection = collectionOverride || process.env.QDRANT_COLLECTION || 'knowledge_base';

  let vector;
  try {
    vector = await getEmbedding(query);
  } catch (err) {
    console.warn(`[qdrant] embedding failed, skipping RAG: ${err.message}`);
    return [];
  }

  try {
    const results = await getClient().search(collection, {
      vector,
      limit: topK,
      with_payload: true,
    });

    return results
      .map((hit) => hit.payload?.content || '')
      .filter(Boolean);
  } catch (err) {
    if (err?.status === 404) {
      console.warn(`Qdrant collection "${collection}" not found — skipping RAG`);
      return [];
    }
    console.warn(`[qdrant] search failed, skipping RAG: ${err.message}`);
    return [];
  }
}
