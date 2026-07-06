import { streamQueryGemini } from '../../services/openClawLlm.js';

export function isAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

export async function* stream(messages) {
  yield* streamQueryGemini(messages);
}

export const __name = 'gemini';
