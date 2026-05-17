'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIO_DIR = path.join(__dirname, '..', '..', 'audio');

/**
 * Converts `text` to speech using the MiniMax TTS API and saves the resulting
 * audio to the `audio/` directory.
 *
 * @param {string} text  Text to synthesise
 * @returns {Promise<string>}  Public path segment (e.g. "/audio/<filename>.mp3")
 *                             that Twilio can play via <Play>.
 */
async function synthesize(text) {
  const apiUrl = process.env.MINIMAX_API_URL;
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  const voiceId = process.env.MINIMAX_VOICE_ID || 'male-qn-qingse';

  if (!apiUrl || !apiKey) {
    throw new Error('MINIMAX_API_URL or MINIMAX_API_KEY is not set');
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
  });

  // MiniMax returns audio as a hex-encoded string in `data.audio`
  const audioHex = response.data?.data?.audio;
  if (!audioHex) {
    throw new Error(`MiniMax TTS returned no audio: ${JSON.stringify(response.data)}`);
  }

  const audioBuffer = Buffer.from(audioHex, 'hex');

  // Ensure audio directory exists
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }

  const filename = `tts_${crypto.randomUUID()}.mp3`;
  const filePath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filePath, audioBuffer);

  return `/audio/${filename}`;
}

module.exports = { synthesize };
