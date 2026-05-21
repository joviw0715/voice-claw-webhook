import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

// Creates a streaming STT session fed by raw μ-law-decoded PCM (8kHz 16-bit mono).
// Callbacks:
//   onInterim(text) — partial recognition (user is still speaking)
//   onFinal(text)   — final recognition (phrase complete)
//   onError(err)    — recognition error
export function createSttStream({ onInterim, onFinal, onError }) {
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY,
    process.env.AZURE_SPEECH_REGION,
  );
  speechConfig.speechRecognitionLanguage = process.env.AZURE_SPEECH_LANGUAGE || 'zh-HK';

  // Must match what mulaw.decode() produces: 8kHz, 16-bit, mono
  const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  recognizer.recognizing = (_s, e) => {
    if (e.result.text) onInterim?.(e.result.text);
  };

  recognizer.recognized = (_s, e) => {
    if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
      onFinal(e.result.text);
    }
  };

  recognizer.canceled = (_s, e) => {
    if (e.reason === sdk.CancellationReason.Error) {
      onError(new Error(`STT canceled: ${e.errorDetails}`));
    }
  };

  recognizer.startContinuousRecognitionAsync(
    () => {},
    (err) => onError(new Error(String(err))),
  );

  return {
    write(pcmBuffer) {
      // Azure SDK push-stream.write() expects an ArrayBuffer
      const ab = pcmBuffer.buffer.slice(
        pcmBuffer.byteOffset,
        pcmBuffer.byteOffset + pcmBuffer.byteLength,
      );
      pushStream.write(ab);
    },
    close() {
      recognizer.stopContinuousRecognitionAsync(
        () => recognizer.close(),
        () => recognizer.close(),
      );
      pushStream.close();
    },
  };
}
