import { ElevenLabsClient } from 'elevenlabs';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Validate Twilio recording URL (SSRF protection)
 */
function validateTwilioRecordingUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid recording URL: ${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Recording URL must use HTTPS');
  }

  if (!parsed.hostname.endsWith('.twilio.com')) {
    throw new Error(`Invalid Twilio domain: ${parsed.hostname}`);
  }

  // Reconstruct URL from validated parts (SSRF protection: HTTPS + .twilio.com allowlist)
  const safeUrl = `https://${parsed.hostname}${parsed.pathname}${parsed.search}`;
  return safeUrl;
}

/**
 * Transcribe audio using ElevenLabs Speech-to-Text API
 */
export async function transcribeAudio(recordingUrl) {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is not set');
  }

  const safeUrl = validateTwilioRecordingUrl(recordingUrl);
  const wavUrl = safeUrl.endsWith('.wav') ? safeUrl : `${safeUrl}.wav`;

  const tmpFile = path.join(os.tmpdir(), `twilio_${Date.now()}.wav`);

  const response = await axios.get(wavUrl, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });

  fs.writeFileSync(tmpFile, Buffer.from(response.data));

  try {
    const client = new ElevenLabsClient({ apiKey });

    const result = await client.speechToText.convert({
      audio: fs.createReadStream(tmpFile),
      model_id: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1',
    });

    return result.text || '';
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch (err) {
      console.error('Failed to delete temp file:', err);
    }
  }
}
