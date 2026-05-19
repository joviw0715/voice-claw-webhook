import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// ✅ Fix __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUDIO_DIR = path.join(__dirname, '..', '..', 'audio');

/**
 * ✅ Match server.js name
 */
export async function synthesizeSpeech(text) {
  const apiUrl = process.env.MINIMAX_API_URL;
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  const voiceId = process.env.MINIMAX_VOICE_ID || 'male-qn-qingse';

  if (!apiUrl || !apiKey) {
    throw new Error(`MiniMax config missing — MINIMAX_API_URL=${!!apiUrl} MINIMAX_API_KEY=${!!apiKey}`);
  }

  const payload = {
    text,
    model: 'speech-01',
    voice_id: voiceId,
    speed: 1.0,
    vol: 1.0,
    pitch: 0,
    audio_sample_rate: 32000,
    bitrate: 128000,
    format: 'mp3',
  };

  const url = groupId ? `${apiUrl}?GroupId=${groupId}` : apiUrl;

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    responseType: 'json',
    timeout: 15000,
  });

  console.log('MiniMax response status:', response.status);
  console.log('MiniMax response data:', JSON.stringify(response.data, null, 2));

  const audioHex = response.data?.data?.audio;
  if (!audioHex) {
    console.error('MiniMax TTS full response:', JSON.stringify(response.data, null, 2));
    throw new Error(`MiniMax TTS returned no audio`);
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
