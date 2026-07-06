export { createSttStream as createStream } from '../../services/streamingStt.js';

export function isAvailable() {
  return !!process.env.AZURE_SPEECH_KEY;
}

export const __name = 'azure';
