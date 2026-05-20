import axios from 'axios';

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek/deepseek-v4-flash:free';

// Free models to try in order — falls back if one is rate-limited
const FREE_MODELS = [
  'deepseek/deepseek-v4-flash:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
];

async function callLLM(apiKey, model, payload) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await axios.post(LLM_BASE_URL, { ...payload, model }, {
    headers,
    timeout: 25000,
  });
  return response.data.choices[0].message.content;
}

export async function queryLLM(messages) {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
  const preferredModel = process.env.LLM_MODEL || process.env.OPENROUTER_MODEL;

  if (!apiKey) {
    throw new Error('LLM_API_KEY (or OPENROUTER_API_KEY) is not set');
  }

  const payload = { messages };

  const models = preferredModel ? [preferredModel, ...FREE_MODELS] : FREE_MODELS;

  let lastErr;
  for (const model of models) {
    try {
      return await callLLM(apiKey, model, payload);
    } catch (err) {
      const status = err.response?.status;
      const retryAfter = err.response?.data?.metadata?.retry_after_seconds;
      console.warn(`LLM ${model} failed (${status}):`, JSON.stringify(err.response?.data?.error));
      if (status === 429 || status === 404) {
        lastErr = err;
        if (retryAfter) {
          await new Promise(r => setTimeout(r, retryAfter * 1000));
        }
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}
