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

// Maps the MiniMax voice IDs stored in the business console DB to CTM voice names.
// Each mapping is individually overridable via CTM_VOICE_<KEY> env vars so no
// code change is needed when CTM voice names change.
const VOICE_MAP = {
  Cantonese_GentleLady: process.env.CTM_VOICE_JAMIE   || process.env.CTM_TTS_VOICE || 'pakchi',
  Cantonese_BrightBoy:  process.env.CTM_VOICE_KENJI   || process.env.CTM_TTS_VOICE || 'pakchi',
  Cantonese_WarmLady:   process.env.CTM_VOICE_ANNA    || process.env.CTM_TTS_VOICE || 'pakchi',
  // moss_audio_* are MiniMax custom clone IDs — map to CTM equivalents if available
  'moss_audio_6b759cbc-5c17-11f1-af91-92eea1bed9bb': process.env.CTM_VOICE_MOSS      || process.env.CTM_TTS_VOICE || 'pakchi',
  'moss_audio_eb6bf7b8-5c1b-11f1-8f84-faf87dcc54b3': process.env.CTM_VOICE_TESTVOICE || process.env.CTM_TTS_VOICE || 'pakchi',
};

function resolveCtmVoice(voiceId) {
  if (!voiceId) return process.env.CTM_TTS_VOICE || 'pakchi';
  return VOICE_MAP[voiceId] ?? process.env.CTM_TTS_VOICE ?? 'pakchi';
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
  const inputRate = parseInt(process.env.CTM_TTS_SAMPLE_RATE || '16000', 10) || 16000;
  const ctmVoice = resolveCtmVoice(voiceId);

  (async () => {
    try {
      const url = `${process.env.CTM_TTS_URL.replace(/\/$/, '')}/v1/tts`;
      const response = await axios.post(
        url,
        {
          model: process.env.CTM_TTS_MODEL || 'ctm_tts',
          text,
          voice: ctmVoice,
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

export async function synthesizeSpeech(text, { voiceId } = {}) {
  if (!process.env.CTM_TTS_URL) throw new Error('CTM_TTS_URL not set');
  const ctmVoice = resolveCtmVoice(voiceId);
  const url = `${process.env.CTM_TTS_URL.replace(/\/$/, '')}/v1/tts`;
  const response = await axios.post(
    url,
    {
      model: process.env.CTM_TTS_MODEL || 'ctm_tts',
      text,
      voice: ctmVoice,
      stream: false,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 30000,
    },
  );

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const filename = `ctm_tts_${crypto.randomUUID()}.wav`;
  const filepath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(response.data));

  // Auto-delete after 5 minutes — enough time for Twilio to fetch and play the file
  setTimeout(() => fs.unlink(filepath, () => {}), 5 * 60 * 1000);

  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  return `${baseUrl}/audio/${filename}`;
}
export const __name = 'ctm';
