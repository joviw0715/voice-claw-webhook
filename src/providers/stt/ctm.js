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
  let sendQueue = [];   // frames buffered while WS is CONNECTING
  let destroyed = false;

  function sendFrame(pcm16kBuf, flag) {
    const payload = JSON.stringify({
      voice_id: voiceId,
      pcm: pcm16kBuf.toString('base64'),
      flag,
      language,
    });
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      sendQueue.push(payload);
    }
  }

  function connect() {
    sendQueue = [];
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(`[ctm-stt] WebSocket OPEN — flushing ${sendQueue.length} queued frames`);
      for (const payload of sendQueue) ws.send(payload);
      sendQueue = [];
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const text = msg.result?.voice_text_str || '';
        const code = String(msg.code); // normalise — API may return number or string
        console.log(`[ctm-stt] message code=${code} text="${text.slice(0, 40)}"`);
        if (code === '1' && text) onInterim?.(text);
        else if (code === '0' && text) {
          console.log(`[ctm-stt] calling onFinal: "${text.slice(0, 40)}"`);
          onFinal(text);
        }
        else if (code === '2') onSessionEnd?.('finished');
        else if (!text) console.log(`[ctm-stt] empty text, code=${code} — full msg: ${data.toString().slice(0, 200)}`);
      } catch (err) {
        console.error('[ctm-stt] message parse error:', err.message, data.toString().slice(0, 200));
        onError(err);
      }
    });

    ws.on('error', (err) => {
      console.error('[ctm-stt] WebSocket error:', err.message);
      if (!destroyed) onError(err);
    });

    ws.on('close', (code, reason) => {
      if (!destroyed) {
        console.log(`[ctm-stt] WebSocket closed code=${code} — notifying streamManager to restart`);
        // Delegate reconnect to streamManager via onSessionEnd.
        // streamManager calls startListening(false) → prevStt.close() sets destroyed=true
        // on this stream, preventing any double-connect race.
        onSessionEnd?.(`ws-closed:${code}`);
      }
    });
  }

  connect();

  function upsample8kTo16k(pcm8kBuf) {
    const samples = pcm8kBuf.length / 2;
    const out = Buffer.allocUnsafe(samples * 4);
    for (let i = 0; i < samples; i++) {
      const sample = pcm8kBuf.readInt16LE(i * 2);
      out.writeInt16LE(sample, i * 4);
      out.writeInt16LE(sample, i * 4 + 2);
    }
    return out;
  }

  let _writeCount = 0;
  return {
    write(pcm8kBuf) {
      if (destroyed) return;
      _writeCount++;
      if (_writeCount === 1) console.log('[ctm-stt] first audio write received');
      pcmBuffer = Buffer.concat([pcmBuffer, upsample8kTo16k(pcm8kBuf)]);
      while (pcmBuffer.length >= FRAME_BYTES) {
        sendFrame(pcmBuffer.subarray(0, FRAME_BYTES), 'real_time');
        pcmBuffer = pcmBuffer.subarray(FRAME_BYTES);
      }
    },

    close() {
      destroyed = true; // prevents onSessionEnd from firing on close
      if (ws && ws.readyState === WebSocket.OPEN) {
        const fin = () => {
          if (pcmBuffer.length > 0) {
            sendFrame(pcmBuffer, 'finished');
            pcmBuffer = Buffer.alloc(0);
          } else {
            try { ws.send(JSON.stringify({ voice_id: voiceId, pcm: '', flag: 'finished', language })); } catch {}
          }
          setTimeout(() => { try { ws.close(); } catch {} }, 100);
        };
        fin();
      } else if (ws && ws.readyState === WebSocket.CONNECTING) {
        ws.once('open', () => {
          destroyed = true;
          try { ws.close(); } catch {}
        });
      } else {
        try { ws?.close(); } catch {}
      }
    },
  };
}
export const __name = 'ctm';
