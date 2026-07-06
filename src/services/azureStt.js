import sdk from 'microsoft-cognitiveservices-speech-sdk';
import axios from 'axios';
import httpsAgent from '../utils/httpAgent.js';

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

  return parsed.href;
}

/**
 * ✅ MATCH server.js NAME
 */
export async function transcribeAudio(recordingUrl) {
  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION;

  if (!speechKey || !speechRegion) {
    throw new Error('AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is not set');
  }

  const safeUrl = validateTwilioRecordingUrl(recordingUrl);
  const wavUrl = safeUrl.endsWith('.wav') ? safeUrl : `${safeUrl}.wav`;

  const response = await axios.get(wavUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
    httpsAgent,
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });

  return recognizeFromBuffer(speechKey, speechRegion, Buffer.from(response.data));
}

/**
 * Azure STT
 */
function recognizeFromBuffer(key, region, wavBuffer) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.speechRecognitionLanguage = process.env.AZURE_SPEECH_LANGUAGE || 'zh-HK';

    const audioConfig = sdk.AudioConfig.fromWavFileInput(wavBuffer);

    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();

        if (result.reason === sdk.ResultReason.RecognizedSpeech) {
          resolve(result.text);
        } else if (result.reason === sdk.ResultReason.NoMatch) {
          resolve('');
        } else {
          reject(new Error(`Azure STT failed`));
        }
      },
      (err) => {
        recognizer.close();
        reject(err);
      }
    );
  });
}
