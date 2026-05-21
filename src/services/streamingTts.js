import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

// Synthesizes text to a stream of μ-law 8kHz audio chunks (same format Twilio expects).
// Callbacks:
//   onChunk(buffer) — called repeatedly as audio is generated
//   onDone()        — synthesis complete
//   onError(err)    — synthesis failed
// Returns { cancel() } to abort mid-stream.
export function synthesizeToStream(text, { onChunk, onDone, onError }) {
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY,
    process.env.AZURE_SPEECH_REGION,
  );
  speechConfig.speechSynthesisVoiceName =
    process.env.AZURE_TTS_VOICE || 'zh-HK-HiuGaaiNeural';

  // Raw μ-law 8kHz output — Twilio accepts this directly, no conversion needed
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Raw8Khz8BitMonoMULaw;

  // null audio config = don't play locally, stream via synthesizing events
  const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);

  synthesizer.synthesizing = (_s, e) => {
    const data = e.result.audioData;
    if (data?.byteLength > 0) onChunk(Buffer.from(data));
  };

  synthesizer.speakTextAsync(
    text,
    (_result) => { synthesizer.close(); onDone(); },
    (err) => { synthesizer.close(); onError(new Error(String(err))); },
  );

  return {
    cancel() { synthesizer.close(); },
  };
}
