import { createSttStream } from '../../services/streamingStt.js';

export function isAvailable() {
  return !!process.env.AZURE_SPEECH_KEY;
}

export function createStream(opts) {
  return createSttStream(opts);
}
export const __name = 'azure';
