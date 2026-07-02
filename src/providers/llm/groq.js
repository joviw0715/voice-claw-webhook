import { streamQueryGroq } from '../../services/openClawLlm.js';

export function isAvailable() {
  return !!process.env.GROQ_API_KEY;
}

export async function* stream(messages) {
  yield* streamQueryGroq(messages);
}

export async function query(messages) {
  let result = '';
  for await (const tok of streamQueryGroq(messages)) result += tok;
  return result;
}
