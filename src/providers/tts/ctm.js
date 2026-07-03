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

// Strip a WAV/RIFF header from the first chunk if present.
// CTM may return a WAV header before the PCM data stream.
function stripWavHeader(buf) {
  if (buf.length >= 44 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) { // 'RIFF'
    // Find 'data' sub-chunk to get exact header size
    for (let i = 12; i < buf.length - 8; i++) {
      if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61) { // 'data'
        return buf.slice(i + 8);
      }
    }
    return buf.slice(44); // fallback: standard 44-byte header
  }
  return buf;
}

export function synthesizeToStream(text, { onChunk, onDone, onError, voiceId }) {
  const ctrl = new AbortController();
  let cancelled = false;
  const inputRate = parseInt(process.env.CTM_TTS_SAMPLE_RATE || '16000', 10);

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

      let firstChunk = true;
      for await (let chunk of response.data) {
        if (cancelled) break;
        if (firstChunk) { chunk = stripWavHeader(chunk); firstChunk = false; }
        if (chunk.length > 0) onChunk(encodePcm16ToMulaw8k(chunk, inputRate));
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
