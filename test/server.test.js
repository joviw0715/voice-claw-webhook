/**
 * Integration tests for HTTP endpoints in server.js.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '0';
process.env.CONSOLE_API_TOKEN = 'test-admin-token';
process.env.BASE_URL = 'https://test.example.com';
process.env.TWILIO_AUTH_TOKEN = 'test-twilio-token';
process.env.REDIS_CONNECTION_STRING = 'redis://localhost:9999';
delete process.env.EMBEDDING_API_URL;

const { server } = await import('../server.js');
await new Promise(r => server.listening ? r() : server.once('listening', r));
const { port } = server.address();
const baseUrl = `http://localhost:${port}`;

after(() => server.close());

async function httpGet(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => res.text()) };
}

async function httpPost(path, body = {}, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => res.text()) };
}

test('GET /health returns 200 with status ok', async () => {
  const { status, body } = await httpGet('/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, 'ok');
});

test('GET /admin/providers without token returns 401', async () => {
  const { status } = await httpGet('/admin/providers');
  assert.strictEqual(status, 401);
});

test('GET /admin/providers with wrong token returns 401', async () => {
  const { status } = await httpGet('/admin/providers', { Authorization: 'Bearer wrong-token' });
  assert.strictEqual(status, 401);
});

test('GET /admin/providers with correct token returns 200 or 500', async () => {
  const { status, body } = await httpGet('/admin/providers', {
    Authorization: 'Bearer test-admin-token',
  });
  assert.ok([200, 500].includes(status), `expected 200 or 500, got ${status}`);
  if (status === 200) {
    assert.ok('llm' in body);
    assert.ok('tts' in body);
    assert.ok('stt' in body);
  }
});

test('POST /admin/providers with invalid llm returns 400', async () => {
  const { status, body } = await httpPost(
    '/admin/providers',
    { llm: 'invalid-model' },
    { Authorization: 'Bearer test-admin-token' }
  );
  assert.strictEqual(status, 400);
  assert.ok(body.error?.includes('Invalid llm'));
});

test('POST /admin/providers with invalid tts returns 400', async () => {
  const { status } = await httpPost(
    '/admin/providers',
    { tts: 'nonexistent' },
    { Authorization: 'Bearer test-admin-token' }
  );
  assert.strictEqual(status, 400);
});

test('POST /admin/providers with valid values returns 200 or 500', async () => {
  const { status, body } = await httpPost(
    '/admin/providers',
    { llm: 'gemini', tts: 'minimax', sst: 'azure' },
    { Authorization: 'Bearer test-admin-token' }
  );
  assert.ok([200, 500].includes(status), `expected 200 or 500, got ${status}`);
  if (status === 200) {
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.config.llm, 'gemini');
  }
});

test('GET /audio/nonexistent.wav returns 404', async () => {
  const res = await fetch(`${baseUrl}/audio/totally-nonexistent-file-xyz.wav`);
  assert.strictEqual(res.status, 404);
});
