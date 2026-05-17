import axios from 'axios';

/**
 * Sends a chat request to the internal OpenClaw LLM service.
 */
export async function queryLLM(messages, systemPrompt) {
  const apiUrl = process.env.OPENCLAW_API_URL;
  const apiKey = process.env.OPENCLAW_API_KEY;

  if (!apiUrl) {
    throw new Error('OPENCLAW_API_URL is not set');
  }

  const payload = {
    messages: systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await axios.post(apiUrl, payload, { headers });

  const data = response.data;

  if (data.choices && data.choices.length > 0) {
    return data.choices[0].message.content;
  }
  if (typeof data.reply === 'string') {
    return data.reply;
  }
  if (typeof data.content === 'string') {
    return data.content;
  }

  throw new Error(`Unexpected OpenClaw response shape: ${JSON.stringify(data)}`);
}
