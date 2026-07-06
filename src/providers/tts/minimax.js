export { synthesizeToStream } from '../../services/streamingTts.js';

export function isAvailable() {
  return !!process.env.MINIMAX_API_KEY;
}

export const __name = 'minimax';
