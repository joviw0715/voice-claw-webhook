import axios from 'axios';

// G.711 μ-law encoder: 16-bit signed PCM sample → 8-bit μ-law byte
function encodeMuLaw(s16) {
  const BIAS = 33;
  let sign = 0;
  if (s16 < 0) { s16 = -s16; sign = 0x80; }
  s16 += BIAS;
  if (s16 > 32767) s16 = 32767;
  let exp = 7;
  for (let mask = 0x4000; (s16 & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  return (~(sign | (exp << 4) | ((s16 >> (exp + 3)) & 0x0F))) & 0xFF;
}

// PCM16LE @16kHz → μ-law @8kHz via 2:1 decimation (take every other sample)
function pcm16ToMulaw8k(pcmBuf) {
  const outLen = Math.floor(pcmBuf.length / 4);
  const out = Buffer.allocUnsafe(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = encodeMuLaw(pcmBuf.readInt16LE(i * 4));
  }
  return out;
}

// Synthesizes text to a stream of μ-law 8kHz audio chunks (same format Twilio expects).
// Callbacks:
//   onChunk(buffer) — called repeatedly as audio arrives
//   onDone()        — synthesis complete
//   onError(err)    — synthesis failed
// Returns { cancel() } to abort mid-stream.
export function synthesizeToStream(text, { onChunk, onDone, onError }) {
  let cancelled = false;
  const ctrl = new AbortController();

  (async () => {
    try {
      const response = await axios.post(
        'https://api.minimax.io/v1/t2a_v2',
        {
          model: process.env.MINIMAX_MODEL || 'speech-02-turbo',
          text,
          stream: true,
          language_boost: process.env.MINIMAX_LANGUAGE_BOOST || 'Chinese,Yue',
          voice_setting: {
            voice_id: process.env.MINIMAX_VOICE_ID || 'Cantonese_GentleLady',
            speed: 1.0,
            vol: 1.0,
            pitch: 0,
          },
          audio_setting: {
            format: 'pcm',
            sample_rate: 16000,
            channel: 1,
          },
        },
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
          try {
            const json = JSON.parse(data);
            const baseResp = json.base_resp;
            if (baseResp && baseResp.status_code !== 0) {
              throw new Error(`MiniMax TTS error ${baseResp.status_code}: ${baseResp.status_msg}`);
            }
            const hexAudio = json.data?.audio;
            if (hexAudio && hexAudio.length > 0 && !cancelled) {
              onChunk(pcm16ToMulaw8k(Buffer.from(hexAudio, 'hex')));
            }
            if (json.data?.status === 2) {
              if (!cancelled) onDone();
              return;
            }
          } catch (parseErr) {
            if (!cancelled) onError(parseErr);
            return;
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
