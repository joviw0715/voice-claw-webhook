import WebSocket from 'ws';
import axios from 'axios';
import { randomUUID } from 'crypto';

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions';

const FREE_MODELS = [
  'deepseek/deepseek-v4-flash:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
];

function formatMessages(messages) {
  return messages.map(m => `${m.role}: ${m.content}`).join('\n');
}

async function callOpenClawWS(messages) {
  const host = process.env.OPENCLAW_HOST;
  const token = process.env.OPENCLAW_TOKEN;

  if (!host || !token) throw new Error('OPENCLAW_HOST or OPENCLAW_TOKEN not set');

  return new Promise((resolve, reject) => {
    const url = /^wss?:\/\//.test(host) ? host : `wss://${host}`;
    const ws = new WebSocket(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    let settled = false;
    let accumulated = '';

    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      ws.terminate();
      fn(val);
    };

    const connectTimeout = setTimeout(() => {
      done(reject, new Error('OpenClaw WebSocket connection timed out'));
    }, 10000);

    ws.on('open', () => {
      const payload = JSON.stringify({
        id: randomUUID(),
        method: 'chat.send',
        params: {
          message: formatMessages(messages),
          session_id: randomUUID(),
        },
      });
      console.log('[OpenClaw] connected, sending payload:', payload.slice(0, 200));
      ws.send(payload);
    });

    ws.on('message', (data) => {
      console.log('[OpenClaw] message received:', data.toString().slice(0, 200));
      try {
        const parsed = JSON.parse(data);
        const chunk = parsed.result?.delta ?? parsed.result?.message ?? parsed.result?.content
          ?? parsed.delta ?? parsed.message ?? parsed.content ?? '';
        accumulated += chunk;
        if (parsed.result?.done || parsed.done) {
          done(resolve, accumulated);
        }
      } catch {
        // ignore unparseable chunk
      }
    });

    ws.on('close', (code, reason) => {
      console.log('[OpenClaw] closed — code:', code, 'reason:', reason.toString(), 'accumulated:', accumulated.length, 'chars');
      if (settled) return;
      if (accumulated) {
        done(resolve, accumulated);
      } else {
        done(reject, new Error(`OpenClaw WebSocket closed (${code}) with no response`));
      }
    });

    ws.on('error', (err) => {
      console.log('[OpenClaw] error:', err.message);
      done(reject, err);
    });
  });
}

async function callOpenRouter(apiKey, model, messages) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await axios.post(LLM_BASE_URL, { messages, model }, {
    headers,
    timeout: 25000,
  });
  return response.data.choices[0].message.content;
}

export async function queryLLM(messages) {
  if (process.env.OPENCLAW_HOST && process.env.OPENCLAW_TOKEN) {
    try {
      return await callOpenClawWS(messages);
    } catch (err) {
      console.warn('OpenClaw WebSocket failed, falling back to OpenRouter:', err.message);
    }
  }

  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
  const preferredModel = process.env.LLM_MODEL || process.env.OPENROUTER_MODEL;

  if (!apiKey) throw new Error('LLM_API_KEY (or OPENROUTER_API_KEY) is not set');

  const models = preferredModel ? [preferredModel, ...FREE_MODELS] : FREE_MODELS;

  let lastErr;
  for (const model of models) {
    try {
      return await callOpenRouter(apiKey, model, messages);
    } catch (err) {
      const status = err.response?.status;
      const retryAfter = err.response?.data?.metadata?.retry_after_seconds;
      console.warn(`OpenRouter ${model} failed (${status}):`, JSON.stringify(err.response?.data?.error));
      if (status === 429 || status === 404) {
        lastErr = err;
        if (retryAfter) await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}
