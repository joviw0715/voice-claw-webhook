import { streamQueryLLM, queryLLM } from '../../services/openClawLlm.js';

export function isAvailable() {
  return true; // final fallback — always available
}

export async function* stream(messages, phone) {
  yield* streamQueryLLM(messages, phone);
}

export async function query(messages, phone) {
  return queryLLM(messages, phone);
}
