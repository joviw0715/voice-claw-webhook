import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUDIO_DIR = path.join(__dirname, '..', '..', 'audio');

export async function synthesizeSpeech(text) {
  const apiKey = process.env.MINIMAX_API_KEY;
  const voiceId = process.env.MINIMAX_VOICE_ID || 'Gentle_grace';
  const model = process.env.MINIMAX_MODEL || 'speech-02-turbo';
  const language = process.env.MINIMAX_LANGUAGE || 'Cantonese';

  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY is not set');
  }

  const payload = {
    model,
    text,
    stream: false,
    language_boost: language,
    voice_setting: {
      voice_id: voiceId,
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
    output_format: 'hex',
  };

  const response = await axios.post('https://api.minimax.io/v1/t2a_v2', payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  const baseResp = response.data?.base_resp;
  if (baseResp && baseResp.status_code !== 0) {
    throw new Error(`MiniMax TTS error ${baseResp.status_code}: ${baseResp.status_msg}`);
  }

  const audioHex = response.data?.data?.audio;
  if (!audioHex) {
    console.error('MiniMax unexpected response:', JSON.stringify(response.data, null, 2));
    throw new Error('MiniMax TTS returned no audio');
  }

  const audioBuffer = Buffer.from(audioHex, 'hex');

  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }

  const filename = `tts_${crypto.randomUUID()}.mp3`;
  const filePath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filePath, audioBuffer);

  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  return `${baseUrl}/audio/${filename}`;
}
