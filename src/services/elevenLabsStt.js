import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import axios from 'axios';

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

  // Reconstruct URL from validated parts
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

  // Download audio from Twilio with authentication
  const response = await axios.get(wavUrl, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });

  // Buffer is natively supported by the official SDK's multipart upload
  const audioBuffer = Buffer.from(response.data);

  const client = new ElevenLabsClient({ apiKey });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error('ElevenLabs STT request timed out after 120s'));
    }, 120000);

    let result;
    console.log("result:", result);
    try {
      result = await client.speechToText.convert(
        {
          file: audioBuffer,
          modelId: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1',
        },
        { abortSignal: controller.signal },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    return result.text || '';
  } catch (error) {
    // 详细错误处理
    console.error('ElevenLabs STT Error:', {
      status: error.status,
      message: error.message,
      body: error.body,
    });
    
    if (error.status === 401) {
      throw new Error('Invalid ElevenLabs API key');
    } else if (error.status === 413) {
      throw new Error('Audio file too large (max 25MB)');
    } else if (error.status === 415) {
      throw new Error('Unsupported audio format. Use WAV, MP3, FLAC, or OGG');
    } else {
      throw new Error(`Transcription failed: ${error.message}`);
    }
  }
}
