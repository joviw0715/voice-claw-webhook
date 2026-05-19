import { QdrantClient } from '@qdrant/js-client-rest';
import axios from 'axios';

const EMBEDDING_DIMENSION = 1536;

let qdrantClient;

function getClient() {
  if (!qdrantClient) {
    const url = 'https://qdrant1.zeabur.app';//process.env.QDRANT_URL || 'http://localhost:6333';
    const apiKey = process.env.QDRANT_API_KEY || undefined;
    qdrantClient = new QdrantClient({ url, apiKey, checkCompatibility: false });
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
        }
      }
    );
    return response.data.data[0].embedding;
  }

  console.warn('EMBEDDING_API_URL not set - using zero vector (dev only)');
  return new Array(EMBEDDING_DIMENSION).fill(0);
}

/**
 * ✅ Rename to match server.js
 */
export async function retrieveKnowledge(query, topK = 3) {
  const collection = process.env.QDRANT_COLLECTION || 'knowledge_base';

  const vector = await getEmbedding(query);

  const results = await getClient().search(collection, {
    vector,
    limit: topK,
    with_payload: true,
  });

  return results
    .map((hit) => hit.payload?.content || '')
    .filter(Boolean);
}
