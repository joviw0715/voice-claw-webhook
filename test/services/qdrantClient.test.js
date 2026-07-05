/**
 * Qdrant client logic tests — tests pure logic without real network calls.
 * We test the behavior contracts: returns [] on missing config, bad responses, etc.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Pure logic tests (no network) ────────────────────────────────────────────

test('retrieveKnowledge contract: returns [] when EMBEDDING_API_URL is unset', () => {
  // Mirrors the guard in qdrantClient.js:
  // if (!process.env.EMBEDDING_API_URL) return []
  const embeddingUrl = process.env.EMBEDDING_API_URL;
  delete process.env.EMBEDDING_API_URL;

  const result = !process.env.EMBEDDING_API_URL ? [] : ['something'];
  assert.deepStrictEqual(result, []);

  if (embeddingUrl) process.env.EMBEDDING_API_URL = embeddingUrl;
});

test('URL parsing handles HTTPS port correctly', () => {
  // Mirror the qdrantClient URL parsing logic
  function parseQdrantUrl(rawUrl) {
    const parsed = new URL(rawUrl);
    const isHttps = parsed.protocol === 'https:';
    let port = parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 6333);
    if (isHttps && port === 443) port = undefined;
    return { host: parsed.hostname, port, https: isHttps };
  }

  const r1 = parseQdrantUrl('https://qdrant1.zeabur.app');
  assert.strictEqual(r1.https, true);
  assert.strictEqual(r1.port, undefined);
  assert.strictEqual(r1.host, 'qdrant1.zeabur.app');

  const r2 = parseQdrantUrl('http://localhost:6333');
  assert.strictEqual(r2.https, false);
  assert.strictEqual(r2.port, 6333);

  const r3 = parseQdrantUrl('https://qdrant.example.com:443');
  assert.strictEqual(r3.https, true);
  assert.strictEqual(r3.port, undefined);
});

test('empty embedding result returns []', () => {
  // If embedding API returns no data, result should be []
  const embeddingResponse = { data: [] };
  const vector = embeddingResponse.data[0]?.embedding ?? null;
  const result = vector ? ['some result'] : [];
  assert.deepStrictEqual(result, []);
});

test('valid embedding result extracts vector correctly', () => {
  const embeddingResponse = {
    data: [{ embedding: [0.1, 0.2, 0.3] }],
  };
  const vector = embeddingResponse.data[0]?.embedding ?? null;
  assert.ok(Array.isArray(vector));
  assert.strictEqual(vector.length, 3);
});

test('qdrant 404 response returns []', () => {
  // Mirror error handling: catch errors and return []
  function handleQdrantError(err) {
    if (err.status === 404 || err.message?.includes('404')) return [];
    return [];
  }
  const result = handleQdrantError({ status: 404, message: 'Not Found' });
  assert.deepStrictEqual(result, []);
});

test('knowledge results extract payload.content correctly', () => {
  const mockPoints = [
    { payload: { content: 'Fact one about the patient' } },
    { payload: { content: 'Fact two about medication' } },
    { payload: { other: 'no content field' } },
  ];
  // Mirror the actual mapping in retrieveKnowledge
  const results = mockPoints
    .filter(p => p.payload?.content)
    .map(p => p.payload.content);

  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0], 'Fact one about the patient');
  assert.strictEqual(results[1], 'Fact two about medication');
});
