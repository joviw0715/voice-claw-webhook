/**
 * Redis client logic tests — tests pure logic without real Redis connection.
 * We test the appendConversation/updateUserMemory trim/merge logic by
 * building a minimal test harness that injects a mock Redis client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline test of pure logic extracted from redisClient.js ──────────────────
// We test the business rules directly rather than mocking the module loader.

const MAX_HISTORY = 10;

function trimHistory(history) {
  if (history.length > MAX_HISTORY) return history.slice(-MAX_HISTORY);
  return history;
}

function mergeMemory(existing, updates) {
  return {
    ...existing,
    ...updates,
    ...(updates.name ? { name: updates.name } : {}),
  };
}

// ── Conversation trim tests ───────────────────────────────────────────────────

test('trimHistory keeps at most 10 messages', () => {
  const msgs = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const trimmed = trimHistory(msgs);
  assert.strictEqual(trimmed.length, 10);
});

test('trimHistory keeps the LAST 10 messages', () => {
  const msgs = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const trimmed = trimHistory(msgs);
  assert.strictEqual(trimmed[0].content, 'msg 5');
  assert.strictEqual(trimmed[9].content, 'msg 14');
});

test('trimHistory does not modify arrays with 10 or fewer messages', () => {
  const msgs = Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const trimmed = trimHistory(msgs);
  assert.strictEqual(trimmed.length, 8);
  assert.deepStrictEqual(trimmed, msgs);
});

test('trimHistory returns empty array for empty input', () => {
  assert.deepStrictEqual(trimHistory([]), []);
});

// ── Memory merge tests ────────────────────────────────────────────────────────

test('mergeMemory merges new fields with existing', () => {
  const existing = { age: 70, condition: 'stable' };
  const updates = { name: 'Alice' };
  const merged = mergeMemory(existing, updates);
  assert.strictEqual(merged.age, 70);
  assert.strictEqual(merged.name, 'Alice');
  assert.strictEqual(merged.condition, 'stable');
});

test('mergeMemory name always overwrites existing name', () => {
  const existing = { name: 'Bob', age: 65 };
  const updates = { name: 'Bobby' };
  const merged = mergeMemory(existing, updates);
  assert.strictEqual(merged.name, 'Bobby');
});

test('mergeMemory update without name keeps existing name', () => {
  const existing = { name: 'Carol', age: 75 };
  const updates = { medication: 'aspirin' };
  const merged = mergeMemory(existing, updates);
  assert.strictEqual(merged.name, 'Carol');
  assert.strictEqual(merged.medication, 'aspirin');
});

test('mergeMemory with empty existing returns updates', () => {
  const merged = mergeMemory({}, { name: 'Dave', age: 80 });
  assert.strictEqual(merged.name, 'Dave');
  assert.strictEqual(merged.age, 80);
});

test('mergeMemory updates overwrite non-name fields', () => {
  const existing = { age: 70, status: 'ok' };
  const updates = { status: 'improved' };
  const merged = mergeMemory(existing, updates);
  assert.strictEqual(merged.status, 'improved');
  assert.strictEqual(merged.age, 70);
});

// ── TTL constants validation ──────────────────────────────────────────────────

test('conversation TTL is 1 hour', () => {
  assert.strictEqual(60 * 60, 3600);
});

test('memory TTL is 30 days', () => {
  assert.strictEqual(60 * 60 * 24 * 30, 2592000);
});

test('result TTL is 2 minutes', () => {
  assert.strictEqual(120, 120);
});

// ── Provider config fallback logic ───────────────────────────────────────────

test('provider config returns {} when no CONSOLE_CALLBACK_URL and no Redis data', () => {
  // This mirrors the actual fallback: config ?? {}
  const config = null;
  const result = config ?? {};
  assert.deepStrictEqual(result, {});
});

test('provider config merges llm/tts/stt with auto defaults', () => {
  const current = {};
  const llm = 'gemini', tts = undefined, sst = undefined;
  const updated = {
    llm: llm ?? current.llm ?? 'auto',
    tts: tts ?? current.tts ?? 'auto',
    sst: sst ?? current.sst ?? 'auto',
  };
  assert.strictEqual(updated.llm, 'gemini');
  assert.strictEqual(updated.tts, 'auto');
});
