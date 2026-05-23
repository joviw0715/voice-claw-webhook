import axios from 'axios';

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
  });

  return response.data.choices[0].message.content;
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

// Fast intent classifier — 'tools' if query needs web search/reminders/memory, else 'chat'.
// Runs in parallel with Redis context loading so the overhead is hidden.
export async function classifyIntent(userText) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return 'tools'; // no OpenRouter key — always use OpenClaw

  try {
    const response = await axios.post(LLM_BASE_URL, {
      model: process.env.LLM_MODEL || FREE_MODELS[0],
      messages: [
        {
          role: 'system',
          content: 'Reply with only one word: "tools" or "chat". Reply "tools" if the message requires real-time web search (weather, news, prices, current time/date), scheduling a reminder, or memory recall. Reply "chat" for all other conversation.',
        },
        { role: 'user', content: userText },
      ],
      max_tokens: 5,
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });

    const word = response.data.choices[0]?.message?.content?.trim().toLowerCase() ?? '';
    return word.startsWith('tool') ? 'tools' : 'chat';
  } catch {
    return 'tools'; // on classifier error, default to OpenClaw for safety
  }
}

// Extract customer facts from a call transcript for persistent user memory.
// Returns a JSON object of facts, or null if extraction fails / not enough history.
export async function extractMemoryFacts(history, existingMemory = {}) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || history.length < 2) return null; // need at least 1 full turn

  const today = new Date().toISOString().slice(0, 10);
  const transcript = history
    .map(m => `${m.role === 'user' ? '用戶' : '祖兒'}: ${m.content}`)
    .join('\n');
  try {
    const response = await axios.post(LLM_BASE_URL, {
      model: process.env.LLM_MODEL || FREE_MODELS[0],
      messages: [
        {
          role: 'system',
          content: `Extract facts about the customer from this Cantonese call transcript. Return ONLY a compact one-line JSON object — no markdown, no extra text, no null values, omit fields not mentioned:
{"name":"...","location":"...","health_notes":"...","interests":"...","family":"...","last_call_summary":"...","last_call_date":"${today}"}
Existing memory (do not repeat unchanged fields): ${JSON.stringify(existingMemory)}`,
        },
        { role: 'user', content: `以下係電話對話記錄：\n\n${transcript}` },
      ],
      max_tokens: 250,
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const content = response.data.choices[0]?.message?.content?.trim() ?? '';
    // Extract the first {...} block — handles prose prefix/suffix from the model
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn('[extractMemoryFacts] no JSON object in response:', content.slice(0, 200));
      return null;
    }
    return JSON.parse(match[0]);
  } catch (err) {
    console.warn('[extractMemoryFacts] failed:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Streaming via OpenRouter — for non-tool conversational queries where speed matters
export async function* streamQueryOpenRouter(messages) {
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || FREE_MODELS[0];
  if (!apiKey) throw new Error('LLM_API_KEY not set');

  const response = await axios.post(LLM_BASE_URL, {
    messages,
    model,
    stream: true,
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    responseType: 'stream',
    timeout: 20000,
  });

  let buf = '';
  for await (const chunk of response.data) {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const tok = json.choices?.[0]?.delta?.content;
        if (tok) yield tok;
      } catch { /* non-JSON SSE line */ }
    }
  }
}
// Automatically falls back to yielding the full response as one chunk if the server
// doesn't return text/event-stream.
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
  let buf = '';
  for await (const chunk of response.data) {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const tok = json.choices?.[0]?.delta?.content;
        if (tok) yield tok;
      } catch { /* non-JSON SSE comment line */ }
    }
  }
}
