import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

export function isAvailable() {
  return (
    !!process.env.CTM_ASR_URL &&
    !!process.env.CTM_ASR_ACCESS_CODE &&
    process.env.USE_CTM_STT === 'true'
  );
}

export function createStream({ onInterim, onFinal, onError, onSessionEnd }) {
  const language = process.env.CTM_ASR_LANGUAGE || 'cantonese';
  const wsUrl = `${process.env.CTM_ASR_URL}?AccessCode=${process.env.CTM_ASR_ACCESS_CODE}`;

  // 100ms @ 16kHz mono 16-bit = 3200 bytes
  const FRAME_BYTES = 3200;
  let voiceId = randomUUID();
  let ws = null;
  let pcmBuffer = Buffer.alloc(0);
  let destroyed = false;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {});

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const text = msg.result?.voice_text_str || '';
        if (msg.code === '1' && text) onInterim?.(text);
        else if (msg.code === '0' && text) onFinal(text);
        else if (msg.code === '2') onSessionEnd?.('finished');
      } catch (err) {
        onError(err);
      }
    });

    ws.on('error', (err) => onError(err));

    ws.on('close', () => {
      if (!destroyed) {
        // Reconnect internally — do NOT call onSessionEnd or streamManager will create a duplicate stream
        voiceId = randomUUID();
        pcmBuffer = Buffer.alloc(0);
        setTimeout(() => { if (!destroyed) connect(); }, 500);
      }
    });
  }

  connect();

  function sendFrame(pcm16kBuf, flag) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Encode only the exact bytes of this buffer slice as base64 (Buffer IS Int8Array-compatible)
    const b64 = pcm16kBuf.toString('base64');
    ws.send(JSON.stringify({ voice_id: voiceId, pcm: b64, flag, language }));
  }

  function upsample8kTo16k(pcm8kBuf) {
    // Nearest-neighbour: duplicate each Int16 sample [a] → [a, a]
    const samples = pcm8kBuf.length / 2;
    const out = Buffer.allocUnsafe(samples * 4);
    for (let i = 0; i < samples; i++) {
      const sample = pcm8kBuf.readInt16LE(i * 2);
      out.writeInt16LE(sample, i * 4);
      out.writeInt16LE(sample, i * 4 + 2);
    }
    return out;
  }

  return {
    write(pcm8kBuf) {
      if (destroyed) return;
      pcmBuffer = Buffer.concat([pcmBuffer, upsample8kTo16k(pcm8kBuf)]);
      while (pcmBuffer.length >= FRAME_BYTES) {
        sendFrame(pcmBuffer.subarray(0, FRAME_BYTES), 'real_time');
        pcmBuffer = pcmBuffer.subarray(FRAME_BYTES);
      }
    },

    close() {
      destroyed = true;
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Flush remaining buffer as finished frame
        if (pcmBuffer.length > 0) {
          sendFrame(pcmBuffer, 'finished');
          pcmBuffer = Buffer.alloc(0);
        } else {
          ws.send(JSON.stringify({ voice_id: voiceId, pcm: '', flag: 'finished', language }));
        }
        setTimeout(() => ws?.close(), 100); // let the finished frame transmit before closing
      } else {
        ws?.close();
      }
    },
  };
}
export const __name = 'ctm';
