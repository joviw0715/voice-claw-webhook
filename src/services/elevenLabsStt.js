import { ElevenLabsClient } from 'elevenlabs';
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

  // Wrap in a File so the SDK's fetch-based multipart upload works correctly
  const audioBuffer = Buffer.from(response.data);
  const audioFile = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' });

  const client = new ElevenLabsClient({ apiKey });

  try {
    const result = await client.speechToText.convert({
      file: audioFile,
      model_id: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1',
    });

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
