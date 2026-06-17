// FreeSWITCH audio stream handler for /stream-fs WebSocket endpoint.
// mod_audio_stream (amigniter fork) sends:
//   - First message: JSON metadata {"uuid":"...","direction":"..."}
//   - Subsequent messages: binary raw PCM16LE 8kHz audio frames
// Replies with binary raw PCM16LE frames for TTS playback.
// synthesizeToStream produces mulaw, so we decode mulaw→PCM before sending back.

import { decode as mulawDecode } from '../utils/mulaw.js';
import { createSttStream } from './streamingStt.js';
import { synthesizeToStream } from './streamingTts.js';
import { streamQueryGemini, streamQueryLLM } from './openClawLlm.js';
import { getContext, saveContext, getUserMemory } from './redisClient.js';

export function createFsCallHandler(ws, req, log) {
  const url = new URL(req.url, 'http://localhost');
  const direction    = url.searchParams.get('direction') || 'inbound';
  const voiceId      = url.searchParams.get('voiceId') || process.env.MINIMAX_VOICE_ID || 'Cantonese_GentleLady';
  const greetingText = url.searchParams.get('greetingText') || '';
  const systemPrompt = url.searchParams.get('systemPrompt') || '';
  const callerPhone  = url.searchParams.get('phone') || 'unknown';

  let callSid = `fs-${Date.now()}`;
  let phone   = callerPhone;
  let stt     = null;
  let state   = 'IDLE';
  let ttsLastChunkAt = 0;
  let cancelTts = null;
  let llmAborted = false;
  let firstUtterancePcm = [];

  function sendAudio(mulawBuffer) {
    if (ws.readyState !== ws.OPEN) return;
    ttsLastChunkAt = Date.now();
    // mod_audio_stream expects JSON: {"type":"streamAudio","data":{"audioData":"<base64-PCM16LE>","audioDataType":"raw","sampleRate":8000}}
    // synthesizeToStream produces mulaw, decode to PCM16LE first
    const pcm = mulawDecode(mulawBuffer);
    ws.send(JSON.stringify({
      type: 'streamAudio',
      data: {
        audioData: pcm.toString('base64'),
        audioDataType: 'raw',
        sampleRate: 8000,
      },
    }));
  }

  function interrupt(reason) {
    if (state === 'SPEAKING' || state === 'THINKING') {
      log(callSid, '🔇 INTERRUPT', reason);
      llmAborted = true;
      cancelTts?.();
      cancelTts = null;
      state = 'LISTENING';
    }
  }

  function startListening() {
    state = 'LISTENING';
    stt = createSttStream({
      onInterim(text) {
        if (Date.now() - ttsLastChunkAt < 1500) return;
        if ((state === 'SPEAKING' || state === 'THINKING') && text.length >= 2) {
          interrupt(`user interim: "${text.slice(0, 30)}"`);
        }
      },
      onFinal(text) {
        if (Date.now() - ttsLastChunkAt < 1500) {
          log(callSid, '🔇 ECHO SUPPRESSED', `"${text.slice(0, 30)}"`);
          return;
        }
        log(callSid, '👂 STT', `"${text}"`);
        if (state === 'LISTENING' && text.trim().length >= 2) {
          handleUserSpeech(text);
        }
      },
      onError(err) {
        log(callSid, '⚠ STT ERR', err.message);
        stt = null;
        startListening();
      },
    });
  }

  async function handleUserSpeech(text) {
    state = 'THINKING';
    llmAborted = false;
    log(callSid, '💭 THINKING', `"${text.slice(0, 60)}"`);

    const sysPrompt = systemPrompt || process.env.SYSTEM_PROMPT || '';
    let history = [];
    try { history = await getContext(callSid); } catch {}

    const messages = [
      { role: 'system', content: sysPrompt },
      ...history,
      { role: 'user', content: text },
    ];

    let reply = '';
    let ttsBuffer = '';
    state = 'SPEAKING';

    const geminiDirect = process.env.USE_GEMINI_DIRECT === 'true';
    const llmStream = geminiDirect ? streamQueryGemini(messages) : streamQueryLLM(messages, phone);

    try {
      for await (const token of llmStream) {
        if (llmAborted) break;
        reply += token;
        ttsBuffer += token;

        if (/[。？！\n]/.test(ttsBuffer)) {
          const chunk = ttsBuffer.trim();
          ttsBuffer = '';
          if (chunk) {
            await new Promise((resolve) => {
              synthesizeToStream(chunk, {
                voiceId,
                onChunk(buf) { sendAudio(buf); },
                onDone() { resolve(); },
                onError(err) { log(callSid, '⚠ TTS ERR', err.message); resolve(); },
              });
            });
          }
          if (llmAborted) break;
        }
      }

      if (ttsBuffer.trim() && !llmAborted) {
        await new Promise((resolve) => {
          synthesizeToStream(ttsBuffer.trim(), {
            voiceId,
            onChunk(buf) { sendAudio(buf); },
            onDone() { resolve(); },
            onError(err) { log(callSid, '⚠ TTS ERR', err.message); resolve(); },
          });
        });
      }
    } catch (err) {
      log(callSid, '⚠ LLM ERR', err.message);
    }

    if (!llmAborted && reply) {
      try {
        await saveContext(callSid, [
          ...history,
          { role: 'user', content: text },
          { role: 'assistant', content: reply },
        ]);
      } catch {}
    }

    if (!llmAborted) startListening();
  }

  function speakGreeting(text) {
    state = 'SPEAKING';
    log(callSid, '🔊 FS GREETING', `"${text}" voice=${voiceId}`);
    synthesizeToStream(text, {
      voiceId,
      onChunk(buf) { sendAudio(buf); },
      onDone() {
        saveContext(callSid, [{ role: 'assistant', content: text }]).catch(() => {});
        startListening();
      },
      onError(err) {
        log(callSid, '⚠ GREETING ERR', err.message);
        startListening();
      },
    });
  }

  // ── Start the session ────────────────────────────────────────────────────

  log(callSid, '🎙️ FS STREAM OPEN', `direction=${direction} voice=${voiceId}`);

  if (direction === 'inbound') {
    getUserMemory(phone).then(memory => {
      const name = memory?.name;
      const text = greetingText || (name
        ? `你好呀${name}，我係祖兒，你今日點呀？`
        : (process.env.FIRST_MESSAGE || '你好，我係祖兒，請問點稱呼你呀？'));
      speakGreeting(text);
    }).catch(() => {
      speakGreeting(greetingText || process.env.FIRST_MESSAGE || '你好，我係祖兒，請問點稱呼你呀？');
    });
  } else {
    const text = greetingText || process.env.FIRST_MESSAGE || '你好，請問係咪方便聽電話？';
    speakGreeting(text);
  }

  // ── Public interface ─────────────────────────────────────────────────────

  return {
    onMessage(data, isBinary) {
      if (!isBinary) {
        try {
          const meta = JSON.parse(data.toString());
          if (meta.uuid) {
            callSid = `fs-${meta.uuid}`;
            log(callSid, '📋 FS META', `uuid=${meta.uuid} dir=${meta.direction || direction}`);
          }
        } catch {}
        return;
      }

      if (stt && state !== 'IDLE') {
        // mod_audio_stream sends raw PCM16LE — pass directly to STT (no mulaw decode needed)
        stt.write(data);
        if (firstUtterancePcm !== null) {
          firstUtterancePcm.push(Buffer.from(data));
          let total = firstUtterancePcm.reduce((s, b) => s + b.length, 0);
          while (total > 48000 && firstUtterancePcm.length > 1) {
            total -= firstUtterancePcm.shift().length;
          }
        }
      }
    },

    onClose(code, reason) {
      log(callSid, '📵 FS CLOSE', `code=${code} reason=${reason}`);
      stt?.end?.();
      stt = null;
      cancelTts?.();
    },
  };
}
