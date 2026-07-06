import { synthesizeToStream as minimaxSynthesizeToStream } from '../../services/streamingTts.js';

export function isAvailable() {
  return !!process.env.MINIMAX_API_KEY;
}

export function synthesizeToStream(text, opts) {
  return minimaxSynthesizeToStream(text, opts);
}
export const __name = 'minimax';
