import { test } from 'node:test';
import assert from 'node:assert/strict';

// classifyIntent is a pure function — no external deps, safe to import directly
import { classifyIntent } from '../../../src/services/openClawLlm.js';

// ── classifyIntent tests ──────────────────────────────────────────────────────

test('classifyIntent returns "chat" for simple greeting', () => {
  assert.strictEqual(classifyIntent('你好'), 'chat');
});

test('classifyIntent returns "chat" for general conversation', () => {
  assert.strictEqual(classifyIntent('我今日好攰'), 'chat');
  assert.strictEqual(classifyIntent('我想傾下計'), 'chat');
});

test('classifyIntent returns "tools" for weather query', () => {
  assert.strictEqual(classifyIntent('天氣點'), 'tools');
  assert.strictEqual(classifyIntent('今日幾度'), 'tools');
  assert.strictEqual(classifyIntent('落雨嗎'), 'tools');
});

test('classifyIntent returns "tools" for time query', () => {
  assert.strictEqual(classifyIntent('而家幾點'), 'tools');
  assert.strictEqual(classifyIntent('現在時間'), 'tools');
});

test('classifyIntent returns "tools" for date query', () => {
  assert.strictEqual(classifyIntent('今日日期'), 'tools');
  assert.strictEqual(classifyIntent('星期幾'), 'tools');
});

test('classifyIntent returns "tools" for news query', () => {
  assert.strictEqual(classifyIntent('最新消息'), 'tools');
  assert.strictEqual(classifyIntent('新聞'), 'tools');
});

test('classifyIntent returns "tools" for stock/rate query', () => {
  assert.strictEqual(classifyIntent('股票幾錢'), 'tools');
  assert.strictEqual(classifyIntent('匯率'), 'tools');
});

test('classifyIntent is case-sensitive (Chinese text only)', () => {
  // English words should default to chat
  assert.strictEqual(classifyIntent('what is the weather'), 'chat');
  assert.strictEqual(classifyIntent('hello'), 'chat');
});

test('classifyIntent handles empty string', () => {
  const result = classifyIntent('');
  assert.ok(['chat', 'tools'].includes(result));
});

// ── getLlmProvider tests ──────────────────────────────────────────────────────

import { getLlmProvider } from '../../../src/providers/llm/index.js';

test('getLlmProvider returns a provider object for known names', async () => {
  for (const name of ['openclaw', 'gemini', 'groq', 'openrouter', 'ctm']) {
    const provider = getLlmProvider(name);
    assert.ok(provider, `provider "${name}" should exist`);
    assert.ok(typeof provider === 'object', `provider "${name}" should be an object`);
  }
});

test('getLlmProvider falls back to openclaw for unknown names', () => {
  const provider = getLlmProvider('nonexistent-provider');
  const openclaw = getLlmProvider('openclaw');
  assert.strictEqual(provider, openclaw);
});
