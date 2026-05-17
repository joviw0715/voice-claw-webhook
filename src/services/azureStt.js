'use strict';

const sdk = require('microsoft-cognitiveservices-speech-sdk');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Validates that `url` points to an HTTPS Twilio domain to guard against
 * server-side request forgery.  Returns the normalised URL string built from
 * the parsed object so that downstream code never uses the raw user input.
 *
 * @param {string} url
 * @returns {string}  Normalised URL (same location, sanitised representation)
 * @throws {Error} if the URL is not a safe Twilio recording URL
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
    throw new Error(`Recording URL hostname is not a Twilio domain: ${parsed.hostname}`);
  }
  // Return the href from the parsed object to avoid passing raw user input
  // further down the call chain (guards against SSRF via malformed input).
  return parsed.href;
}

/**
 * Downloads the audio from `recordingUrl` (adding .wav extension if needed),
 * then transcribes it using Azure Cognitive Services Speech-to-Text.
 *
 * @param {string} recordingUrl  Twilio recording URL
 * @returns {Promise<string>}    Transcribed text
 */
async function transcribeRecording(recordingUrl) {
  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION;

  if (!speechKey || !speechRegion) {
    throw new Error('AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is not set');
  }

  // Guard against SSRF: validate and normalise the URL so the raw user input
  // is never used for the downstream HTTP request.
  const safeRecordingUrl = validateTwilioRecordingUrl(recordingUrl);

  // Twilio recordings can be fetched as .wav by appending the extension
  const wavUrl = safeRecordingUrl.endsWith('.wav') ? safeRecordingUrl : `${safeRecordingUrl}.wav`;

  // Download audio to a temporary file
  const tmpFile = path.join(os.tmpdir(), `twilio_rec_${Date.now()}.wav`);
  const response = await axios.get(wavUrl, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });
  fs.writeFileSync(tmpFile, Buffer.from(response.data));

  try {
    const text = await _recognizeFromFile(speechKey, speechRegion, tmpFile);
    return text;
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

/**
 * Runs Azure Speech recognition on a local WAV file.
 *
 * @param {string} key
 * @param {string} region
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function _recognizeFromFile(key, region, filePath) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.speechRecognitionLanguage = 'zh-CN';

    const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(filePath));
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();
        if (result.reason === sdk.ResultReason.RecognizedSpeech) {
          resolve(result.text);
        } else if (result.reason === sdk.ResultReason.NoMatch) {
          resolve('');
        } else {
          reject(new Error(`Azure STT failed: ${result.errorDetails || result.reason}`));
        }
      },
      (err) => {
        recognizer.close();
        reject(err);
      }
    );
  });
}

module.exports = { transcribeRecording };
