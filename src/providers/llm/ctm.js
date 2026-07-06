import axios from 'axios';
import { parseSseStream } from '../../services/openClawLlm.js';

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

  yield* parseSseStream(response.data);
}
export const __name = 'ctm';
