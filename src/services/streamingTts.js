import axios from 'axios';
import { encodePcm16ToMulaw8k } from '../utils/mulaw.js';
import { mixAmbient } from '../utils/ambientMixer.js';

// Synthesizes text to a stream of μ-law 8kHz audio chunks (same format Twilio expects).
// Callbacks:
//   onChunk(buffer) — called repeatedly as audio arrives
//   onDone()        — synthesis complete
//   onError(err)    — synthesis failed
// Returns { cancel() } to abort mid-stream.
export function synthesizeToStream(text, { onChunk, onDone, onError, voiceId }) {
  let cancelled = false;
  const ctrl = new AbortController();

  (async () => {
    try {
      const backgroundSound = process.env.MINIMAX_BACKGROUND_SOUND;
      const body = {
        model: process.env.MINIMAX_MODEL || 'speech-02-turbo',
        text,
        stream: true,
        language_boost: process.env.MINIMAX_LANGUAGE_BOOST || 'Chinese,Yue',
        voice_setting: {
          voice_id: voiceId || process.env.MINIMAX_VOICE_ID || 'Cantonese_GentleLady',
          speed: 1.0,
          vol: 1.0,
          pitch: 0,
        },
        audio_setting: {
          format: 'pcm',
          sample_rate: 16000,
          channel: 1,
        },
      };
      if (backgroundSound) {
        body.background_setting = {
          background_audio: backgroundSound,
          volume: parseFloat(process.env.MINIMAX_BACKGROUND_VOLUME || '0.15'),
        };
      }
      const response = await axios.post(
        'https://api.minimax.io/v1/t2a_v2',
        body,
        {
          headers: {
            Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
          timeout: 30000,
          signal: ctrl.signal,
        },
      );

      let buf = '';
      for await (const chunk of response.data) {
        if (cancelled) break;
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          let json;
          try {
            json = JSON.parse(data);
          } catch { /* non-JSON SSE line (e.g. keep-alive or [DONE]) — skip */ continue; }

          const baseResp = json.base_resp;
          if (baseResp && baseResp.status_code !== 0) {
            if (!cancelled) onError(new Error(`MiniMax TTS error ${baseResp.status_code}: ${baseResp.status_msg}`));
            return;
          }
          // Check status BEFORE audio: the status=2 "done" event mirrors the
          // non-streaming response format and may contain the full audio again.
          // Skip its audio to avoid playing the whole thing twice.
          if (json.data?.status === 2) {
            if (!cancelled) onDone();
            return;
          }
          const hexAudio = json.data?.audio;
          if (hexAudio && hexAudio.length > 0 && !cancelled) {
            const pcm = mixAmbient(Buffer.from(hexAudio, 'hex'));
            onChunk(encodePcm16ToMulaw8k(pcm));
          }
        }
      }
      if (!cancelled) onDone();
    } catch (err) {
      if (!cancelled && !axios.isCancel(err)) onError(err);
    }
  })();

  return {
    cancel() {
      cancelled = true;
      ctrl.abort();
    },
  };
}
