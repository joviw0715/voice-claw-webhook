'use strict';

const { QdrantClient } = require('@qdrant/js-client-rest');
const axios = require('axios');

// Dimension of the embedding vectors (matches text-embedding-ada-002 default)
const EMBEDDING_DIMENSION = 1536;

let qdrantClient;

function getClient() {
  if (!qdrantClient) {
    const url = process.env.QDRANT_URL || 'http://localhost:6333';
    const apiKey = process.env.QDRANT_API_KEY || undefined;
    qdrantClient = new QdrantClient({ url, apiKey });
  }
  return qdrantClient;
}

/**
 * Generates an embedding vector for the given text using Azure OpenAI or a
 * compatible embedding endpoint.  Falls back to a simple random vector if no
 * embedding service is configured (development only).
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function getEmbedding(text) {
  const embeddingUrl = process.env.EMBEDDING_API_URL;
  const embeddingKey = process.env.EMBEDDING_API_KEY;

  if (embeddingUrl && embeddingKey) {
    const response = await axios.post(
      embeddingUrl,
      { input: text, model: process.env.EMBEDDING_MODEL || 'text-embedding-ada-002' },
      { headers: { Authorization: `Bearer ${embeddingKey}`, 'Content-Type': 'application/json' } }
    );
    return response.data.data[0].embedding;
  }

  // Development fallback: return a zero vector of dimension 1536
  console.warn('EMBEDDING_API_URL not set - using zero vector for Qdrant search (dev only)');
  return new Array(EMBEDDING_DIMENSION).fill(0);
}

/**
 * Searches the Qdrant collection for documents semantically similar to `query`.
 *
 * @param {string} query          The user's query text
 * @param {number} [topK=3]       Number of results to return
 * @returns {Promise<string[]>}   Array of document content strings
 */
async function searchKnowledge(query, topK = 3) {
  const collection = process.env.QDRANT_COLLECTION || 'knowledge_base';

  const vector = await getEmbedding(query);

  const results = await getClient().search(collection, {
    vector,
    limit: topK,
    with_payload: true,
  });

  return results.map((hit) => hit.payload?.content || '').filter(Boolean);
}

module.exports = { searchKnowledge };
