import { streamQueryLLM } from '../../services/openClawLlm.js';

export function isAvailable() {
  return true; // final fallback — always available
}

export async function* stream(messages, phone) {
  yield* streamQueryLLM(messages, phone);
}
export const __name = 'openclaw';
