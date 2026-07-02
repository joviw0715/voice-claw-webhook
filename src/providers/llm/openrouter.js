import { streamQueryOpenRouter } from '../../services/openClawLlm.js';

export function isAvailable() {
  return !!(process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY);
}

export async function* stream(messages) {
  yield* streamQueryOpenRouter(messages);
}

export async function query(messages) {
  let result = '';
  for await (const tok of streamQueryOpenRouter(messages)) result += tok;
  return result;
}
