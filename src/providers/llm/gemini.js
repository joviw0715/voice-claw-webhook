import { streamQueryGemini } from '../../services/openClawLlm.js';

export function isAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

export async function* stream(messages) {
  yield* streamQueryGemini(messages);
}

export async function query(messages) {
  let result = '';
  for await (const tok of streamQueryGemini(messages)) result += tok;
  return result;
}
