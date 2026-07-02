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
  let pcmBuffer = Buffer.alloc(0);   // accumulator for incoming audio
  let sendQueue = [];                // frames queued while WS is still CONNECTING
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
      // Buffer while connecting — flushed in ws.on('open')
      sendQueue.push(payload);
    }
    // CLOSING / CLOSED: drop (reconnect will re-establish)
  }

  function connect() {
    sendQueue = [];
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(`[ctm-stt] WebSocket OPEN — flushing ${sendQueue.length} queued frames`);
      // Flush any frames that arrived while we were connecting
      for (const payload of sendQueue) {
        ws.send(payload);
      }
      sendQueue = [];
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const text = msg.result?.voice_text_str || '';
        console.log(`[ctm-stt] message code=${msg.code} text="${text.slice(0, 40)}"`);
        if (msg.code === '1' && text) onInterim?.(text);
        else if (msg.code === '0' && text) onFinal(text);
        else if (msg.code === '2') onSessionEnd?.('finished');
      } catch (err) {
        onError(err);
      }
    });

    ws.on('error', (err) => {
      console.error('[ctm-stt] WebSocket error:', err.message);
      onError(err);
    });

    ws.on('close', () => {
      if (!destroyed) {
        // Reconnect internally — do NOT call onSessionEnd or streamManager
        // will create a duplicate stream on top of this reconnect
        voiceId = randomUUID();
        pcmBuffer = Buffer.alloc(0);
        setTimeout(() => { if (!destroyed) connect(); }, 500);
      }
    });
  }

  connect();

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
      destroyed = true;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        const flush = () => {
          if (pcmBuffer.length > 0) {
            sendFrame(pcmBuffer, 'finished');
            pcmBuffer = Buffer.alloc(0);
          } else {
            ws.send(JSON.stringify({ voice_id: voiceId, pcm: '', flag: 'finished', language }));
          }
          setTimeout(() => ws?.close(), 100);
        };
        if (ws.readyState === WebSocket.OPEN) {
          flush();
        } else {
          // Still connecting — wait for open then flush
          ws.once('open', flush);
        }
      } else {
        ws?.close();
      }
    },
  };
}
export const __name = 'ctm';
