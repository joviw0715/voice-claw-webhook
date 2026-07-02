import axios from 'axios';
import { StringDecoder } from 'string_decoder';

export function isAvailable() {
  return !!process.env.CTM_LLM_API_KEY && process.env.USE_CTM_LLM === 'true';
}

export async function* stream(messages) {
  const baseUrl = (process.env.CTM_LLM_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('CTM_LLM_BASE_URL not set');

  const model = process.env.CTM_LLM_MODEL || 'Qwen';
  let response;
  try {
    response = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.CTM_LLM_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        responseType: 'stream',
        timeout: 20000,
      },
    );
  } catch (err) {
    const status = err.response?.status;
    const detail = JSON.stringify(err.response?.data)?.slice(0, 200) ?? err.message;
    throw new Error(`CTM LLM HTTP ${status ?? 'ERR'}: ${detail}`);
  }

  const decoder = new StringDecoder('utf8');
  let buf = '';
  for await (const chunk of response.data) {
    buf += decoder.write(chunk);
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

export async function query(messages) {
  const baseUrl = (process.env.CTM_LLM_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('CTM_LLM_BASE_URL not set');

  const model = process.env.CTM_LLM_MODEL || 'Qwen';
  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages,
      chat_template_kwargs: { enable_thinking: false },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.CTM_LLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 25000,
    },
  );
  return response.data.choices[0].message.content;
}
export const __name = 'ctm';
