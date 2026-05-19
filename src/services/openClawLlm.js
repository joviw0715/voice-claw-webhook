import axios from 'axios';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Free models to try in order — falls back if one is rate-limited
const FREE_MODELS = [
  'deepseek/deepseek-v4-flash:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
];

async function callOpenRouter(apiKey, model, payload) {
  const response = await axios.post(OPENROUTER_URL, { ...payload, model }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
  return response.data.choices[0].message.content;
}

export async function queryLLM(messages, systemPrompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const preferredModel = process.env.OPENROUTER_MODEL;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const payload = {
    messages: systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages,
  };

  const models = preferredModel ? [preferredModel, ...FREE_MODELS] : FREE_MODELS;

  let lastErr;
  for (const model of models) {
    try {
      return await callOpenRouter(apiKey, model, payload);
    } catch (err) {
      const status = err.response?.status;
      console.warn(`OpenRouter ${model} failed (${status}):`, JSON.stringify(err.response?.data?.error));
      if (status === 429 || status === 404) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}
