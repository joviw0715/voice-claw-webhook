import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { encodePcm16ToMulaw8k } from '../../utils/mulaw.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_DIR = path.join(__dirname, '..', '..', '..', 'audio');

export function isAvailable() {
  return !!process.env.CTM_TTS_URL && process.env.USE_CTM_TTS === 'true';
}

export function synthesizeToStream(text, { onChunk, onDone, onError, voiceId }) {
  const ctrl = new AbortController();
  let cancelled = false;

  (async () => {
    try {
      const url = `${process.env.CTM_TTS_URL.replace(/\/$/, '')}/v1/tts`;
      const response = await axios.post(
        url,
        {
          model: process.env.CTM_TTS_MODEL || 'ctm_tts',
          text,
          voice: process.env.CTM_TTS_VOICE || 'pakchi',
          stream: true,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'stream',
          timeout: 30000,
          signal: ctrl.signal,
        },
      );

      for await (const chunk of response.data) {
        if (cancelled) break;
        // CTM TTS streams raw PCM16 at 16kHz mono — encodePcm16ToMulaw8k handles 16kHz→8kHz decimation
        if (chunk.length > 0) onChunk(encodePcm16ToMulaw8k(chunk));
      }
      if (!cancelled) onDone();
    } catch (err) {
      if (!cancelled && !axios.isCancel(err)) onError(err);
    }
  })();

  return {
    cancel() {
      cancelled = true;
      ctrl.abort();
    },
  };
}

export async function synthesizeSpeech(text) {
  const url = `${process.env.CTM_TTS_URL.replace(/\/$/, '')}/v1/tts`;
  const response = await axios.post(
    url,
    {
      model: process.env.CTM_TTS_MODEL || 'ctm_tts',
      text,
      voice: process.env.CTM_TTS_VOICE || 'pakchi',
      stream: false,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 30000,
    },
  );

  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const filename = `ctm_tts_${crypto.randomUUID()}.wav`;
  const filepath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(response.data));

  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  return `${baseUrl}/audio/${filename}`;
}
export const __name = 'ctm';
