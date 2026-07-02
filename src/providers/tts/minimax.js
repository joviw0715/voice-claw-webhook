import { synthesizeToStream as minimaxSynthesizeToStream } from '../../services/streamingTts.js';
import { synthesizeSpeech as minimaxSynthesizeSpeech } from '../../services/minimaxTts.js';

export function isAvailable() {
  return !!process.env.MINIMAX_API_KEY;
}

export function synthesizeToStream(text, opts) {
  return minimaxSynthesizeToStream(text, opts);
}

export async function synthesizeSpeech(text) {
  return minimaxSynthesizeSpeech(text);
}
