import axios from 'axios';
import httpsAgent from '../utils/httpAgent.js';

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions';

const FREE_MODELS = [
  'deepseek/deepseek-chat:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
];

function sessionKey(phone) {
  return phone ? `agent:main:${phone.replace(/\D/g, '')}` : 'agent:main:main';
}

// Shared SSE token generator: yields delta content tokens from an axios stream response.
export async function* parseSseStream(responseData) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of responseData) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    yield* _yieldSseLines(lines);
  }
  // Flush any remaining bytes the decoder held across the last chunk
  yield* _yieldSseLines((buf + decoder.decode()).split('\n'));
}

function* _yieldSseLines(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const tok = JSON.parse(data).choices?.[0]?.delta?.content;
      if (tok) yield tok;
    } catch { /* non-JSON SSE line */ }
  }
}

async function callOpenClawHTTP(messages, key) {
  const baseUrl = (process.env.OPENCLAW_URL || 'https://voiceclaw.zeabur.app').replace(/\/$/, '');
  const token = process.env.OPENCLAW_TOKEN;
  if (!token) throw new Error('OPENCLAW_TOKEN not set');

  const response = await axios.post(`${baseUrl}/v1/chat/completions`, {
    model: 'openclaw',
    messages,
  }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-openclaw-session-key': key,
      'Content-Type': 'application/json',
    },
    timeout: 40000,
    httpsAgent,
  });

  return response.data.choices[0].message.content;
}

async function callOpenRouter(apiKey, model, messages) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await axios.post(LLM_BASE_URL, { messages, model }, {
    headers,
    timeout: 25000,
    httpsAgent,
  });
  return response.data.choices[0].message.content;
}

export async function queryLLM(messages, phone) {
  if (process.env.OPENCLAW_TOKEN) {
    try {
      return await callOpenClawHTTP(messages, sessionKey(phone));
    } catch (err) {
      console.warn('OpenClaw HTTP failed, falling back to OpenRouter:', err.response?.data?.error?.message || err.message);
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

// Fast intent classifier — regex-based, no LLM call needed.
// 'tools' if the query needs real-time data or tool use, else 'chat'.
export function classifyIntent(userText) {
  const TOOLS_RE = /天氣|幾度|溫度|氣溫|落雨|晴天|今日.*係咩日|而家幾點|而家時間|現在時間|今日日期|星期幾|公眾假|新聞|最新消息|提醒|鬧鐘|設定.*時間|股票|匯率|幾錢|航班|火車時間表/;
  return TOOLS_RE.test(userText) ? 'tools' : 'chat';
}


// Shared OpenAI-compatible SSE streaming helper.
async function* streamOpenAiCompat(url, apiKey, model, messages, timeout = 20000) {
  const response = await axios.post(url, { messages, model, stream: true }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    responseType: 'stream',
    timeout,
    httpsAgent,
  });
  yield* parseSseStream(response.data);
}

export async function* streamQueryOpenRouter(messages) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY not set');
  yield* streamOpenAiCompat(LLM_BASE_URL, apiKey, process.env.LLM_MODEL || FREE_MODELS[0], messages);
}

export async function* streamQueryGemini(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  yield* streamOpenAiCompat(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey, process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite', messages, 15000,
  );
}

export async function* streamQueryGroq(messages) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');
  yield* streamOpenAiCompat(
    'https://api.groq.com/openai/v1/chat/completions',
    apiKey, process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', messages, 15000,
  );
}
export async function* streamQueryLLM(messages, phone) {
  const baseUrl = (process.env.OPENCLAW_URL || 'https://voiceclaw.zeabur.app').replace(/\/$/, '');
  const token = process.env.OPENCLAW_TOKEN;
  if (!token) throw new Error('OPENCLAW_TOKEN not set');

  const response = await axios.post(`${baseUrl}/v1/chat/completions`, {
    model: 'openclaw',
    messages,
    stream: true,
  }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-openclaw-session-key': sessionKey(phone),
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
    },
    responseType: 'stream',
    timeout: 40000,
    httpsAgent,
  });

  // Non-streaming fallback: yield whole response as one chunk
  const contentType = response.headers['content-type'] || '';
  if (!contentType.includes('text/event-stream')) {
    const chunks = [];
    for await (const chunk of response.data) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    try {
      const json = JSON.parse(body);
      const content = json.choices?.[0]?.message?.content;
      if (content) yield content;
    } catch { yield body; }
    return;
  }

  // SSE streaming: parse data: lines and yield delta content tokens
  yield* parseSseStream(response.data);
}
